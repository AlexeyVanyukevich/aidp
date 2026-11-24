import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  appUrl,
  approvedTask,
  expectAccessible,
  focusedText,
  registerProject,
  runtime,
  SPEC,
  tabTo,
} from './helpers'

// The Spec tab opens on the formatted spec; the editor opens when the owner asks for it.
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })
const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '',
  '<b>bold</b>',
  '',
  '[bad](javascript:alert(1)) [good](https://example.com)',
].join('\n')

async function newTask(
  request: APIRequestContext,
  title: string,
  body?: string,
): Promise<{ id: string; key: string }> {
  await registerProject(request, draft())
  const task = (await (
    await request.post(appUrl('/api/projects/DFT/tasks'), { data: { title } })
  ).json()) as { id: string; key: string }
  if (body !== undefined)
    await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: body } })
  return task
}

async function openSpec(page: Page, key: string, title: string, prefix = 'DFT') {
  await page.goto(appUrl(`/p/${prefix}`))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click()
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'Spec' }).click()
  return { card, spec: card.getByRole('tabpanel', { name: 'Spec' }) }
}

/** The card of a task in Spec review opens on Approvals: its tab panel holds the spec gate. */
async function openApprovals(page: Page, key: string, title: string) {
  await page.goto(appUrl('/p/DFT'))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click()
  const card = page.getByRole('dialog', { name: title })
  return { card, gate: card.getByRole('tabpanel', { name: 'Approvals' }) }
}

test('a spec in review opens formatted on the Spec tab, with Edit and Go to Approvals, and no decision', async ({
  page,
  request,
}) => {
  const task = await newTask(
    request,
    'View a spec',
    SPEC.replace('## Open questions', `## Context\n${HOSTILE}\n\n## Open questions`),
  )
  const { spec } = await openSpec(page, task.key, 'View a spec')
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · draft' })).toBeVisible()
  await expect(spec.getByRole('heading', { level: 4, name: 'Goal' })).toBeVisible()
  await expect(spec.getByRole('listitem').filter({ hasText: /^R1/ })).toBeVisible()
  await expect(spec.getByRole('textbox', { name: 'Spec' })).toHaveCount(0)
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(spec.getByText('Approve or redraft this spec on the Approvals tab.')).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Go to Approvals' })).toBeEnabled()
  for (const name of ['Approve', 'Redraft', 'Review spec', 'Explain simply'])
    await expect(spec.getByRole('button', { name })).toHaveCount(0)
  for (const name of ['Note for the planner', 'What to change'])
    await expect(spec.getByRole('textbox', { name })).toHaveCount(0)
  await expect(spec.getByRole('button', { name: 'Draft spec' })).toHaveCount(0)
  // Raw HTML is text; only a safe link is a link.
  await expect(spec.getByText('<img src=x onerror=alert(1)>').first()).toBeVisible()
  await expect(spec.getByText('<b>bold</b>').first()).toBeVisible()
  await expect(spec.locator('img, b')).toHaveCount(0)
  await expect(spec.getByRole('link', { name: 'bad' })).toHaveCount(0)
  await expect(spec.getByRole('link', { name: 'good' })).toHaveAttribute(
    'href',
    'https://example.com',
  )
  await expectAccessible(page)
})

test('a spec past review is only read, formatted', async ({ page, request }) => {
  const key = await approvedTask(
    request,
    { key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' },
    'Read an approved spec',
  )
  const { spec } = await openSpec(page, key, 'Read an approved spec', 'ASK')
  await expect(spec.getByRole('heading', { level: 4, name: 'Goal' })).toBeVisible()
  for (const name of ['Edit', 'Write spec', 'Save as v2'])
    await expect(spec.getByRole('button', { name })).toHaveCount(0)
  await expect(spec.getByRole('textbox', { name: 'Spec' })).toHaveCount(0)
})

test('while the spec-writer drafts, the spec is only read', async ({ page, request }) => {
  const task = await newTask(request, 'Read while drafting', SPEC)
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    const response = await route.fetch()
    const json = (await response.json()) as object
    await route.fulfill({ response, json: { ...json, state: 'spec_draft' } })
  })
  const { spec } = await openSpec(page, task.key, 'Read while drafting')
  await expect(
    spec.getByText('The spec-writer is drafting. The spec can be edited again when it finishes.'),
  ).toBeVisible()
  await expect(spec.getByRole('heading', { level: 4, name: 'Goal' })).toBeVisible()
  for (const name of ['Edit', 'Write spec', 'Save as v2'])
    await expect(spec.getByRole('button', { name })).toHaveCount(0)
  await expect(spec.getByRole('textbox', { name: 'Spec' })).toHaveCount(0)
  await expectAccessible(page)
})

