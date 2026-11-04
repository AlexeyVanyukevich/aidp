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

  await spec.getByRole('button', { name: 'Discard changes' }).click()
  await expect(spec.getByRole('heading', { level: 3, name: 'Spec v1 · draft' })).toBeVisible()
  await expect(spec.getByRole('region', { name: 'Lint' })).toBeVisible()
  await expect(spec.getByRole('button', { name: 'Edit' })).toBeFocused()
  await spec.getByRole('button', { name: 'Edit' }).click()
  await expect(editor).toHaveValue(SPEC)

  await editor.fill(`${SPEC}\n## Out of scope\nNothing.`)
  await save.click()
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
