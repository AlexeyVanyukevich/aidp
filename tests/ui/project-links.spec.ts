import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { appUrl, expectAccessible, registerProject } from './helpers'

/** A repository of its own, whose remote is the one the project names. */
function repository(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `link-${name}-`))
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `git@github.com:owner/${name}.git`])
  return path
}

const project = (key: string, name: string) => ({
  key,
  name,
  path: repository(name),
  repo: `owner/${name}`,
})

/** The project's own entry on the page, found by its link: a link entry holds none. */
const entry = (page: Page, key: string) =>
  page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(`^${key} `) }) })

test('a project is linked to another and unlinked on the Projects page, by keyboard', async ({
  page,
  request,
}) => {
  await registerProject(request, project('LKA', 'linka'))
  await registerProject(request, project('LKB', 'linkb'))
  await page.goto(appUrl('/'))
  const mine = entry(page, 'LKA')
  const target = mine.getByRole('combobox', { name: 'Link LKA to' })
  const note = mine.getByRole('textbox', { name: 'Note on the link from LKA' })
  const add = mine.getByRole('button', { name: 'Add link' })

  // AC8: an empty note is refused on its field, which takes the focus.
  await target.selectOption('LKB')
  await add.click()
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expect(mine.getByRole('button', { name: 'Remove link to LKB' })).toHaveCount(0)

  // AC7: by keyboard alone.
  await target.focus()
  await page.keyboard.press('Tab')
  await expect(note).toBeFocused()
  await page.keyboard.type('the second repository')
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(mine).toContainText('LKB')
  await expect(mine).toContainText('the second repository')
  await expect(page.getByRole('status').filter({ hasText: 'LKA now links to LKB.' })).toBeVisible()
  await expect(target.locator('option', { hasText: 'LKB' })).toHaveCount(0)
  await expect(entry(page, 'LKB').getByRole('button', { name: /Remove link to/ })).toHaveCount(0)
  await expectAccessible(page)

  await mine.getByRole('button', { name: 'Remove link to LKB' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'LKA no longer links to LKB.' }),
  ).toBeVisible()
  await expect(mine.getByRole('button', { name: 'Remove link to LKB' })).toHaveCount(0)
  await expect(target.locator('option', { hasText: 'LKB' })).toHaveCount(1)
  await expectAccessible(page)
})
