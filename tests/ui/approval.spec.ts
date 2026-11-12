import { expect, test } from '@playwright/test'
import {
  appUrl,
  approvedTask,
  expectAccessible,
  focusedText,
  registerProject,
  runtime,
  tabTo,
} from './helpers'

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
  const options = panel.getByRole('radiogroup', {
    name: 'Which colour should the retry banner be?',
  })
  const blue = options.getByRole('radio', { name: 'blue (recommended)' })
  await expect(blue).toHaveAccessibleDescription('Matches the logo')
  await expectAccessible(page)

  // Choosing sends nothing: only Send answer does.
  await blue.check()
  await expect(panel.getByRole('heading', { level: 3, name: 'Open question' })).toBeVisible()
  await panel.getByRole('button', { name: 'Send answer' }).click()
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

  // Approving carries no words: a radio like any other, sent with Send answer.
  const approve = panel.getByRole('radio', { name: 'Approve plan' })
  await approve.check()
  await changes.fill('but split step 2')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  await expect(changes).toBeFocused()
  await expect(changes).toHaveAttribute('aria-invalid', 'true')
  await expect(changes).toHaveAccessibleDescription(/Approving the plan carries no words/)

  await changes.fill('')
  await panel.getByRole('button', { name: 'Send answer' }).click()
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

  // The panel's order: the two helps, the options as one group, Clear choice, the field, Send answer.
  const suggest = panel.getByRole('button', { name: 'Suggest an answer' })
  const small = panel.getByRole('radio', { name: 'small' })
  const large = panel.getByRole('radio', { name: 'large (recommended)' })
  await tabTo(page, suggest)
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Explain simply' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(small).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(large).toBeFocused()
  await expect(large).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Clear choice' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('textbox', { name: 'Your answer' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Send answer' })).toBeFocused()

  // Answering removes the controls that did it: focus goes to the state line first.
  await page.keyboard.press('Enter')
  await expect.poll(() => focusedText(page)).toMatch(new RegExp(`^${key} · `))
  await expect(
    card.getByRole('status').filter({ hasText: `${key} answered. The run continues.` }),
  ).toBeVisible()
  await expectAccessible(page)
})

test('a migration request shows its path and code, in a block that scrolls at 320 px', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Show a migration')
  const path = 'server/src/db/migrations/004_x.ts'
  const code = [
    'export async function up(db: Kysely<any>) {',
    '  await db.schema.alterTable("runs").addColumn("x", "text").execute()',
    '}',
    '',
    'export async function down(db: Kysely<any>) {',
    '  await db.schema.alterTable("runs").dropColumn("x").execute()',
    '}',
  ].join('\n')
  // The board shows the request it would hold for a migration: the tab is given one to read.
  await page.route('**/api/tasks/*/approvals', async (route) => {
    await route.fulfill({
      json: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          run_id: '00000000-0000-4000-8000-000000000002',
          phase_id: null,
          kind: 'migration',
          question: 'Adds runs.x; its down step drops it.',
          options: [
            { id: 'allow', label: 'Allow the migration' },
            { id: 'refuse', label: 'Keep to the plan' },
          ],
          recommendation: null,
          context_md: `${code}\n// <b>not markup</b>`,
          files: [path],
          questions: null,
          question_count: 1,
          status: 'open',
          answer: null,
          created_at: '2026-10-20T10:00:00Z',
          answered_at: null,
        },
      ],
    })
  })
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto(appUrl('/p/ASK'))
  const link = page.getByRole('link', { name: new RegExp(`^${key} `) })
  await expect(link).toBeVisible(RUN)
  await link.click()
  const card = page.getByRole('dialog', { name: 'Show a migration' })
  await card.getByRole('tab', { name: 'Approvals' }).click()
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })
  await expect(panel.getByText('Adds runs.x; its down step drops it.')).toBeVisible()
  await expect(panel.getByText(path, { exact: true })).toBeVisible()
  const block = panel.getByRole('region', { name: `Contents of ${path}` })
  await expect(block).toContainText('// <b>not markup</b>')
  expect(await block.evaluate((node) => node.textContent)).toContain(
    `${code.split('\n')[1]}\n}\n\nexport`,
  )
  expect(await block.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i)
  expect(await block.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre')
  expect(await block.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  // The block scrolls within itself: it never reaches past the 320 px viewport.
  const box = await block.boundingBox()
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320)
  await expect(panel.getByRole('radio', { name: 'Allow the migration' })).toBeVisible()
  await expect(panel.getByRole('radio', { name: 'Keep to the plan' })).toBeVisible()
  // A migration request is helped like any: the two buttons, with the options unchanged.
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Explain simply' })).toBeVisible()
  // The block scrolls, so the keyboard reaches it: one tab stop, then the first help.
  await tabTo(page, block)
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).toBeFocused()
  await expectAccessible(page)
})