test('with no spec, Write spec opens the editor on the template; Preview and Discard come back', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Write a spec')
  const { spec } = await openSpec(page, task.key, 'Write a spec')
  await expect(spec.getByText('No spec yet.')).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Draft spec' })).toBeVisible()
  await expectAccessible(page)

  await spec.getByRole('button', { name: 'Write spec' }).click()
  const editor = spec.getByRole('textbox', { name: 'Spec' })
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(/^## Goal/)
  await expect(spec.getByRole('button', { name: 'Draft spec' })).toHaveCount(0)
  const save = spec.getByRole('button', { name: 'Save as v1' })
  await expect(save).toBeDisabled()
  await expect(save).toHaveAccessibleDescription('Change the spec to save it as a new version.')
  await expectAccessible(page)

  await editor.fill(`${await editor.inputValue()}x`)
  await expect(save).toBeEnabled()
  await spec.getByRole('button', { name: 'Preview' }).click()
  await expect(
    spec.getByRole('heading', { level: 3, name: 'New spec · unsaved changes' }),
  ).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expect(spec.getByRole('button', { name: 'Write spec' })).toHaveCount(0)
  const drafting = spec.getByRole('button', { name: 'Draft spec' })
  await expect(drafting).toBeDisabled()
  await expect(drafting).toHaveAccessibleDescription('Save or discard your changes first.')
  await expectAccessible(page)

  await spec.getByRole('button', { name: 'Edit' }).click()
  await spec.getByRole('button', { name: 'Discard changes' }).click()
  await expect(spec.getByText('No spec yet.')).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Write spec' })).toBeFocused()
})

