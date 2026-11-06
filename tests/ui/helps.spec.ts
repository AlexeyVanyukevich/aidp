import { expect, test, type Page } from '@playwright/test'
import {
  appUrl,
  approvedTask,
  expectAccessible,
  focusedText,
  registerProject,
  runtime,
  tabTo,
} from './helpers'

// A waiting question can be helped: a suggestion or a plain explanation, asked of a read-only
// helper that writes nothing and sends nothing. The fake helper's scripts are in global setup.
const RUN = { timeout: 30_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })

async function openWaiting(page: Page, key: string, project: string, title: string) {
  await page.goto(appUrl(`/p/${project}`))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  return { card, panel: card.getByRole('tabpanel', { name: 'Approvals' }) }
}

test('a single question is suggested for, explained, and answered with the suggestion edited', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Help with colours')
  const { card, panel } = await openWaiting(page, key, 'ASK', 'Help with colours')
  const status = card.getByRole('status')

  // Two buttons, once.
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).toHaveCount(1)
  await expect(panel.getByRole('button', { name: 'Explain simply' })).toHaveCount(1)

  // A keyboard-only press: Suggest, wait for its result, Use this answer.
  await tabTo(page, panel.getByRole('button', { name: 'Suggest an answer' }))
  await page.keyboard.press('Enter')
  await expect(
    status.filter({ hasText: 'Suggested answer ready for the open question' }),
  ).toBeVisible(RUN)
  const suggested = panel.getByRole('region', { name: 'Suggested answer' })
  await expect(suggested).toContainText('blue')
  await expect(suggested).toContainText('Matches the logo.')
  await expect(suggested).toContainText('Whether print differs.')

  await panel.getByRole('button', { name: 'Explain simply' }).click()
  await expect(status.filter({ hasText: 'Explanation ready for the open question' })).toBeVisible(
    RUN,
  )
  await expect(panel.getByRole('region', { name: 'In plain words' })).toBeVisible()
  await expect(suggested).toBeVisible()
  await expectAccessible(page)

  // Nothing was sent: the question is still open. A reload keeps both results.
  await page.reload()
  await card.getByRole('tab', { name: 'Approvals' }).click()
  await expect(panel.getByRole('region', { name: 'Suggested answer' })).toBeVisible()
  await expect(panel.getByRole('region', { name: 'In plain words' })).toBeVisible()

  // Asked again, the new suggestion replaces the old.
  await panel.getByRole('button', { name: 'Suggest an answer' }).click()
  await expect(panel.getByRole('region', { name: 'Suggested answer' })).toContainText(
    'Second opinion.',
    RUN,
  )

  await panel.getByRole('button', { name: 'Use this answer' }).click()
  const words = panel.getByRole('textbox', { name: 'Your answer' })
  await expect(panel.getByRole('radio', { name: 'blue (recommended)' })).toBeChecked()
  await expect(words).toHaveValue('Go with blue, but check print.')
  await expect(panel.getByRole('heading', { level: 3, name: 'Open question' })).toBeVisible()

  // The owner changes both before sending.
  await panel.getByRole('radio', { name: 'red' }).check()
  await words.fill('Red after all.')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  await expect(card.getByRole('status').filter({ hasText: `${key} answered.` })).toBeVisible()
  const answered = panel.getByRole('list').filter({ hasText: 'Which colour' })
  await expect(answered).toContainText('red')
  await expect(answered).toContainText('Red after all.')
})

test('a failed help says why, and can be asked again', async ({ page, request }) => {
  const key = await approvedTask(request, ask(), 'Help that fails')
  const { card, panel } = await openWaiting(page, key, 'ASK', 'Help that fails')
  await panel.getByRole('button', { name: 'Suggest an answer' }).click()
  await expect(panel.getByText(/^No suggestion: /)).toBeVisible(RUN)
  await expect(
    card.getByRole('status').filter({ hasText: 'No suggestion for the open question' }),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).not.toHaveAttribute(
    'aria-busy',
    'true',
  )
})

test('a batch is helped question by question, and Use this answer touches only its own', async ({
  page,
  request,
}) => {
  await registerProject(request, draft())
  const created = (await (
    await request.post(appUrl('/api/projects/DFT/tasks'), {
      data: { title: 'Help with a batch', description_md: 'Retry failed deliveries.' },
    })
  ).json()) as { id: string; key: string }
  await request.post(appUrl(`/api/tasks/${created.id}/actions/draft-spec`))
  const { card, panel } = await openWaiting(page, created.key, 'DFT', 'Help with a batch')
  const status = card.getByRole('status')

  const second = panel.getByRole('region', { name: 'Question 2 of 2' })
  const first = panel.getByRole('region', { name: 'Question 1 of 2' })
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).toHaveCount(2)

  await second.getByRole('button', { name: 'Suggest an answer' }).click()
  await expect(
    status.filter({ hasText: 'Suggested answer ready for question 2 of 2' }),
  ).toBeVisible(RUN)
  await first.getByRole('button', { name: 'Suggest an answer' }).click()
  await expect(
    status.filter({ hasText: 'Suggested answer ready for question 1 of 2' }),
  ).toBeVisible(RUN)
  await expectAccessible(page)

  await first.getByRole('button', { name: 'Use this answer' }).click()
  await expect(first.getByRole('radio', { name: 'Five' })).toBeChecked()
  await expect(first.getByRole('textbox', { name: 'Your answer to question 1' })).toHaveValue(
    'Five, to be safe.',
  )
  await expect(second.getByRole('textbox', { name: 'Your answer to question 2' })).toHaveValue('')

  // Reopening the card keeps what the helper produced.
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: new RegExp(`^${created.key} `) }).click()
  await expect(
    card
      .getByRole('tabpanel', { name: 'Approvals' })
      .getByRole('region', { name: 'Suggested answer' }),
  ).toHaveCount(2)
  expect(await focusedText(page)).toBeDefined()
})