const REQUEST = {
  id: '00000000-0000-4000-8000-000000000001',
  run_id: '00000000-0000-4000-8000-000000000002',
  phase_id: null,
  kind: 'question',
  question: 'Which way?',
  options: [{ id: 'a', label: 'Way A' }],
  recommendation: null,
  context_md: null,
  files: null,
  questions: null,
  question_count: 1,
  status: 'open',
  answer: null,
  created_at: '2026-10-20T10:00:00Z',
  answered_at: null,
}

/**
 * Opens the Approvals tab of a card whose approvals are the given requests. The task has no
 * spec and no run: the requests are routed, and the one runner is left to the journeys that
 * need a real run.
 */
async function openApprovals(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  title: string,
  requests: object[],
) {
  await registerProject(request, ask())
  const { key } = (await (
    await request.post(appUrl('/api/projects/ASK/tasks'), { data: { title } })
  ).json()) as { key: string }
  await page.route('**/api/tasks/*/approvals', (route) => route.fulfill({ json: requests }))
  await page.goto(appUrl('/p/ASK'))
  const link = page.getByRole('link', { name: new RegExp(`^${key} `) })
  await expect(link).toBeVisible(RUN)
  await link.click()
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'Approvals' }).click()
  return card.getByRole('tabpanel', { name: 'Approvals' })
}

const PLAN_CONTEXT = [
  'Two steps',
  '',
  'Confidence: high',
  '',
  '1. **Backoff** (R1) — `src/retry.ts`',
  '2. **Dead letters** (R2) — `src/dead.ts`',
  '',
  '| Criterion | Check |',
  '| --- | --- |',
  '| AC1 | a \\| b |',
  '| AC2 | unit test |',
].join('\n')

test('a plan request shows its context as formatted text, with the checks as a table', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Show a plan', [
    { ...REQUEST, kind: 'plan', context_md: PLAN_CONTEXT, options: [] },
  ])
  const table = panel.getByRole('table')
  await expect(table.getByRole('columnheader', { name: 'Criterion' })).toBeVisible()
  await expect(table.getByRole('columnheader', { name: 'Check' })).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('cell', { name: 'a | b' })).toBeVisible()
  await expect(panel.locator('strong', { hasText: 'Backoff' })).toBeVisible()
  await expect(panel.getByText('| --- |')).toHaveCount(0)
  await expectAccessible(page)
  // The table scrolls, so the keyboard reaches it before the request's first answer control.
  const group = panel.getByRole('group', { name: 'Table' })
  await tabTo(page, group)
  await expect(group).toBeFocused()
  await expect(panel.getByRole('textbox', { name: 'Changes to ask for' })).not.toBeFocused()
})