test('the editor saves a changed text as the next version, and Discard drops it', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Edit a spec', SPEC)
  const { card, spec } = await openSpec(page, task.key, 'Edit a spec')
  await spec.getByRole('button', { name: 'Edit' }).click()
  const editor = spec.getByRole('textbox', { name: 'Spec' })
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(SPEC)
  for (const name of ['Save as v2', 'Preview', 'Discard changes'])
    await expect(spec.getByRole('button', { name })).toBeVisible()
  for (const name of ['Approve', 'Draft spec', 'Edit'])
    await expect(spec.getByRole('button', { name })).toHaveCount(0)
  const save = spec.getByRole('button', { name: 'Save as v2' })
  await expect(save).toBeDisabled()
  await expectAccessible(page)

  await editor.fill(`${SPEC}\n## Out of scope\nNothing.`)
  await expect(save).toBeEnabled()
  await expect(spec.getByText('Change the spec to save it as a new version.')).toHaveCount(0)

  await spec.getByRole('button', { name: 'Preview' }).click()
  await expect(
    spec.getByRole('heading', { level: 3, name: 'Spec v1 · unsaved changes' }),
  ).toBeVisible()
  await expect(spec.getByRole('heading', { level: 4, name: 'Out of scope' })).toBeVisible()
  await expect(spec.getByText('Unsaved changes. Lint runs when you save.')).toBeVisible()
  await expect(spec.getByRole('heading', { name: 'Lint' })).toHaveCount(0)
  const toApprovals = spec.getByRole('button', { name: 'Go to Approvals' })
  await expect(toApprovals).toBeDisabled()
  await expect(toApprovals).toHaveAccessibleDescription('Save or discard your changes first.')
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
  await spec.getByRole('button', { name: 'Edit' }).click()
  await expect(editor).toHaveValue(/Nothing\.$/)

  await page.mouse.move(0, 0)
  await spec.getByRole('button', { name: 'Discard changes' }).press('Enter')
  await expect(spec.getByRole('button', { name: 'Go to Approvals' })).toBeEnabled()
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · draft' })).toBeVisible()
  await expect(spec.getByRole('region', { name: 'Lint' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
  await spec.getByRole('button', { name: 'Edit' }).click()
  await expect(editor).toHaveValue(SPEC)

  await editor.fill(`${SPEC}\n## Out of scope\nNothing.`)
  await page.mouse.move(0, 0)
  await save.press('Enter')
  await expect(card.getByRole('status').filter({ hasText: /^Saved v2/ })).toBeVisible()
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v2 · draft' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
})

test('a draft locks the version select and Go to Approvals', async ({ page, request }) => {
  const task = await newTask(request, 'Lock on a draft', SPEC)
  await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: `${SPEC}\nMore.` } })
  const { spec } = await openSpec(page, task.key, 'Lock on a draft')
  const version = spec.getByRole('combobox', { name: 'Version' })
  await expect(version).toBeEnabled()
  await version.selectOption({ label: 'v1 · superseded' })
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · superseded' })).toBeVisible()
  await version.selectOption({ label: 'v2 · draft' })

  const toApprovals = spec.getByRole('button', { name: 'Go to Approvals' })
  await spec.getByRole('button', { name: 'Edit' }).click()
  const editor = spec.getByRole('textbox', { name: 'Spec' })
  await expect(toApprovals).toBeEnabled()
  await editor.fill(`${SPEC}\nMore.!`)
  await expect(toApprovals).toBeDisabled()
  await expect(toApprovals).toHaveAccessibleDescription('Save or discard your changes first.')
  await expect(version).toBeDisabled()
  await expect(
    spec.getByText('Save or discard your changes to choose another version.'),
  ).toBeVisible()

  await spec.getByRole('button', { name: 'Preview' }).click()
  await expect(toApprovals).toBeDisabled()
  await spec.getByRole('button', { name: 'Edit' }).click()
  await spec.getByRole('button', { name: 'Discard changes' }).click()
  await expect(toApprovals).toBeEnabled()
  await expect(version).toBeEnabled()
})

