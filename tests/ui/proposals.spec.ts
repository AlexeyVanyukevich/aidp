import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime } from './helpers'

const project = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

const description = '**Where:** a\n**Found:** b\n**Problem:** c\n**Impact:** d'
const proposal = (overrides: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  run: { kind: 'delivery', number: 1 },
  phase: 'plan',
  number: 1,
  project: 'ASK',
  title: 'Radio cannot be unticked',
  description_md: description,
  related: true,
  bearing_md: 'It blocks the form.',
  workaround_md: 'Untick by hand.',
  offered: ['file', 'workaround', 'dismiss'],
  outcome: null,
  filed_task: null,
  created_at: '2026-11-12T10:00:00Z',
  settled_at: null,
  ...overrides,
})

test('the Proposals tab reads, settles and reports as the spec says', async ({ page, request }) => {
  await registerProject(request, project())
  // A task in Backlog: no run starts, and the card's state is mocked below.
  const created = (await (
    await request.post(appUrl('/api/projects/ASK/tasks'), { data: { title: 'Propose from here' } })
  ).json()) as { key: string }
  const key = created.key
  const open = proposal({})
  const settled = proposal({
    title: 'Unrelated, filed earlier',
    number: 2,
    related: false,
    bearing_md: 'Seen in build.',
    workaround_md: null,
    offered: [],
    outcome: 'file',
    filed_task: { id: crypto.randomUUID(), key: 'ASK-9', title: 'Unrelated, filed earlier' },
    settled_at: '2026-11-12T11:00:00Z',
  })
  let list = [open, settled]
  let failWith: { status: number; body: unknown } | undefined

  await page.route('**/api/tasks/*/proposals', (route) => route.fulfill({ json: list }))
  await page.route('**/api/tasks/*/proposals/*/settle', (route) => {
    if (failWith !== undefined)
      return route.fulfill({ status: failWith.status, json: failWith.body })
    list = [
      {
        ...open,
        offered: [],
        outcome: 'file',
        filed_task: { id: 'f', key: 'ASK-10', title: open.title },
        settled_at: '2026-11-12T12:00:00Z',
      },
      settled,
    ]
    return route.fulfill({ json: list[0] })
  })
  // The card waits on the proposal's approval.
  await page.route(/\/api\/tasks\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const task = (await response.json()) as Record<string, unknown>
    return route.fulfill({
      json: {
        ...task,
        state: 'needs_approval',
        approval: { id: 'a', kind: 'proposal', status: 'open', questions: 1 },
      },
    })
  })

  await page.goto(appUrl(`/p/${'ASK'}`))
  await page
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .first()
    .click()
  const card = page.getByRole('dialog', { name: 'Propose from here' })
  await expect(card.getByRole('tab', { name: 'Proposals' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const panel = card.getByRole('tabpanel', { name: 'Proposals' })

  await expect(panel.getByRole('heading', { level: 3, name: 'Run 1' })).toBeVisible()
  const heading = panel.getByRole('heading', { level: 4, name: open.title })
  await expect(heading).toBeVisible()
  await expect(
    panel.getByRole('heading', { level: 4, name: 'Unrelated, filed earlier' }),
  ).toBeVisible()
  await expect(panel.getByText('How it bears on this task:')).toBeVisible()
  await expect(panel.getByText('Why it came up here:')).toBeVisible()
  for (const name of [
    'File in ASK',
    'Use the workaround and file in ASK',
    'Dismiss',
    'Suggest how to settle',
  ])
    await expect(panel.getByRole('button', { name, exact: true })).toHaveAccessibleDescription(
      open.title,
    )
  await expectAccessible(page)

  // Tab order: no heading takes focus by keyboard.
  const focusable = await panel.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('a[href], summary, button')).map((e) =>
      e.textContent?.trim(),
    ),
  )
  expect(focusable.some((text) => text === open.title)).toBe(false)
  await expect(heading).toHaveAttribute('tabindex', '-1')

  // A duplicate puts its sentence in the problem region, which takes focus.
  failWith = {
    status: 409,
    body: {
      error: 'conflict',
      message: 'x',
      details: { reason: 'duplicate', key: 'ASK-3', state: 'done' },
    },
  }
  await panel.getByRole('button', { name: 'File in ASK', exact: true }).click()
  const problem = card.getByRole('alert').filter({ hasText: 'ASK-3 (done) already has this title' })
  await expect(problem).toBeVisible()
  await expect(problem).toBeFocused()

  failWith = undefined
  await panel.getByRole('button', { name: 'File in ASK', exact: true }).click()
  await expect(heading).toBeFocused()
  await expect(
    card.getByRole('status').filter({ hasText: `Filed ASK-10: ${open.title}.` }),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'File in ASK', exact: true })).toHaveCount(0)
  await expectAccessible(page)
})
