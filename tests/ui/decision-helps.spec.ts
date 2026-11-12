import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import {
  appUrl,
  approvedTask,
  expectAccessible,
  registerProject,
  runtime,
  SPEC,
  tabTo,
} from './helpers'

// Help at the owner's decisions: Spec review, a stopped run and Mark done. The fake helper's
// scripts are in global setup.
const RUN = { timeout: 90_000 }
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })
const stuck = () => ({ key: 'STK', name: 'Stuck', path: runtime().stuckPath, repo: 'owner/stuck' })

/** A refusal as the server words one: its code in `error`, as the card's error helpers read it. */
const refusal = (status: number) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ error: status === 409 ? 'conflict' : 'internal_error', message: 'no' }),
})
const REFUSALS = [
  [409, 'This card changed meanwhile; its latest state is shown.'],
  [500, 'That did not work. Try again.'],
] as const

async function specTask(request: APIRequestContext, title: string) {
  await registerProject(request, draft())
  const task = (await (
    await request.post(appUrl('/api/projects/DFT/tasks'), { data: { title } })
  ).json()) as { id: string; key: string }
  await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: SPEC } })
  return task
}

async function openSpec(page: Page, key: string, title: string) {
  await page.goto(appUrl('/p/DFT'))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click()
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'Spec' }).click()
  return { card, spec: card.getByRole('tabpanel', { name: 'Spec' }) }
}

async function openFailed(page: Page, request: APIRequestContext, title: string) {
  const key = await approvedTask(request, ask(), title)
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Failed' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  return page.getByRole('dialog', { name: title })
}