test('a card in Spec review opens on Approvals with the spec gate in the plan gate’s form', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'The spec gate', SPEC)
  const { card, gate } = await openApprovals(page, task.key, 'The spec gate')
  await expect(card.getByRole('tab', { name: 'Approvals' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(gate.getByRole('heading', { level: 3, name: 'Spec review' })).toBeVisible()
  await expect(gate.getByRole('heading', { level: 4, name: 'Spec v1' })).toBeVisible()
  await expect(gate.getByRole('heading', { level: 5, name: 'Goal' })).toBeVisible()
  await expect(gate.getByRole('heading', { level: 4, name: 'Lint' })).toBeVisible()
  await expect(gate.getByText('The spec lints clean: 1 requirement, 1 criterion.')).toBeVisible()
  await expect(gate.getByText('No questions yet')).toHaveCount(0)
  const group = gate.getByRole('radiogroup', { name: 'Approve spec v1, or say what to change' })
  await expect(group.getByRole('radio')).toHaveCount(1)
  await expect(group.getByRole('radio', { name: 'Approve spec' })).toBeEnabled()
  const words = gate.getByRole('textbox', { name: 'What to change' })
  await expect(words).toHaveAccessibleDescription(
    'The spec-writer redrafts from these words and the current version.',
  )
  await expectAccessible(page)

  // Focus order: Edit on the Spec tab, the two helps, the radio group, the words, Send answer.
  await tabTo(page, gate.getByRole('button', { name: 'Edit on the Spec tab' }))
  for (const name of ['Review spec', 'Explain simply']) {
    await page.keyboard.press('Tab')
    await expect(gate.getByRole('button', { name })).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(group.getByRole('radio', { name: 'Approve spec' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(gate.getByRole('button', { name: 'Clear choice' })).toBeVisible()
  await expect(
    gate.getByRole('textbox', { name: 'Note for the planner' }),
  ).toHaveAccessibleDescription(
    'The planner reads this with the approved spec. It does not change the spec.',
  )
  await page.keyboard.press('Tab')
  await expect(gate.getByRole('button', { name: 'Clear choice' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(gate.getByRole('textbox', { name: 'Note for the planner' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(gate.getByRole('button', { name: 'Send answer' })).toBeFocused()
  await expectAccessible(page)
})

test('the Spec tab sends the owner to Approvals, and Edit on the Spec tab brings the editor back', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Cross the tabs', SPEC)
  const { card, spec } = await openSpec(page, task.key, 'Cross the tabs')
  await spec.getByRole('button', { name: 'Go to Approvals' }).click()
  const approvalsTab = card.getByRole('tab', { name: 'Approvals' })
  await expect(approvalsTab).toHaveAttribute('aria-selected', 'true')
  await expect(approvalsTab).toBeFocused()

  await card
    .getByRole('tabpanel', { name: 'Approvals' })
    .getByRole('button', { name: 'Edit on the Spec tab' })
    .click()
  await expect(card.getByRole('tab', { name: 'Spec' })).toHaveAttribute('aria-selected', 'true')
  await expect(spec.getByRole('textbox', { name: 'Spec' })).toBeFocused()
  await expect(spec.getByRole('textbox', { name: 'Spec' })).toHaveValue(SPEC)
  await expectAccessible(page)
})

test('a version that does not lint clean cannot be approved: the radio says why, and Lint lists it', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Not approvable', '## Goal\nFailed deliveries back off.\n')
  const { gate } = await openApprovals(page, task.key, 'Not approvable')
  const approve = gate.getByRole('radio', { name: 'Approve spec' })
  await expect(approve).toBeDisabled()
  await expect(approve).toHaveAccessibleDescription(
    /Approve needs the latest version linting clean, with no open questions\./,
  )
  await expect(gate.getByText('The spec has no requirements.')).toBeVisible()
  await expect(gate.getByText('No questions yet')).toHaveCount(0)
  await expectAccessible(page)
})

test('Approve spec with a note approves the version with that note, and focus waits on the state line', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Approve from Approvals', SPEC)
  const { gate } = await openApprovals(page, task.key, 'Approve from Approvals')
  await gate.getByRole('radio', { name: 'Approve spec' }).check()
  await gate.getByRole('textbox', { name: 'Note for the planner' }).fill('avoid the fake clock')
  await gate.getByRole('button', { name: 'Send answer' }).click()
  await expect.poll(() => focusedText(page)).toMatch(new RegExp(`^${task.key} · `))
  await expect
    .poll(async () => {
      const specs = (await (await request.get(appUrl(`/api/tasks/${task.id}/specs`))).json()) as {
        status: string
        approval_note: string | null
      }[]
      return specs[0]?.status === 'approved' ? specs[0].approval_note : undefined
    })
    .toBe('avoid the fake clock')
  // Approve moves the card to Ready; the runner may claim it at once, so Running counts too.
  await expect
    .poll(async () => {
      const shown = (await (await request.get(appUrl(`/api/tasks/${task.id}`))).json()) as {
        state: string
      }
      return shown.state
    })
    .toMatch(/^(ready|running)$/)
})

test('words with no option redraft the spec; nothing at all is refused where the words go', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Redraft from Approvals', SPEC)
  const { gate } = await openApprovals(page, task.key, 'Redraft from Approvals')
  const posts: unknown[] = []
  await page.route('**/api/tasks/*/actions/redraft', (route) => {
    posts.push(route.request().postDataJSON())
    return refuseWith500(route)
  })
  const words = gate.getByRole('textbox', { name: 'What to change' })
  await gate.getByRole('button', { name: 'Send answer' }).click()
  await expect(words).toHaveAttribute('aria-invalid', 'true')
  await expect(words).toBeFocused()
  await expect(words).toHaveAccessibleDescription(/Write what to change, or choose Approve spec\./)
  expect(posts).toEqual([])

  await words.fill('  Say how long to wait.  ')
  await gate.getByRole('button', { name: 'Send answer' }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0]).toEqual({ note: 'Say how long to wait.' })
  await expect(page.getByRole('alert').filter({ hasText: 'That did not work.' })).toBeVisible()
})

// The note for the planner: typed beside Approve, sent with it, and filled from Review spec.
const NOTE_FIELD = 'Note for the planner'
const nextGate = (text: string, choices?: string[]) => ({
  kind: 'risk',
  where: 'Context',
  text,
  destination: 'next_gate',
  evidence: 'Context',
  ...(choices === undefined ? {} : { choices, recommended: 0 }),
})
const outsideFinding = {
  kind: 'risk',
  text: '**Where:** a\n**Found:** b\n**Problem:** c\n**Impact:** d',
  title: 'Elsewhere',
  destination: 'outside',
  evidence: 'a.ts:1',
}

/** Serves a ready Review spec result for the task, whatever the board holds. */
async function serveReview(page: Page, taskId: string, findings: object[]) {
  await page.route(`**/api/tasks/${taskId}/helps`, (route) =>
    route.fulfill({
      json: [
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          approval_id: null,
          decision: 'spec_review',
          subject: { spec_version: 1 },
          question_index: null,
          mode: 'review',
          status: 'succeeded',
          result: { mode: 'review', verdict: 'ready', blockers: 0, findings, unsure: 'u' },
          reason: null,
          created_at: '2026-11-17T10:00:00Z',
        },
      ],
    }),
  )
}

test('Use these findings chooses Approve spec and fills the note for the planner, and sends nothing', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Fill the approval note', SPEC)
  await serveReview(page, task.id, [
    nextGate('Name the clock', ['Use the fake clock', 'Use the real clock']),
    nextGate('Say how long'),
    outsideFinding,
  ])
  const { card, gate } = await openApprovals(page, task.key, 'Fill the approval note')
  const words = gate.getByRole('textbox', { name: 'What to change' })
  const use = gate.getByRole('button', { name: 'Use these findings' })
  await words.fill('Keep it small.')
  const requests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/') && req.method() !== 'GET') requests.push(req.url())
  })

  await expect(
    gate.getByRole('heading', { level: 5, name: 'Goes into the approval note' }),
  ).toBeVisible()
  await expect(gate.locator('pre')).toHaveCount(0)
  const group = (n: number) =>
    gate.getByRole('radiogroup', { name: `What to do with finding ${n}` })
  await group(1).getByRole('radio', { name: 'Use the real clock' }).click()
  await group(2).getByText('Leave out').click()
  await expect(gate.getByRole('radiogroup', { name: 'What to do with finding 3' })).toHaveCount(0)
  await use.click()
  const note = gate.getByRole('textbox', { name: NOTE_FIELD })
  await expect(note).toHaveValue(
    'Keep it small.\n\n- next gate, risk (Context): Name the clock\n  Decision: Use the real clock',
  )
  await expect(gate.getByRole('radio', { name: 'Approve spec' })).toBeChecked()
  await expect(note).toBeFocused()
  expect(
    await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length),
  ).toBe(true)
  await expect(
    card.getByRole('status').filter({ hasText: 'Findings put in Note for the planner.' }),
  ).toBeVisible()
  expect(requests).toEqual([])
  await expectAccessible(page)

  // Every finding left out: the words and the choice stay, and the status says so.
  await group(1).getByText('Leave out').click()
  await use.click()
  await expect(
    card.getByRole('status').filter({
      hasText: 'Every finding is left out; Note for the planner is unchanged.',
    }),
  ).toBeVisible()
  await expect(gate.getByRole('radio', { name: 'Approve spec' })).toBeChecked()
  expect(requests).toEqual([])
})

test('a ready review with only outside findings offers no Use these findings', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Outside only', SPEC)
  await serveReview(page, task.id, [outsideFinding])
  const { gate } = await openApprovals(page, task.key, 'Outside only')
  await expect(gate.getByRole('heading', { level: 5, name: 'Outside the task' })).toBeVisible()
  await expect(gate.getByRole('button', { name: 'Use these findings' })).toHaveCount(0)
})

