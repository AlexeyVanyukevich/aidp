import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, registerProject, runtime, SPEC } from './helpers'

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

test('a spec in review opens formatted, with Edit and Approve, and no editor', async ({
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
  await expect(spec.getByRole('button', { name: 'Approve' })).toBeVisible()
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
  await expect(spec.getByRole('button', { name: 'Approve' })).toBeDisabled()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
  await spec.getByRole('button', { name: 'Edit' }).click()
  await expect(editor).toHaveValue(/Nothing\.$/)

  // A long fade makes a reused Approve button visibly mid-transition when read.
  await page.addStyleTag({ content: ':root { --zl-duration: 10s; }' })
  const approve = spec.getByRole('button', { name: 'Approve' })
  const expectApproveAtRest = async (): Promise<void> => {
    await expect(approve).toBeEnabled()
    const reading = await approve.evaluate((el) => {
      const probe = document.createElement('div')
      probe.style.cssText =
        'background-color: var(--zl-accent); color: var(--zl-on-accent); transition: none'
      ;(el.closest('[role="dialog"], aside, main') ?? document.body).appendChild(probe)
      const rest = getComputedStyle(probe)
      const resting = { background: rest.backgroundColor, color: rest.color }
      probe.remove()
      const own = getComputedStyle(el)
      return {
        animations: el.getAnimations().length,
        background: own.backgroundColor,
        color: own.color,
        resting,
      }
    })
    expect(reading.animations).toBe(0)
    expect(reading.background).toBe(reading.resting.background)
    expect(reading.color).toBe(reading.resting.color)
  }

  await page.mouse.move(0, 0)
  await spec.getByRole('button', { name: 'Discard changes' }).press('Enter')
  await expectApproveAtRest()
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · draft' })).toBeVisible()
  await expect(spec.getByRole('region', { name: 'Lint' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
  await spec.getByRole('button', { name: 'Edit' }).click()
  await expect(editor).toHaveValue(SPEC)

  await editor.fill(`${SPEC}\n## Out of scope\nNothing.`)
  await page.mouse.move(0, 0)
  await save.press('Enter')
  await expectApproveAtRest()
  await expect(card.getByRole('status').filter({ hasText: /^Saved v2/ })).toBeVisible()
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v2 · draft' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await expectAccessible(page)
})

test('a draft locks the version select and Redraft, and keeps the note typed', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Lock on a draft', SPEC)
  await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: `${SPEC}\nMore.` } })
  const { spec } = await openSpec(page, task.key, 'Lock on a draft')
  const version = spec.getByRole('combobox', { name: 'Version' })
  await expect(version).toBeEnabled()
  await version.selectOption({ label: 'v1 · superseded' })
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · superseded' })).toBeVisible()
  await version.selectOption({ label: 'v2 · draft' })

  const note = spec.getByRole('textbox', { name: 'What to change' })
  await note.fill('fix R2')
  const redraft = spec.getByRole('button', { name: 'Redraft' })
  await spec.getByRole('button', { name: 'Edit' }).click()
  const editor = spec.getByRole('textbox', { name: 'Spec' })
  await expect(redraft).toBeEnabled()
  await editor.fill(`${SPEC}\nMore.!`)
  await expect(redraft).toBeDisabled()
  await expect(redraft).toHaveAccessibleDescription('Save or discard your changes first.')
  await expect(version).toBeDisabled()
  await expect(
    spec.getByText('Save or discard your changes to choose another version.'),
  ).toBeVisible()
  await note.pressSequentially(' and R3')
  await expect(note).toHaveValue('fix R2 and R3')

  await spec.getByRole('button', { name: 'Preview' }).click()
  await expect(redraft).toBeDisabled()
  await spec.getByRole('button', { name: 'Edit' }).click()
  await spec.getByRole('button', { name: 'Discard changes' }).click()
  await expect(redraft).toBeEnabled()
  await expect(version).toBeEnabled()
  await expect(note).toHaveValue('fix R2 and R3')
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

test('Use these findings fills the note for the planner, from a ready review, and sends nothing', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Fill the approval note', SPEC)
  await serveReview(page, task.id, [
    nextGate('Name the clock', ['Use the fake clock', 'Use the real clock']),
    nextGate('Say how long'),
    outsideFinding,
  ])
  const { spec } = await openSpec(page, task.key, 'Fill the approval note')
  const note = spec.getByRole('textbox', { name: NOTE_FIELD })
  const redraft = spec.getByRole('textbox', { name: 'What to change' })
  const use = spec.getByRole('button', { name: 'Use these findings' })
  await note.fill('Keep it small.')
  await redraft.fill('unchanged')
  const requests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/') && req.method() !== 'GET') requests.push(req.url())
  })

  await expect(
    spec.getByRole('heading', { level: 5, name: 'Goes into the approval note' }),
  ).toBeVisible()
  await expect(spec.locator('pre')).toHaveCount(0)
  const group = (n: number) =>
    spec.getByRole('radiogroup', { name: `What to do with finding ${n}` })
  await group(1).getByRole('radio', { name: 'Use the real clock' }).click()
  await group(2).getByText('Leave out').click()
  await expect(spec.getByRole('radiogroup', { name: 'What to do with finding 3' })).toHaveCount(0)
  await use.click()
  await expect(note).toHaveValue(
    'Keep it small.\n\n- next gate, risk (Context): Name the clock\n  Decision: Use the real clock',
  )
  await expect(redraft).toHaveValue('unchanged')
  await expect(note).toBeFocused()
  expect(
    await note.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length),
  ).toBe(true)
  await expect(spec.getByRole('status').first()).toHaveText('Findings put in Note for the planner.')
  expect(requests).toEqual([])
  await expectAccessible(page)
})