async function openBlocked(page: Page, request: APIRequestContext, title: string) {
  const key = await approvedTask(request, stuck(), title)
  await page.goto(appUrl('/p/STK'))
  await page
    .getByRole('region', { name: 'Blocked' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  return page.getByRole('dialog', { name: title })
}

test('Review spec and Explain simply give results under their headings, announced on any tab', async ({
  page,
  request,
}) => {
  const task = await specTask(request, 'Help at Spec review')
  const { card, spec } = await openSpec(page, task.key, 'Help at Spec review')
  const review = spec.getByRole('button', { name: 'Review spec' })
  const plain = spec.getByRole('button', { name: 'Explain simply' })
  const approve = spec.getByRole('button', { name: 'Approve' })
  const approveEnabled = await approve.isEnabled()
  const note = spec.getByRole('textbox', { name: 'What to change' })
  const use = spec.getByRole('button', { name: 'Use these findings' })
  const buttonsBefore = await buttonStates(card)

  // Focus order: Edit, Approve, Review spec, Explain simply.
  await tabTo(page, spec.getByRole('button', { name: 'Edit' }))
  await page.keyboard.press('Tab')
  await expect(approve).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(review).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(plain).toBeFocused()

  await review.focus()
  await page.keyboard.press('Enter')
  await expect(review).toBeFocused()
  await card.getByRole('tab', { name: 'Timeline' }).click()
  await expect(
    card.getByRole('status').filter({ hasText: 'Spec review ready for v1.' }),
  ).toBeVisible(RUN)
  await card.getByRole('tab', { name: 'Spec' }).click()

  await expect(spec.getByRole('heading', { level: 3, name: 'Help with v1' })).toBeVisible()
  const result = spec.getByRole('heading', { level: 4, name: 'Spec review of v1' })
  await expect(result).toBeVisible()
  await expect(spec).toContainText('No retry limit')

  // Use these findings fills the note from the keyboard, sends nothing and leaves the card be.
  const requests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/')) requests.push(`${req.method()} ${req.url()}`)
  })
  await spec
    .getByRole('status')
    .first()
    .evaluate((node) => {
      const seen: string[] = []
      ;(window as unknown as { seen: string[] }).seen = seen
      new MutationObserver(() => seen.push(node.textContent ?? '')).observe(node, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    })
  const line = '- missing (R1): No retry limit'
  await tabTo(page, use)
  await page.keyboard.press('Enter')
  await expect(note).toHaveValue(line)
  await expect(note).toBeFocused()
  expect(await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(line.length)
  await expect(spec.getByText('Findings put in What to change.')).toBeVisible()
  await expect(card.getByText(`${task.key} · Spec review`)).toBeVisible()
  await expectAccessible(page)
  expect(await buttonStates(card)).toEqual(buttonsBefore)
  for (const name of ['Approve', 'Redraft', 'Mark done'])
    expect(buttonsBefore[name], name).not.toBeNull()

  // A second press is announced again: the region is emptied, then refilled.
  await page.evaluate(() => ((window as unknown as { seen: string[] }).seen.length = 0))
  await use.click()
  await expect(spec.getByText('Findings put in What to change.')).toBeVisible()
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen)
  expect(seen.slice(0, 2)).toEqual(['', 'Findings put in What to change.'])
  expect(requests.filter((request) => !request.startsWith('GET '))).toEqual([])

  // Words already in the note stay, and the lines come after a blank line.
  await note.fill('Also rename X.')
  await use.click()
  await expect(note).toHaveValue(`Also rename X.\n\n${line}`)

  await plain.click()
  await expect(plain).toBeFocused()
  await expect(spec.getByRole('heading', { level: 4, name: 'v1 in plain words' })).toBeVisible(RUN)

  // Help changes nothing about Approve.
  expect(await approve.isEnabled()).toBe(approveEnabled)
  await expectAccessible(page)
})

test('a failed review shows its reason in the Help section', async ({ page, request }) => {
  const task = await specTask(request, 'A spec review that fails')
  const { spec } = await openSpec(page, task.key, 'A spec review that fails')
  await spec.getByRole('button', { name: 'Review spec' }).click()
  await expect(spec.getByText(/^No spec review for v1: /)).toBeVisible(RUN)
})

test('a review with nothing to change offers no button in its result', async ({
  page,
  request,
}) => {
  const task = await specTask(request, 'Buttons at Spec review')
  const { spec } = await openSpec(page, task.key, 'Buttons at Spec review')
  await spec.getByRole('button', { name: 'Review spec' }).click()
  const result = spec.getByRole('region', { name: 'Spec review of v1' })
  await expect(result).toContainText('Nothing to change', RUN)
  await expect(result.getByRole('button')).toHaveCount(0)
})

test('a refused decision POST shows the problem notice with focus', async ({ page, request }) => {
  const task = await specTask(request, 'Help at Spec review')
  const { spec } = await openSpec(page, task.key, 'Help at Spec review')
  for (const [status, words] of REFUSALS) {
    await page.route(`**/api/tasks/${task.id}/helps`, (route) => route.fulfill(refusal(status)))
    await spec.getByRole('button', { name: 'Review spec' }).click()
    // The notice itself takes focus, not the text inside it.
    const notice = spec.getByRole('alert').filter({ hasText: words })
    await expect(notice).toBeVisible()
    await expect(notice).toBeFocused()
    await page.unroute(`**/api/tasks/${task.id}/helps`)
  }
})

test('a Failed card offers Suggest what to do and Check what is unfinished', async ({
  page,
  request,
}) => {
  const card = await openFailed(page, request, 'Help at a stop')
  const done = card.getByRole('button', { name: 'Mark done' })
  const check = card.getByRole('button', { name: 'Check what is unfinished' })
  const suggest = card.getByRole('button', { name: 'Suggest what to do' })
  const status = card.getByRole('status')
  const doneEnabled = await done.isEnabled()
  const keepEnabled = await card.getByRole('button', { name: 'Re-run with this plan' }).isEnabled()

  // Focus order of the action bar.
  await tabTo(page, done)
  await page.keyboard.press('Tab')
  await expect(check).toBeFocused()
  await tabTo(page, suggest)

  await suggest.click()
  await expect(suggest).toBeFocused()
  await expect(
    status.filter({ hasText: 'Suggested next step ready for the stopped run.' }),
  ).toBeVisible(RUN)
  await check.click()
  await expect(check).toBeFocused()
  await expect(
    status.filter({ hasText: 'Unfinished-work check ready for Mark done.' }),
  ).toBeVisible(RUN)

  const next = card.getByRole('heading', { level: 3, name: 'Suggested next step' })
  const unfinished = card.getByRole('heading', { level: 3, name: 'What is unfinished' })
  await expect(next).toBeVisible()
  await expect(unfinished).toBeVisible()

  // The results come before the Test command field.
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll('h3, label')]
    const at = (text: string) => all.findIndex((e) => e.textContent?.includes(text))
    return [at('Suggested next step'), at('What is unfinished'), at('Test command')]
  })
  expect(order[0]).toBeGreaterThanOrEqual(0)
  expect(order[2]).toBeGreaterThan(order[1]!)

  // Buttons are as they were without help.
  expect(await done.isEnabled()).toBe(doneEnabled)
  expect(await card.getByRole('button', { name: 'Re-run with this plan' }).isEnabled()).toBe(
    keepEnabled,
  )
  await expectAccessible(page)
})