test('Approve spec sends its words as the note, and blank words send no body', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Approve with a note', SPEC)
  const { gate } = await openApprovals(page, task.key, 'Approve with a note')
  await gate.getByRole('radio', { name: 'Approve spec' }).check()
  const note = gate.getByRole('textbox', { name: NOTE_FIELD })
  const send = gate.getByRole('button', { name: 'Send answer' })
  await expect(note).toHaveAccessibleDescription(
    'The planner reads this with the approved spec. It does not change the spec.',
  )

  const posts: (string | null)[] = []
  await page.route('**/api/specs/*/approve', async (route) => {
    posts.push(route.request().postData())
    await route.fulfill({ status: 500, json: { error: 'internal_error', message: 'no' } })
  })
  await note.fill('  avoid the fake clock  ')
  await send.click()
  await expect.poll(() => posts.length).toBe(1)
  expect(JSON.parse(posts[0] ?? 'null')).toEqual({ note: 'avoid the fake clock' })
  await note.fill('')
  await send.click()
  await expect.poll(() => posts.length).toBe(2)
  expect(posts[1]).toBeNull()
})

test('a refusal naming the note is shown on the field, which holds focus, and announced', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Refuse the note', SPEC)
  const { card, gate } = await openApprovals(page, task.key, 'Refuse the note')
  await page.route('**/api/specs/*/approve', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'validation_error', message: 'bad', details: { field: 'note' } },
    }),
  )
  await gate.getByRole('radio', { name: 'Approve spec' }).check()
  const note = gate.getByRole('textbox', { name: NOTE_FIELD })
  await note.fill('x'.repeat(10))
  await gate.getByRole('button', { name: 'Send answer' }).click()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expect(note).toBeFocused()
  await expect(
    card.getByRole('status').filter({ hasText: 'The note is longer than 4,000 characters.' }),
  ).toBeVisible()
  await expectAccessible(page)
})

