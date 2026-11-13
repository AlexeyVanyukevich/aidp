import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, registerProject, runtime } from './helpers'

// Review pull request on the PR tab. A card in Review with a pull request comes from the fake
// runner; the helper's answers are stubbed, because the fake helper has no script for a review.
const RUN = { timeout: 90_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'

const refusal = (status: number) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ error: status === 409 ? 'conflict' : 'internal_error', message: 'no' }),
})
const REFUSALS = [
  [409, 'This card changed meanwhile; its latest state is shown.'],
  [500, 'That did not work. Try again.'],
] as const

interface StubbedHelp {
  id: string
  approval_id: null
  decision: 'pull_request'
  subject: { pr_run_id: string }
  question_index: null
  mode: 'code_review'
  status: 'running' | 'succeeded' | 'failed'
  result: unknown
  reason: string | null
  created_at: string
}

const review = (change: Partial<StubbedHelp>): StubbedHelp => ({
  id: 'review-1',
  approval_id: null,
  decision: 'pull_request',
  subject: { pr_run_id: 'run' },
  question_index: null,
  mode: 'code_review',
  status: 'running',
  result: null,
  reason: null,
  created_at: '2026-11-13T10:00:00Z',
  ...change,
})

const RESULT = {
  mode: 'code_review',
  verdict: 'changes',
  findings: [
    {
      kind: 'bug',
      where: 'src/retry.ts:3',
      text: 'The delay is not capped',
      matters: 'A retry may wait for hours',
    },
  ],
  unsure: 'Every file not skipped was read whole.',
  commit: COMMIT,
  skipped: [{ path: 'package-lock.json', skip: 'lockfile' }],
}

async function inReview(request: APIRequestContext, title: string) {
  await registerProject(request, ask())
  const key = await approvedTask(request, ask(), title)
  const tasks = (await (await request.get(appUrl('/api/projects/ASK/tasks'))).json()) as {
    tasks: { id: string; key: string }[]
  }
  const id = tasks.tasks.find((task) => task.key === key)!.id
  await expect
    .poll(
      async () =>
        ((await (await request.get(appUrl(`/api/tasks/${id}`))).json()) as { state: string }).state,
      RUN,
    )
    .toBe('review')
  return { key, id }
}

async function openPrTab(page: Page, key: string, title: string) {
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Review' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  return { card, pr: card.getByRole('tabpanel', { name: 'PR', exact: true }) }
}

/** Serves the helps list from `state.list`, and answers a POST by running `onPost`. */
async function stubHelps(
  page: Page,
  id: string,
  state: { list: StubbedHelp[] },
  onPost: () => void,
) {
  await page.route(`**/api/tasks/${id}/helps`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      onPost()
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(state.list[0]),
      })
    } else
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(state.list),
      })
  })
}

/** The board's queries are fresh for 10 s; once stale, a return to the tab reads them again. */
const refetch = async (page: Page) => {
  await page.waitForTimeout(10_500)
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
}

test('Review pull request is busy while it runs, then shows the review and announces it', async ({
  page,
  request,
}) => {
  const title = 'Review a pull request'
  const task = await inReview(request, title)
  const state = { list: [] as StubbedHelp[] }
  await stubHelps(page, task.id, state, () => {
    state.list = [review({})]
  })
  const { card, pr } = await openPrTab(page, task.key, title)
  const button = pr.getByRole('button', { name: 'Review pull request' })
  await expect(button).toBeVisible(RUN)

  // Focus order: the pull request link, Review pull request, then what follows.
  await pr.getByRole('link', { name: /^Pull request #/ }).focus()
  await page.keyboard.press('Tab')
  await expect(button).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-busy', 'true')
  await expect(button).toBeFocused()

  await card.getByRole('tab', { name: 'Timeline' }).click()
  state.list = [review({ status: 'succeeded', result: RESULT })]
  await refetch(page)
  await expect(
    card.getByRole('status').filter({ hasText: 'Pull request review ready for abcdef0.' }),
  ).toBeVisible()
  await card.getByRole('tab', { name: 'PR', exact: true }).click()

  const heading = pr.getByRole('heading', { level: 3, name: 'Pull request review of abcdef0' })
  await expect(heading).toBeVisible()
  const files = pr.getByRole('heading', { level: 3, name: 'Files changed' })
  const before = await heading.evaluate(
    (h, f) => !!(h.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING),
    await files.elementHandle(),
  )
  expect(before).toBe(true)
  await expect(pr).toContainText('The delay is not capped')
  await expect(pr).toContainText('Why it matters: A retry may wait for hours')
  await expect(pr.locator('.zl-badge', { hasText: 'bug' })).toBeVisible()
  await expectAccessible(page)
})

test('a refused review request shows the problem notice with focus', async ({ page, request }) => {
  const title = 'Refused review'
  const task = await inReview(request, title)
  const { card, pr } = await openPrTab(page, task.key, title)
  for (const [status, words] of REFUSALS) {
    await page.route(`**/api/tasks/${task.id}/helps`, (route) => {
      if (route.request().method() === 'POST') return route.fulfill(refusal(status))
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await pr.getByRole('button', { name: 'Review pull request' }).click(RUN)
    const notice = card.getByRole('alert').filter({ hasText: words })
    await expect(notice).toBeVisible()
    await expect(notice).toBeFocused()
    await page.unroute(`**/api/tasks/${task.id}/helps`)
  }
})

test('a review that fails is shown and announced with its reason on any tab', async ({
  page,
  request,
}) => {
  const title = 'Failed review'
  const task = await inReview(request, title)
  const state = { list: [] as StubbedHelp[] }
  await stubHelps(page, task.id, state, () => {
    state.list = [review({})]
  })
  const { card, pr } = await openPrTab(page, task.key, title)
  await pr.getByRole('button', { name: 'Review pull request' }).click(RUN)
  await card.getByRole('tab', { name: 'Timeline' }).click()
  state.list = [review({ status: 'failed', reason: 'the branch `x` is not on origin' })]
  await refetch(page)
  await expect(
    card
      .getByRole('status')
      .filter({ hasText: 'No pull request review: the branch `x` is not on origin.' }),
  ).toBeVisible()
  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  await expect(pr).toContainText('No pull request review: the branch `x` is not on origin')
})

test('a card in Done has no Review pull request button', async ({ page, request }) => {
  const title = 'Done without a review'
  const task = await inReview(request, title)
  expect(
    (await request.patch(appUrl(`/api/tasks/${task.id}`), { data: { state: 'done' } })).ok(),
  ).toBe(true)
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Done' })
    .getByRole('link', { name: new RegExp(`^${task.key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Review pull request' })).toHaveCount(0)
})
