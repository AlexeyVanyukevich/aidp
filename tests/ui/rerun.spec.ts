import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, focusedText, runtime, tabTo } from './helpers'

// A run takes a few seconds with the fake claude; three failed attempts take longer.
const RUN = { timeout: 90_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

test('a Failed card with an accepted plan offers to keep it, or to plan again', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Fail after a confident plan')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Failed' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: 'Fail after a confident plan' })
  const keep = card.getByRole('button', { name: 'Re-run with this plan' })
  const again = card.getByRole('button', { name: 'Re-run and plan again' })
  await expect(keep).toBeVisible()
  await expect(again).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run', exact: true })).toHaveCount(0)
  await expectAccessible(page)

  // Both are reachable by keyboard, in order.
  await tabTo(page, keep)
  await page.keyboard.press('Tab')
  await expect(again).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(keep).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: `${key} re-run with the plan` }),
  ).toBeVisible()
  expect(await focusedText(page)).toContain(key)
})

test('a Failed card with no plan to keep offers only planning again', async ({ page, request }) => {
  const key = await approvedTask(request, ask(), 'Cancel at the plan gate')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: 'Cancel at the plan gate' })
  await card.getByRole('button', { name: 'Cancel run' }).click()
  await expect(card.getByText(`${key} · Failed`)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run and plan again' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run with this plan' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Re-run', exact: true })).toHaveCount(0)
  await expectAccessible(page)
})

// Re-run's note: typed by the owner, or filled from the failed run's pull request review. The
// helps listing is stubbed where a journey needs a review.
async function openFailed(page: Page, request: APIRequestContext, title: string) {
  const key = await approvedTask(request, ask(), title)
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Failed' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  return page.getByRole('dialog', { name: title })
}

/** A succeeded pull request review of the failed run, as the helps listing returns it. */
const prReview = (result: object) => ({
  id: '00000000-0000-4000-8000-0000000000b1',
  approval_id: null,
  decision: 'pull_request',
  subject: { pr_run_id: 'run' },
  question_index: null,
  mode: 'code_review',
  status: 'succeeded',
  result,
  reason: null,
  created_at: '2026-11-17T10:30:00Z',
})

const NEW_SHAPE = {
  mode: 'code_review',
  verdict: 'changes',
  blockers: 1,
  findings: [
    {
      kind: 'bug',
      where: 'src/retry.ts:3',
      text: 'The delay is not capped',
      matters: 'A retry may wait for hours',
      destination: 'blocker',
      evidence: 'src/retry.ts:3',
    },
    {
      kind: 'fit',
      where: 'src/dead.ts:1',
      text: '**Where:** src/dead.ts\n**Found:** today\n**Problem:** a copy\n**Impact:** drift',
      matters: 'Two copies drift',
      destination: 'outside',
      evidence: 'src/dead.ts:1',
      title: 'Dead letters repeat the retry loop',
    },
  ],
  unsure: 'Nothing.',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  skipped: [],
  next_step: 'rerun_again',
  reasoning: 'The plan missed the cap.',
}

test('Re-run sends the note, and a refusal of the note is shown on the field with focus', async ({
  page,
  request,
}) => {
  const card = await openFailed(page, request, 'Fail after a confident plan, with a note')
  const note = card.getByRole('textbox', { name: 'Note for the next run' })
  await note.fill('Keep the delays at 1, 2 and 4.')

  let body: unknown
  await page.route('**/api/tasks/*/actions/rerun', (route) => {
    body = route.request().postDataJSON()
    return route.fulfill({
      status: 400,
      json: { error: 'validation_error', message: 'note is too long', details: { field: 'note' } },
    })
  })
  await card.getByRole('button', { name: 'Re-run and plan again' }).click()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expect(note).toBeFocused()
  expect(body).toEqual({ plan: 'again', note: 'Keep the delays at 1, 2 and 4.' })
  await expect(card.getByRole('status').filter({ hasText: /^Re-run was refused: / })).toBeVisible()
  await expectAccessible(page)
})

test('Use the pull request review fills the note with the chosen findings and sends nothing', async ({
  page,
  request,
}) => {
  await page.route('**/api/tasks/*/helps', (route) =>
    route.fulfill({ json: [prReview(NEW_SHAPE)] }),
  )
  const card = await openFailed(page, request, 'Fail after a confident plan, then a review')
  const note = card.getByRole('textbox', { name: 'Note for the next run' })
  const group = (n: number) =>
    card.getByRole('radiogroup', { name: `What to do with finding ${n}` })
  await card.getByRole('button', { name: 'Use the pull request review' }).click()
  await expect(group(1).getByRole('radio', { name: 'Put in the note' })).toBeChecked()
  await expect(group(2).getByRole('radio', { name: 'Leave out' })).toBeChecked()

  const sent: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/') && req.method() !== 'GET') sent.push(req.url())
  })
  await card.getByRole('button', { name: 'Fill note' }).click()
  const filled = [
    'From the pull request review of 2026-11-17 10:30, at commit abcdef012345:',
    '- blocker, bug (src/retry.ts:3): The delay is not capped Evidence: src/retry.ts:3',
  ].join('\n')
  await expect(note).toHaveValue(filled)
  // AC24: focus goes to the note, the caret at its end.
  await expect(note).toBeFocused()
  expect(await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(filled.length)
  await expect(
    card
      .getByRole('status')
      .filter({ hasText: 'Pull request review put in the note for the next run.' }),
  ).toBeVisible()
  expect(sent).toEqual([])
  await expectAccessible(page)
})

test('a review of the old shape offers no Use the pull request review', async ({
  page,
  request,
}) => {
  const { blockers: _blockers, ...old } = NEW_SHAPE
  await page.route('**/api/tasks/*/helps', (route) => route.fulfill({ json: [prReview(old)] }))
  const card = await openFailed(page, request, 'Fail after a confident plan, an old review')
  await expect(card.getByRole('textbox', { name: 'Note for the next run' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Use the pull request review' })).toHaveCount(0)
})
