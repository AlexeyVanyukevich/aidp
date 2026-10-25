import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  appUrl,
  expectAccessible,
  focusedText,
  registerProject,
  runtime,
  SPEC,
  tabTo,
} from './helpers'

// Slice 3: a spec drafted from the task's description, its questions answered in one go,
// redrafted with a note (spec §11). The fake spec-writer replays Opus's recordings.
const RUN = { timeout: 30_000 }
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })
const DESCRIPTION = 'Failed webhook deliveries should be retried with a growing delay.'

async function newTask(
  request: APIRequestContext,
  title: string,
  description?: string,
): Promise<{ id: string; key: string }> {
  await registerProject(request, draft())
  const response = await request.post(appUrl('/api/projects/DFT/tasks'), {
    data: { title, ...(description === undefined ? {} : { description_md: description }) },
  })
  return (await response.json()) as { id: string; key: string }
}

async function openCard(page: Page, key: string, title: string) {
  await page.goto(appUrl('/p/DFT'))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click(RUN)
  return page.getByRole('dialog', { name: title })
}

test('a task drafted from its description, its questions answered, approved and carried to a pull request', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Draft a retry spec')
  const card = await openCard(page, key, 'Draft a retry spec')
  const spec = card.getByRole('tabpanel', { name: 'Spec' })

  await spec.getByRole('textbox', { name: 'Description' }).fill(DESCRIPTION)
  await spec.getByRole('button', { name: 'Save description' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Description saved.' })).toBeVisible()
  await expectAccessible(page)

  await spec.getByRole('button', { name: 'Draft spec' }).click()
  await expect(card.getByText(`${key} · Spec draft`)).toBeVisible()
  await expectAccessible(page)

  // The spec-writer asks its batch; the card waits on it.
  await expect(card.getByText(`${key} · Needs approval`)).toBeVisible(RUN)
  await expect(
    card.getByRole('status').filter({ hasText: `${key} has a question waiting in Approvals.` }),
  ).toBeVisible()
  await expect(page.getByRole('banner')).toContainText('2 questions waiting')
  await card.getByRole('tab', { name: 'Approvals' }).click()
  const approvals = card.getByRole('tabpanel', { name: 'Approvals' })
  await expect(approvals.getByRole('heading', { level: 3, name: 'Open questions' })).toBeVisible()
  const retries = approvals.getByRole('radiogroup', { name: 'How many retries?' })
  await expect(retries.getByRole('radio', { name: 'Five' })).toHaveAccessibleDescription(
    'Slower, but surer',
  )
  await expectAccessible(page)

  // Sent with nothing answered: each question is marked, and focus goes to the first.
  await approvals.getByRole('button', { name: 'Send answers' }).click()
  await expect(retries).toHaveAttribute('aria-invalid', 'true')
  await expect(retries.getByRole('radio', { name: 'Three (recommended)' })).toBeFocused()
  const second = approvals.getByRole('textbox', { name: 'Your answer to question 2' })
  await expect(second).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page)

  await retries.getByRole('radio', { name: 'Three (recommended)' }).check()
  await second.fill('Only 5xx answers.')
  await approvals.getByRole('button', { name: 'Send answers' }).click()
  await expect(
    card.getByRole('status').filter({ hasText: `${key} answered. The run continues.` }),
  ).toBeVisible()
  await expect(card.getByText(`${key} · Spec review`)).toBeVisible(RUN)
  await expect(card.getByRole('status').filter({ hasText: 'v1 is ready to review.' })).toBeVisible()
  // The batch's answers are a list inside the answered list: the inner one, last in order.
  await expect(
    approvals.getByRole('list').filter({ hasText: 'How many retries?' }).last(),
  ).toContainText('How many retries? Three')
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'Spec' }).click()
  await spec.getByRole('button', { name: 'Approve' }).click()
  await expect(card.getByText(`${key} · Review`)).toBeVisible(RUN)
  await expectAccessible(page)
})

test('Draft spec without a description, and Redraft without a note, say what is missing where it is', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Nothing to draft from')
  const card = await openCard(page, key, 'Nothing to draft from')
  const spec = card.getByRole('tabpanel', { name: 'Spec' })
  await spec.getByRole('button', { name: 'Draft spec' }).click()
  const description = spec.getByRole('textbox', { name: 'Description' })
  await expect(description).toBeFocused()
  await expect(description).toHaveAttribute('aria-invalid', 'true')
  await expect(description).toHaveAccessibleDescription(
    /Write a description first; the spec-writer drafts from it\./,
  )
  await expect(card.getByText(`${key} · Backlog`)).toBeVisible()
  await expectAccessible(page)
})

test('a spec redrafted with a note comes back as the next version', async ({ page, request }) => {
  const created = await newTask(request, 'Redraft a spec', DESCRIPTION)
  await request.post(appUrl(`/api/tasks/${created.id}/specs`), { data: { body_md: SPEC } })
  const card = await openCard(page, created.key, 'Redraft a spec')
  const spec = card.getByRole('tabpanel', { name: 'Spec' })

  // Sent empty, the note is refused where it was written.
  await spec.getByRole('button', { name: 'Redraft' }).click()
  const note = spec.getByRole('textbox', { name: 'What to change' })
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expectAccessible(page)

  await note.fill('Say how long to wait between tries.')
  await spec.getByRole('button', { name: 'Redraft' }).click()
  await expect(card.getByText(`${created.key} · Spec review`)).toBeVisible(RUN)
  await expect(spec.getByRole('combobox', { name: 'Version' })).toContainText('v2 · draft')
  await expectAccessible(page)
})

test('a batch is answered from the keyboard alone, focus landing where it should', async ({
  page,
  request,
}) => {
  const created = await newTask(request, 'Answer by keyboard', DESCRIPTION)
  await request.post(appUrl(`/api/tasks/${created.id}/actions/draft-spec`))
  await page.goto(appUrl('/p/DFT'))
  const link = page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${created.key} `) })
  await expect(link).toBeVisible(RUN)
  await tabTo(page, link)
  await page.keyboard.press('Enter')
  const card = page.getByRole('dialog', { name: 'Answer by keyboard' })
  const approvals = card.getByRole('tabpanel', { name: 'Approvals' })

  // The group is one stop: Tab enters at its first radio, Space chooses it.
  const three = approvals.getByRole('radio', { name: 'Three (recommended)' })
  await tabTo(page, three)
  await page.keyboard.press('ArrowDown')
  await expect(approvals.getByRole('radio', { name: 'Five' })).toBeFocused()
  await expect(approvals.getByRole('radio', { name: 'Five' })).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(approvals.getByRole('textbox', { name: 'Your answer to question 1' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(approvals.getByRole('textbox', { name: 'Your answer to question 2' })).toBeFocused()
  await page.keyboard.type('Only 5xx answers.')
  await page.keyboard.press('Tab')
  await expect(approvals.getByRole('button', { name: 'Send answers' })).toBeFocused()
  await page.keyboard.press('Enter')

  // Answering removes the form: focus waits on the card's state line.
  await expect.poll(() => focusedText(page)).toMatch(new RegExp(`^${created.key} · `))
  await expect(card.getByText(`${created.key} · Spec review`)).toBeVisible(RUN)
  await expectAccessible(page)
})