test('an approved version shows its note for the planner, and one without a note shows none', async ({
  page,
  request,
}) => {
  const withNote = await newTask(request, 'Approved with a note', SPEC)
  const specs = (await (await request.get(appUrl(`/api/tasks/${withNote.id}/specs`))).json()) as {
    id: string
  }[]
  // Two lines, as Use these findings writes them: the break must survive on the page.
  const lines = 'avoid the fake clock\n- next gate, risk (Context): Name the clock'
  await request.post(appUrl(`/api/specs/${specs[0]!.id}/approve`), { data: { note: lines } })
  const { spec } = await openSpec(page, withNote.key, 'Approved with a note')
  const shownNote = spec.getByText('Note for the planner: avoid the fake clock')
  await expect(shownNote).toBeVisible()
  expect(await shownNote.evaluate((el) => (el as HTMLElement).innerText)).toBe(
    `Note for the planner: ${lines}`,
  )

  const without = await newTask(request, 'Approved without a note', SPEC)
  const others = (await (await request.get(appUrl(`/api/tasks/${without.id}/specs`))).json()) as {
    id: string
  }[]
  await request.post(appUrl(`/api/specs/${others[0]!.id}/approve`))
  const { spec: bare } = await openSpec(page, without.key, 'Approved without a note')
  await expect(bare.getByText('Approved v1; frozen for its runs.')).toBeVisible()
  await expect(bare.getByText('Note for the planner:')).toHaveCount(0)
})

// A step button on a Review spec result sets the choice and sends the form. These journeys press
// it in the browser and read the request it sends.
const blockerFinding = {
  kind: 'missing',
  where: 'R1',
  text: 'No retry limit',
  destination: 'blocker',
  evidence: 'R1',
}

async function serveStepReview(
  page: Page,
  taskId: string,
  result: { verdict: 'ready' | 'changes'; blockers: number; findings: object[]; next_step: string },
) {
  await page.route(`**/api/tasks/${taskId}/helps`, (route) =>
    route.fulfill({
      json: [
        {
          id: '00000000-0000-4000-8000-0000000000a2',
          approval_id: null,
          decision: 'spec_review',
          subject: { spec_version: 1 },
          question_index: null,
          mode: 'review',
          status: 'succeeded',
          result: { mode: 'review', unsure: 'u', reasoning: 'Because.', ...result },
          reason: null,
          created_at: '2026-11-17T10:00:00Z',
        },
      ],
    }),
  )
}

const refuseWith500 = (route: import('@playwright/test').Route) =>
  route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'internal_error', message: 'no' }),
  })