interface ContextRow {
  name: string
  requests: object[]
  heading: { level: number; name: string }
}
const WHY = '## Why\n- one\n- two'
const CONTEXT_ROWS: ContextRow[] = [
  {
    name: 'a question request',
    requests: [{ ...REQUEST, context_md: WHY }],
    heading: { level: 4, name: 'Why' },
  },
  {
    name: 'a batch question',
    requests: [
      {
        ...REQUEST,
        kind: 'questions',
        options: [],
        questions: [
          { id: 'q1', question: 'First?', context_md: WHY, options: [] },
          { id: 'q2', question: 'Second?', context_md: null, options: [] },
        ],
        question_count: 2,
      },
    ],
    heading: { level: 5, name: 'Why' },
  },
]

for (const row of CONTEXT_ROWS) {
  test(`${row.name} shows its context's headings and list formatted`, async ({ page, request }) => {
    const panel = await openApprovals(page, request, `Context of ${row.name}`, row.requests)
    await expect(panel.getByRole('heading', row.heading)).toBeVisible()
    await expect(
      panel.getByRole('list').filter({ hasText: 'one' }).getByRole('listitem'),
    ).toHaveCount(2)
    await expectAccessible(page)
  })
}

test('a question context shows hostile markup as text, and its white space is normal', async ({
  page,
  request,
}) => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    '',
    '<b>bold</b>',
    '',
    '[bad](javascript:alert(1)) [good](https://example.com)',
  ].join('\n')
  const panel = await openApprovals(page, request, 'Hostile context', [
    { ...REQUEST, context_md: hostile },
  ])
  await expect(panel.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
  await expect(panel.getByText('<b>bold</b>')).toBeVisible()
  await expect(panel.locator('img, b')).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'bad' })).toHaveCount(0)
  await expect(panel.getByRole('link', { name: 'good' })).toHaveAttribute(
    'href',
    'https://example.com',
  )
  const context = panel.locator('.approval .context')
  expect(await context.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('normal')
  await expectAccessible(page)
})

const PLAN_REQUEST = {
  ...REQUEST,
  kind: 'plan',
  options: [{ id: 'approve', label: 'Approve plan' }],
}

test('Clear choice withdraws Approve plan, and an approval with words is refused before sending', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Clear plan choice', [PLAN_REQUEST])
  const clear = panel.getByRole('button', { name: 'Clear choice' })
  const approve = panel.getByRole('radio', { name: 'Approve plan' })
  const changes = panel.getByRole('textbox', { name: 'Changes to ask for' })
  await expect(clear).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Suggest an answer' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Explain simply' })).toBeVisible()
  await approve.check()
  await expect(clear).toBeVisible()
  await expectAccessible(page)

  let posted = 0
  await page.route('**/api/approvals/*/answer', (route) => {
    posted += 1
    return route.abort()
  })
  await changes.fill('but split step 2')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  expect(posted).toBe(0)
  await expect(changes).toBeFocused()
  await expect(changes).toHaveAttribute('aria-invalid', 'true')
  await expect(changes).toHaveAccessibleDescription(/press Clear choice to ask for changes/)

  await clear.click()
  await expect(approve).not.toBeChecked()
  await expect(approve).toBeFocused()
  await expect(clear).toHaveCount(0)
  await expect(changes).toHaveValue('but split step 2')
  await expect(changes).not.toHaveAttribute('aria-invalid', 'true')
})

test('Clear choice is for a single request only, and the keyboard reaches it in order', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Clear plan keys', [PLAN_REQUEST])
  const approve = panel.getByRole('radio', { name: 'Approve plan' })
  await approve.check()
  await panel.getByRole('button', { name: 'Suggest an answer' }).focus()
  for (const name of ['Explain simply']) {
    await page.keyboard.press('Tab')
    await expect(panel.getByRole('button', { name })).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(approve).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Clear choice' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('textbox', { name: 'Changes to ask for' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('button', { name: 'Send answer' })).toBeFocused()
  await panel.getByRole('button', { name: 'Clear choice' }).focus()
  await page.keyboard.press('Enter')
  await expect(approve).not.toBeChecked()
  await expect(approve).toBeFocused()
})