test('a ready review with only outside findings offers no Use these findings', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Outside only', SPEC)
  await serveReview(page, task.id, [outsideFinding])
  const { spec } = await openSpec(page, task.key, 'Outside only')
  await expect(spec.getByRole('heading', { level: 5, name: 'Outside the task' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Use these findings' })).toHaveCount(0)
})

test('Approve sends the note for the planner, comes right after it, and an empty note sends no body', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Approve with a note', SPEC)
  const { spec } = await openSpec(page, task.key, 'Approve with a note')
  const note = spec.getByRole('textbox', { name: NOTE_FIELD })
  const approve = spec.getByRole('button', { name: 'Approve' })
  await expect(note).toHaveAccessibleDescription(
    'The planner reads this with the approved spec. It does not change the spec.',
  )
  // The field is the control right before Approve in the tab order.
  await note.focus()
  await page.keyboard.press('Tab')
  await expect(approve).toBeFocused()

  const posts: (string | null)[] = []
  await page.route('**/api/specs/*/approve', async (route) => {
    posts.push(route.request().postData())
    await route.fulfill({ status: 500, json: { error: 'internal_error', message: 'no' } })
  })
  await note.fill('avoid the fake clock')
  await approve.click()
  await expect.poll(() => posts.length).toBe(1)
  expect(JSON.parse(posts[0] ?? 'null')).toEqual({ note: 'avoid the fake clock' })
  await note.fill('')
  await approve.click()
  await expect.poll(() => posts.length).toBe(2)
  expect(posts[1]).toBeNull()
})

test('a refusal naming the note is shown on the field, which holds focus, and announced', async ({
  page,
  request,
}) => {
  const task = await newTask(request, 'Refuse the note', SPEC)
  const { spec } = await openSpec(page, task.key, 'Refuse the note')
  await page.route('**/api/specs/*/approve', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'validation_error', message: 'bad', details: { field: 'note' } },
    }),
  )
  const note = spec.getByRole('textbox', { name: NOTE_FIELD })
  await note.fill('x'.repeat(10))
  await spec.getByRole('button', { name: 'Approve' }).click()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expect(note).toBeFocused()
  await expect(spec.getByRole('status').first()).toHaveText(
    'The note is longer than 4,000 characters.',
  )
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