test('Redraft with these findings sends the redraft with the picked lines after the owner’s words', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step redraft', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'changes',
    blockers: 1,
    findings: [blockerFinding],
    next_step: 'redraft',
  })
  const { gate } = await openApprovals(page, task.key, 'Step redraft')
  await expect(gate.getByText('Next step:')).toBeVisible()
  await gate.getByRole('textbox', { name: 'What to change' }).fill('Mind the cap.')
  let body: unknown
  let calls = 0
  await page.route('**/api/tasks/*/actions/redraft', (route) => {
    calls += 1
    body = route.request().postDataJSON()
    return refuseWith500(route)
  })
  await expectAccessible(page)
  await gate.getByRole('button', { name: 'Redraft with these findings' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'That did not work.' })).toBeVisible()
  expect(calls).toBe(1)
  expect(body).toEqual({ note: 'Mind the cap.\n\n- blocker, missing (R1): No retry limit' })
  await expectAccessible(page)
})

test('Approve with these findings chooses Approve spec and sends the picked lines after the owner’s words', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step approve with note', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'ready',
    blockers: 0,
    findings: [nextGate('Name the clock')],
    next_step: 'approve_with_note',
  })
  const { gate } = await openApprovals(page, task.key, 'Step approve with note')
  await gate.getByRole('textbox', { name: 'What to change' }).fill('Keep it small.')
  let body: unknown
  let calls = 0
  await page.route('**/api/specs/*/approve', (route) => {
    calls += 1
    body = route.request().postDataJSON()
    return refuseWith500(route)
  })
  await gate.getByRole('button', { name: 'Approve with these findings' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'That did not work.' })).toBeVisible()
  expect(calls).toBe(1)
  expect(body).toEqual({
    note: 'Keep it small.\n\n- next gate, risk (Context): Name the clock',
  })
  await expect(gate.getByRole('radio', { name: 'Approve spec' })).toBeChecked()
  await expectAccessible(page)
})

test('Approve as it stands sends the words already in the field as the note', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step approve as is', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'ready',
    blockers: 0,
    findings: [],
    next_step: 'approve',
  })
  const { gate } = await openApprovals(page, task.key, 'Step approve as is')
  await gate.getByRole('textbox', { name: 'What to change' }).fill('Mind the cap.')
  let body: unknown
  await page.route('**/api/specs/*/approve', (route) => {
    body = route.request().postDataJSON()
    return refuseWith500(route)
  })
  await gate.getByRole('button', { name: 'Approve as it stands' }).click()
  await expect.poll(() => body).toEqual({ note: 'Mind the cap.' })
})

test('a Redraft step with every finding left out and nothing written sends nothing and marks the field', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step redraft blank', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'changes',
    blockers: 1,
    findings: [blockerFinding],
    next_step: 'redraft',
  })
  const { gate } = await openApprovals(page, task.key, 'Step redraft blank')
  let calls = 0
  await page.route('**/api/tasks/*/actions/redraft', (route) => {
    calls += 1
    return refuseWith500(route)
  })
  await gate
    .getByRole('radiogroup', { name: 'What to do with finding 1' })
    .getByText('Leave out')
    .click()
  await gate.getByRole('button', { name: 'Redraft with these findings' }).click()
  const field = gate.getByRole('textbox', { name: 'What to change' })
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toHaveAccessibleDescription(/Say what to change\./)
  await expect(field).toBeFocused()
  expect(calls).toBe(0)
  await expectAccessible(page)
})

test('an Approve with these findings step with nothing to write sends nothing and says what to do', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step approve blank', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'ready',
    blockers: 0,
    findings: [nextGate('Name the clock')],
    next_step: 'approve_with_note',
  })
  const { gate } = await openApprovals(page, task.key, 'Step approve blank')
  let calls = 0
  await page.route('**/api/specs/*/approve', (route) => {
    calls += 1
    return refuseWith500(route)
  })
  await gate
    .getByRole('radiogroup', { name: 'What to do with finding 1' })
    .getByText('Leave out')
    .click()
  await gate.getByRole('button', { name: 'Approve with these findings' }).click()
  const field = gate.getByRole('textbox', { name: 'Note for the planner' })
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toHaveAccessibleDescription(
    /Write the note for the planner, or choose Approve spec and press Send answer\./,
  )
  await expect(field).toBeFocused()
  expect(calls).toBe(0)
})

