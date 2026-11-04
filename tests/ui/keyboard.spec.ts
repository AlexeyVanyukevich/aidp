import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, focusInDialog, runtime, SPEC, tabTo } from './helpers'

const CLEAN_SPEC = `${SPEC.replace(
  '## Requirements',
  `## Context
See [the retry guide](https://example.com/retries).

| Delay | Seconds |
| --- | --- |
| first | 1 |

\`\`\`
retry(1)
\`\`\`

## Requirements`,
)}`

test('a repository, the board and a card work from the keyboard alone', async ({ page }) => {
  await page.goto(appUrl('/'))
  const key = page.getByRole('textbox', { name: 'Key', exact: true })
  await tabTo(page, key)

  // Fill the form field by field; the key is lower case, which the schema refuses.
  await page.keyboard.type('ops')
  for (const value of ['Ops', runtime().opsPath, 'owner/ops', 'main', 'test -f src/retry.ts']) {
    await page.keyboard.press('Tab')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(value)
  }
  await page.keyboard.press('Enter')

  // The refusal hands focus back to the field it names, which now says why.
  await expect(key).toBeFocused()
  await expect(key).toHaveAttribute('aria-invalid', 'true')
  await expect(key).toHaveAccessibleDescription(/capital letters/)
  await expectAccessible(page)

  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('OPS')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'OPS registered.' })).toBeVisible()

  await tabTo(page, page.getByRole('link', { name: 'OPS Ops' }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'OPS · Ops' })).toBeFocused()

  const title = page.getByRole('textbox', { name: 'New task title' })
  await tabTo(page, title)
  // A slow board: the refetch after each add takes a second. The next title is typed and sent
  // as soon as the first is announced, as a quick keyboard user would, and must not be dropped.
  // The handler stays; the flag ends the delay, so no request in flight is cut off.
  let slow = true
  await page.route('**/api/projects/OPS/tasks', async (route) => {
    if (slow && route.request().method() === 'GET')
      await new Promise((done) => setTimeout(done, 1_000))
    await route.continue()
  })
  for (const [name, n] of [
    ['First', 1],
    ['Second', 2],
  ] as const) {
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('status').filter({ hasText: `OPS-${n} added to Backlog.` }),
    ).toBeVisible()
    await expect(title).toBeFocused()
    await expect(title).toHaveValue('')
  }
  slow = false

  const backlog = page.getByRole('region', { name: 'Backlog' })
  await tabTo(page, backlog.getByRole('link', { name: /^OPS-2 / }))
  await page.keyboard.press('Enter')
  const card = page.getByRole('dialog', { name: 'Second' })
  await expect(card).toBeVisible()
  expect(await focusInDialog(page)).toBe(true)
  await expectAccessible(page)

  // Move up stands in for the drag that reorders a column.
  await tabTo(page, card.getByRole('button', { name: 'Move up' }))
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: 'OPS-2 moved up in Backlog.' }),
  ).toBeVisible()

  // Arrow keys move between tabs; Tab moves on into the panel.
  const specTab = card.getByRole('tab', { name: 'Spec' })
  await tabTo(page, specTab)
  await page.keyboard.press('ArrowRight')
  await expect(card.getByRole('tab', { name: 'Plan' })).toBeFocused()
  await expect(card.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(specTab).toBeFocused()
  // The panel opens on the task's description, then the spec (slice 3 spec, §11).
  await page.keyboard.press('Tab')
  await expect(card.getByRole('textbox', { name: 'Description' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Save description' })).toBeFocused()
  await page.keyboard.press('Tab')
  // An empty card offers Write spec, which opens the editor on the template.
  await expect(card.getByRole('button', { name: 'Write spec' })).toBeFocused()
  await page.keyboard.press('Enter')
  const editor = card.getByRole('textbox', { name: 'Spec' })
  await expect(editor).toBeFocused()
  await expectAccessible(page)
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(CLEAN_SPEC)
  await tabTo(page, card.getByRole('button', { name: 'Save as v1' }))
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: 'Saved v1. It lints clean and can be approved.' }),
  ).toBeVisible()
  const edit = card.getByRole('button', { name: 'Edit' })
  await expect(edit).toBeFocused()
  await expectAccessible(page)

  // Back through the rendered spec: its code block, its table and its link scroll or link, so
  // each is a tab stop, before the version select.
  await page.keyboard.press('Shift+Tab')
  await expect(card.getByRole('group', { name: 'Code block' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(card.getByRole('group', { name: 'Table' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(card.getByRole('link', { name: 'the retry guide' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(card.getByRole('combobox', { name: 'Version' })).toBeFocused()

  // The card is in Spec review: Edit, Approve, the note, Redraft.
  await expect(card.getByText('OPS-2 · Spec review')).toBeVisible()
  await tabTo(page, edit)
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Approve' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('textbox', { name: 'What to change' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Redraft' })).toBeFocused()

  // The editor opened on an unchanged text: no draft, so Save as is skipped and Redraft stops.
  await edit.focus()
  await page.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Preview' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Discard changes' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('textbox', { name: 'What to change' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Redraft' })).toBeFocused()

  // With a draft, Save as is a stop and Redraft is not; Preview and Discard hand focus to Edit.
  await editor.focus()
  await page.keyboard.type('x')
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Save as v2' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card.getByRole('button', { name: 'Preview' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(edit).toBeFocused()
  await expectAccessible(page)
  await page.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  await tabTo(page, card.getByRole('button', { name: 'Discard changes' }))
  await page.keyboard.press('Enter')
  await expect(edit).toBeFocused()

  // Saving the spec moved the card to Spec review while it was open. Escape closes the card and
  // hands focus to its link there, the one that replaced the link that opened it.
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await expect(
    page.getByRole('region', { name: 'Spec review' }).getByRole('link', { name: /^OPS-2 / }),
  ).toBeFocused()
  await expect(backlog.getByRole('link')).toHaveText([/^OPS-1 /])
})
