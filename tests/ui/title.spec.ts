import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime } from './helpers'

// A title suggested from the code: Rephrase title queues a title run, the title-writer suggests,
// and the owner accepts, edits or discards. The fake title-writer picks its script by the task's
// title (see global-setup.ts).
const RUN = { timeout: 30_000 }
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })
const FIRST = 'Back off failed webhook deliveries'
const SECOND = 'Retry webhook deliveries with growing delays'
// The fake title-writer picks its script by the task's title, so an edit keeps the fragment.
const EDITED = 'Suggest twice: retry webhook deliveries with growing delays'

async function newTask(request: APIRequestContext, title: string, state?: 'ready') {
  await registerProject(request, draft())
  const response = await request.post(appUrl('/api/projects/DFT/tasks'), { data: { title } })
  const task = (await response.json()) as { id: string; key: string }
  if (state === 'ready') {
    const spec = (await (
      await request.post(appUrl(`/api/tasks/${task.id}/specs`), {
        data: {
          body_md:
            '## Requirements\n1. R1 – x\n\n## Acceptance criteria\n- AC1 (R1): Given a Then b\n',
        },
      })
    ).json()) as { id: string }
    // Approving starts a run; the card is no longer Backlog, which is all this journey needs.
    await request.post(appUrl(`/api/specs/${spec.id}/approve`))
  }
  return task
}

// The dialog is named by the task's title, which these journeys change: only one is ever open.
async function openCard(page: Page, key: string) {
  await page.goto(appUrl('/p/DFT'))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click(RUN)
  const card = page.getByRole('dialog')
  return { card, spec: card.getByRole('tabpanel', { name: 'Spec' }) }
}

test('a suggested title is accepted by keyboard, with the owner’s text kept until then', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Suggest one: webhooks')
  const { card, spec } = await openCard(page, key)
  const title = spec.getByRole('textbox', { name: 'Title', exact: true })
  await expect(title).toHaveValue('Suggest one: webhooks')
  await expect(spec.getByRole('button', { name: 'Save title' })).toBeVisible()

  const rephrase = spec.getByRole('button', { name: 'Rephrase title' })
  await rephrase.focus()
  await page.keyboard.press('Enter')
  await expect(spec.getByText('Suggesting a title…')).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Stop' })).toBeFocused()
  await expect(card.getByRole('status').filter({ hasText: 'Suggesting a title.' })).toBeVisible()

  // The suggestion arrives beside the owner's text, with its reason as the field's hint.
  const suggested = spec.getByRole('textbox', { name: 'Suggested title' })
  await expect(suggested).toHaveValue(FIRST, RUN)
  await expect(suggested).toHaveAccessibleDescription('Names the delivery retry in src/retry.ts')
  await expect(title).toHaveValue('Suggest one: webhooks')
  await expect(
    card.getByRole('status').filter({ hasText: `A title is suggested: ${FIRST}.` }),
  ).toBeVisible()
  await expectAccessible(page)

  await spec.getByRole('button', { name: 'Accept title' }).focus()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('status').filter({ hasText: 'Title saved.' })).toBeVisible()
  await expect(title).toBeFocused()
  await expect(title).toHaveValue(FIRST)
  await expect(spec.getByRole('textbox', { name: 'Suggested title' })).toHaveCount(0)
  await expect(spec.getByRole('button', { name: 'Rephrase title' })).toBeVisible()
})

test('a suggestion is edited before it is accepted, and a discard leaves the title alone', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Suggest twice: webhooks')
  const { card, spec } = await openCard(page, key)
  const title = spec.getByRole('textbox', { name: 'Title', exact: true })

  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  const suggested = spec.getByRole('textbox', { name: 'Suggested title' })
  await expect(suggested).toHaveValue(FIRST, RUN)

  // A second request replaces the first suggestion, which is never applied.
  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  await expect(suggested).toHaveValue(SECOND, RUN)
  await suggested.fill(EDITED)
  await spec.getByRole('button', { name: 'Accept title' }).click()
  await expect(title).toHaveValue(EDITED)
  await expect(card.getByRole('status').filter({ hasText: 'Title saved.' })).toBeVisible()

  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  await expect(suggested).toBeVisible(RUN)
  await spec.getByRole('button', { name: 'Discard' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Suggestion discarded.' })).toBeVisible()
  await expect(title).toBeFocused()
  await expect(title).toHaveValue(EDITED)
})

test('a title typed and not saved is saved before the run starts', async ({ page, request }) => {
  const created = await newTask(request, 'Suggest one: first words')
  const { spec } = await openCard(page, created.key)
  const title = spec.getByRole('textbox', { name: 'Title', exact: true })
  await title.fill('Suggest one: typed words')
  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  await expect(spec.getByRole('textbox', { name: 'Suggested title' })).toHaveValue(FIRST, RUN)
  const task = (await (await request.get(appUrl(`/api/tasks/${created.id}`))).json()) as {
    title: string
  }
  expect(task.title).toBe('Suggest one: typed words')
})

test('Stop gives the card back its Rephrase title, with the working panel accessible', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Suggest slowly: webhooks')
  const { card, spec } = await openCard(page, key)
  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  await expect(spec.getByText('Suggesting a title…')).toBeVisible()
  await expectAccessible(page)
  await spec.getByRole('button', { name: 'Stop' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Suggestion stopped.' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Rephrase title' })).toBeFocused()
  await expect(spec.getByText('Suggesting a title…')).toHaveCount(0)
})

test('a run that suggests nothing says so, and Rephrase title is offered again', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Suggest nothing: webhooks')
  const { card, spec } = await openCard(page, key)
  await spec.getByRole('button', { name: 'Rephrase title' }).click()
  await expect(
    spec.getByRole('paragraph').filter({
      hasText: 'The title suggestion did not finish: the title agent suggested no title.',
    }),
  ).toBeVisible(RUN)
  await expect(
    card.getByRole('status').filter({
      hasText: 'The title suggestion did not finish: the title agent suggested no title.',
    }),
  ).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Rephrase title' })).toBeVisible()
  await expectAccessible(page)
})

test('an empty title is marked, focused, and sends no request', async ({ page, request }) => {
  const { key } = await newTask(request, 'Suggest one: empty')
  const { spec } = await openCard(page, key)
  const title = spec.getByRole('textbox', { name: 'Title', exact: true })
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') sent.push(r.url())
  })
  for (const name of ['Save title', 'Rephrase title']) {
    await title.fill('')
    await spec.getByRole('button', { name }).click()
    await expect(spec.getByText('Enter a title.')).toBeVisible()
    await expect(title).toHaveAttribute('aria-invalid', 'true')
    await expect(title).toBeFocused()
  }
  expect(sent).toEqual([])
})

test('the title is read-only, with no buttons, once the card has left Backlog and Spec review', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Suggest one: running', 'ready')
  const { spec } = await openCard(page, key)
  await expect(spec.getByRole('textbox', { name: 'Title', exact: true })).toHaveAttribute(
    'readonly',
    '',
  )
  await expect(spec.getByRole('button', { name: 'Save title' })).toHaveCount(0)
  await expect(spec.getByRole('button', { name: 'Rephrase title' })).toHaveCount(0)
})