test('a question shows Clear choice once an option is chosen, and an over-long answer is explained', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Clear question choice', [REQUEST])
  await expect(panel.getByRole('button', { name: 'Clear choice' })).toHaveCount(0)
  await panel.getByRole('radio', { name: 'Way A' }).check()
  await expect(panel.getByRole('button', { name: 'Clear choice' })).toBeVisible()
  await page.route('**/api/approvals/*/answer', (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: 'validation_error',
        message: 'm',
        details: { issues: [{ instancePath: '/text', keyword: 'maxLength' }] },
      },
    }),
  )
  await panel.getByRole('button', { name: 'Send answer' }).click()
  const words = panel.getByRole('textbox', { name: 'Your answer' })
  await expect(words).toBeFocused()
  await expect(words).toHaveAccessibleDescription(/longer than 4,000 characters/)
  await expect(words).not.toHaveAccessibleDescription(/Approving the plan/)
})

test('a batch question has no Clear choice, even with an option chosen', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Clear batch choice', [
    {
      ...REQUEST,
      kind: 'questions',
      options: [],
      questions: [
        { id: 'q1', question: 'First?', context_md: null, options: [{ id: 'a', label: 'Way A' }] },
        { id: 'q2', question: 'Second?', context_md: null, options: [] },
      ],
      question_count: 2,
    },
  ])
  await panel.getByRole('radio', { name: 'Way A' }).check()
  await expect(panel.getByRole('button', { name: 'Clear choice' })).toHaveCount(0)
})

test('Use this answer with words at a plan gate unchecks Approve plan and clears the error', async ({
  page,
  request,
}) => {
  const panel = await openApprovals(page, request, 'Use plan words', [PLAN_REQUEST])
  const view = {
    id: '00000000-0000-4000-8000-0000000000a1',
    approval_id: PLAN_REQUEST.id,
    decision: 'question',
    subject: null,
    question_index: null,
    mode: 'suggest',
    status: 'succeeded',
    result: { mode: 'suggest', text: 'split step 2', reasoning: 'r', unsure: 'u' },
    reason: null,
    created_at: '2026-10-20T10:00:00Z',
  }
  await page.route('**/api/approvals/*/helps', (route) => route.fulfill({ json: view }))
  await page.route('**/api/tasks/*/helps', (route) => route.fulfill({ json: [view] }))
  const approve = panel.getByRole('radio', { name: 'Approve plan' })
  const changes = panel.getByRole('textbox', { name: 'Changes to ask for' })
  await approve.check()
  await changes.fill('but something')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  await expect(changes).toHaveAttribute('aria-invalid', 'true')
  await panel.getByRole('button', { name: 'Suggest an answer' }).click()
  await panel.getByRole('button', { name: 'Use this answer' }).click()
  await expect(approve).not.toBeChecked()
  await expect(changes).toHaveValue('split step 2')
  await expect(changes).not.toHaveAttribute('aria-invalid', 'true')
})

test('after Clear choice, words ask the planner for a second plan', async ({ page, request }) => {
  const key = await approvedTask(request, ask(), 'Clear choice at the plan gate')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click({ timeout: RUN.timeout })
  const card = page.getByRole('dialog', { name: 'Clear choice at the plan gate' })
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })
  await panel.getByRole('radio', { name: 'Approve plan' }).check()
  await panel.getByRole('button', { name: 'Clear choice' }).click()
  await panel.getByRole('textbox', { name: 'Changes to ask for' }).fill('split step 2')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  const answered = panel.getByRole('heading', { name: 'Answered' })
  await expect(answered).toBeVisible(RUN)
  await expect(panel.getByRole('list').filter({ hasText: 'split step 2' })).toBeVisible(RUN)
  // The planner's second turn opens a second plan request.
  await expect(panel.getByRole('textbox', { name: 'Changes to ask for' })).toBeVisible(RUN)
  await expect(panel.getByRole('radio', { name: 'Approve plan' })).not.toBeChecked()
})