test('a decision help that fails announces its failure with the reason', async ({
  page,
  request,
}) => {
  const card = await openFailed(page, request, 'Fail after a confident plan')
  await card.getByRole('button', { name: 'Suggest what to do' }).click()
  await expect(
    card.getByRole('status').filter({ hasText: /^No suggested next step for the stopped run: / }),
  ).toBeVisible(RUN)
})

test('a refused POST on a Failed card shows the card’s problem notice', async ({
  page,
  request,
}) => {
  const card = await openFailed(page, request, 'Fail after a confident plan')
  for (const [status, words] of REFUSALS) {
    await page.route('**/api/tasks/*/helps', (route) => route.fulfill(refusal(status)))
    await card.getByRole('button', { name: 'Suggest what to do' }).click()
    const notice = card.getByRole('alert').filter({ hasText: words })
    await expect(notice).toBeVisible()
    await expect(notice).toBeFocused()
    await page.unroute('**/api/tasks/*/helps')
  }
})

// AC29: a help that succeeded changes no decision button. Each card's buttons are read before
// the help is asked and after its result is announced; a button the card does not show is null.
const DECISION_BUTTONS = [
  'Approve',
  'Redraft',
  'Mark done',
  'Resume',
  'Cancel run',
  'Re-run with this plan',
  'Re-run and plan again',
]

async function buttonStates(card: Locator): Promise<Record<string, boolean | null>> {
  const states: Record<string, boolean | null> = {}
  for (const name of DECISION_BUTTONS) {
    const button = card.getByRole('button', { name, exact: true })
    states[name] = (await button.count()) === 0 ? null : await button.isEnabled()
  }
  return states
}

const SUCCEEDED_HELPS: {
  card: string
  open: (page: Page, request: APIRequestContext) => Promise<Locator>
  ask: string
  ready: string
  /** The buttons the card must show, so the comparison is not of absences alone. */
  shown: string[]
}[] = [
  {
    card: 'Spec review',
    open: async (page, request) => {
      const task = await specTask(request, 'Buttons at Spec review')
      return (await openSpec(page, task.key, 'Buttons at Spec review')).card
    },
    ask: 'Review spec',
    ready: 'Spec review ready for v1.',
    shown: ['Approve', 'Redraft', 'Mark done'],
  },
  {
    card: 'Failed',
    open: (page, request) => openFailed(page, request, 'Buttons at a stop'),
    ask: 'Suggest what to do',
    ready: 'Suggested next step ready for the stopped run.',
    shown: ['Mark done', 'Re-run with this plan', 'Re-run and plan again'],
  },
  {
    card: 'Blocked',
    open: (page, request) => openBlocked(page, request, 'Buttons at a block'),
    ask: 'Suggest what to do',
    ready: 'Suggested next step ready for the stopped run.',
    shown: ['Resume', 'Cancel run'],
  },
]

for (const row of SUCCEEDED_HELPS)
  test(`a succeeded help leaves a ${row.card} card’s decision buttons as they were`, async ({
    page,
    request,
  }) => {
    const card = await row.open(page, request)
    const asking = card.getByRole('button', { name: row.ask })
    await expect(asking).toBeVisible(RUN)
    const before = await buttonStates(card)
    for (const name of row.shown) expect(before[name], name).not.toBeNull()

    await asking.click()
    await expect(card.getByRole('status').filter({ hasText: row.ready })).toBeVisible(RUN)
    expect(await buttonStates(card)).toEqual(before)
  })