test('no step button is on a result of an older spec version', async ({ page, request }) => {
  const task = await newTask(request, 'Step older version', SPEC)
  await page.route(`**/api/tasks/${task.id}/helps`, (route) =>
    route.fulfill({
      json: [
        {
          id: '00000000-0000-4000-8000-0000000000a3',
          approval_id: null,
          decision: 'spec_review',
          subject: { spec_version: 0 },
          question_index: null,
          mode: 'review',
          status: 'succeeded',
          result: {
            mode: 'review',
            verdict: 'changes',
            blockers: 1,
            findings: [blockerFinding],
            unsure: 'u',
            next_step: 'redraft',
            reasoning: 'Because.',
          },
          reason: null,
          created_at: '2026-11-17T10:00:00Z',
        },
      ],
    }),
  )
  const { gate } = await openApprovals(page, task.key, 'Step older version')
  await expect(gate.getByRole('heading', { level: 3, name: 'Spec review' })).toBeVisible()
  await expect(gate.getByRole('button', { name: 'Redraft with these findings' })).toHaveCount(0)
})

test('the approve steps are disabled with the radio, each described by why, and send nothing', async ({
  page,
  request,
}) => {
  // A spec with no acceptance criteria is not approvable, so Approve spec is disabled.
  const task = await newTask(
    request,
    'Step approve disabled',
    '## Goal\nFailed deliveries back off.\n',
  )
  await serveStepReview(page, task.id, {
    verdict: 'ready',
    blockers: 0,
    findings: [nextGate('Name the clock')],
    next_step: 'approve_with_note',
  })
  const { gate } = await openApprovals(page, task.key, 'Step approve disabled')
  await expect(gate.getByRole('radio', { name: 'Approve spec' })).toBeDisabled()
  const step = gate.getByRole('button', { name: 'Approve with these findings' })
  await expect(step).toBeDisabled()
  await expect(step).toHaveAccessibleDescription(
    'Approve needs the latest version linting clean, with no open questions.',
  )
  let calls = 0
  await page.route('**/api/specs/*/approve', (route) => {
    calls += 1
    return refuseWith500(route)
  })
  await step.click({ force: true })
  expect(calls).toBe(0)
  await expectAccessible(page)
})

test('while a rephrase runs, Send answer and every step are disabled and say why', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step during a rephrase', SPEC)
  await serveStepReview(page, task.id, {
    verdict: 'changes',
    blockers: 1,
    findings: [blockerFinding],
    next_step: 'redraft',
  })
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    const response = await route.fetch()
    const json = (await response.json()) as object
    await route.fulfill({
      response,
      json: { ...json, rephrase: { status: 'running', suggestion: null, failure_reason: null } },
    })
  })
  const { gate } = await openApprovals(page, task.key, 'Step during a rephrase')
  const reason = 'Wait for the rephrase to finish, or cancel it.'
  for (const name of ['Send answer', 'Redraft with these findings']) {
    const button = gate.getByRole('button', { name })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAccessibleDescription(reason)
  }
  await expectAccessible(page)
})

test('a card that has left Spec review shows no spec gate on Approvals', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Step approve absent', SPEC)
  const specs = (await (await request.get(appUrl(`/api/tasks/${task.id}/specs`))).json()) as {
    id: string
  }[]
  expect((await request.post(appUrl(`/api/specs/${specs[0]!.id}/approve`))).ok()).toBe(true)
  await serveStepReview(page, task.id, {
    verdict: 'ready',
    blockers: 0,
    findings: [nextGate('Name the clock')],
    next_step: 'approve_with_note',
  })
  const { card } = await openSpec(page, task.key, 'Step approve absent')
  await card.getByRole('tab', { name: 'Approvals' }).click()
  const gate = card.getByRole('tabpanel', { name: 'Approvals' })
  await expect(gate.getByRole('heading', { name: 'Spec review' })).toHaveCount(0)
  await expect(gate.getByRole('button', { name: 'Approve with these findings' })).toHaveCount(0)
  await expect(gate.getByRole('radio', { name: 'Approve spec' })).toHaveCount(0)
  await expectAccessible(page)
})
