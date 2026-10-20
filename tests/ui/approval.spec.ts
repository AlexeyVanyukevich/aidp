import { expect, test } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, focusedText, runtime, tabTo } from './helpers'

// A run takes a few seconds with the fake claude: the planner, the builder, the tests, Verify.
const RUN = { timeout: 30_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

test('a run that asks is answered on its card, and goes on to a pull request', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Ask about colours')
  await page.goto(appUrl('/p/ASK'))
  const waiting = page.getByRole('region', { name: 'Needs approval' })
  const link = waiting.getByRole('link', { name: new RegExp(`^${key} `) })
  await expect(link).toBeVisible(RUN)
  await expect(link).toContainText('Question waiting')
  await expect(page.getByRole('banner')).toContainText('1 question waiting')
  await expectAccessible(page)

  await link.click()
  const card = page.getByRole('dialog', { name: 'Ask about colours' })
  // A card waiting on a question opens on it.
  await expect(card.getByRole('tab', { name: 'Approvals' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })
  await expect(panel.getByRole('heading', { level: 3, name: 'Open question' })).toBeVisible()
  const options = panel.getByRole('group', { name: 'Which colour should the retry banner be?' })
  const blue = options.getByRole('button', { name: 'blue (recommended)' })
  await expect(blue).toHaveAccessibleDescription('Matches the logo')
  await expectAccessible(page)

  await blue.click()
  await expect(
    card.getByRole('status').filter({ hasText: `${key} answered. The run continues.` }),
  ).toBeVisible()
  await expect(card.getByText(`${key} · Review`)).toBeVisible(RUN)
  const answered = panel.getByRole('list').filter({ hasText: 'Which colour' })
  await expect(answered).toContainText('blue')
  await expectAccessible(page)
})

test('a plan the planner is not sure of waits for approval, and builds once approved', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Stop after the plan')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click({ timeout: RUN.timeout })
  const card = page.getByRole('dialog', { name: 'Stop after the plan' })
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })
  const changes = panel.getByRole('textbox', { name: 'Changes to ask for' })
  await expect(changes).toBeVisible()

  // Sent empty, the answer is refused where it was written, in words.
  await panel.getByRole('button', { name: 'Send answer' }).click()
  await expect(changes).toBeFocused()
  await expect(changes).toHaveAttribute('aria-invalid', 'true')
  await expect(changes).toHaveAccessibleDescription(/Write an answer, or choose one of the options/)
  await expectAccessible(page)

  await panel.getByRole('button', { name: 'Approve plan' }).click()
  await expect(card.getByText(`${key} · Review`)).toBeVisible(RUN)
})

test('a run blocked by a refused push says why, and finishes on Resume', async ({
  page,
  request,
}) => {
  const key = await approvedTask(
    request,
    { key: 'FLK', name: 'Flaky', path: runtime().flakyPath, repo: 'owner/flaky' },
    'Push fails once',
  )
  await page.goto(appUrl('/p/FLK'))
  const blocked = page.getByRole('region', { name: 'Blocked' })
  await blocked.getByRole('link', { name: new RegExp(`^${key} `) }).click({ timeout: RUN.timeout })
  const card = page.getByRole('dialog', { name: 'Push fails once' })
  await expect(card).toContainText('This step failed: git')
  await expect(card.getByText('Command output')).toBeVisible()
  await expectAccessible(page)

  await card.getByRole('button', { name: 'Resume' }).click()
  await expect(card.getByRole('status').filter({ hasText: `${key} resumed.` })).toBeVisible()
  await expect(card.getByText(`${key} · Review`)).toBeVisible(RUN)
})

test('a question is answered from the keyboard alone, focus landing where it should', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Ask about sizes')
  await page.goto(appUrl('/p/ASK'))
  const link = page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
  await expect(link).toBeVisible(RUN)
  await tabTo(page, link)
  await page.keyboard.press('Enter')
  const card = page.getByRole('dialog', { name: 'Ask about sizes' })
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })

  // The panel's order (spec §11): the options in turn, the field, Send answer.
  const small = panel.getByRole('button', { name: 'small' })
  const large = panel.getByRole('button', { name: 'large (recommended)' })
  await tabTo(page, small)
  await page.keyboard.press('Tab')
  await expect(large).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('textbox', { name: 'Your answer' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Send answer' })).toBeFocused()

  // Answering removes the controls that did it: focus goes to the state line first.
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(large).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => focusedText(page)).toMatch(new RegExp(`^${key} · `))
  await expect(
    card.getByRole('status').filter({ hasText: `${key} answered. The run continues.` }),
  ).toBeVisible()
  await expectAccessible(page)
})
