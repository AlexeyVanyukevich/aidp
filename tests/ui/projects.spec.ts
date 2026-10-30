import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible } from './helpers'

/** A repository of its own, so this journey registers a project no other journey uses. */
function repository(): string {
  const path = mkdtempSync(join(tmpdir(), 'setup-repo-'))
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'git@github.com:owner/setup.git'])
  return path
}

test('a project’s setup command is registered, edited and cleared on the Projects page', async ({
  page,
}) => {
  await page.goto(appUrl('/'))
  const fields: [string, string][] = [
    ['Key', 'SET'],
    ['Name', 'Setup'],
    ['Repository path', repository()],
    ['GitHub repository', 'owner/setup'],
    ['Base branch', 'main'],
    ['Setup command', 'true'],
  ]
  for (const [name, value] of fields)
    await page.getByRole('textbox', { name, exact: true }).fill(value)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'SET registered.' })).toBeVisible()

  const item = page.getByRole('listitem').filter({ hasText: 'SET Setup' })
  await expect(item).toContainText('Setup command: true')

  await item.getByRole('button', { name: 'Edit setup command of SET' }).click()
  const field = item.getByRole('textbox', { name: 'Setup command of SET' })
  await expect(field).toBeFocused()

  // A command that does not resolve is refused on the field, which keeps the focus.
  await field.fill('no-such-tool-anywhere')
  await item.getByRole('button', { name: 'Save' }).click()
  await expect(field).toBeFocused()
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toHaveAccessibleDescription(/does not run in that repository/)
  await expectAccessible(page)

  await field.fill('echo installed')
  await item.getByRole('button', { name: 'Save' }).click()
  await expect(item).toContainText('Setup command: echo installed')

  await item.getByRole('button', { name: 'Edit setup command of SET' }).click()
  await item.getByRole('textbox', { name: 'Setup command of SET' }).fill('')
  await item.getByRole('button', { name: 'Save' }).click()
  await expect(item).toContainText('No setup command')
})

test('registering offers no test command, and shows the default one', async ({ page }) => {
  const key = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  await page.goto(appUrl('/'))
  await expect(page.getByRole('textbox', { name: 'Test command' })).toHaveCount(0)
  const fields: [string, string][] = [
    ['Key', key],
    ['Name', 'Tested'],
    ['Repository path', repository()],
    ['GitHub repository', 'owner/setup'],
    ['Base branch', 'main'],
  ]
  for (const [name, value] of fields)
    await page.getByRole('textbox', { name, exact: true }).fill(value)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(
    page.getByRole('status').filter({
      hasText: `${key} registered. It tests with npm test; change that in its settings.`,
    }),
  ).toBeVisible()
  const item = page.getByRole('listitem').filter({ hasText: `${key} Tested` })
  await expect(item).toContainText('Default test command: tests (npm test)')
  await expect(item.getByRole('button', { name: `Edit test command of ${key}` })).toHaveCount(0)
  await expect(item.getByRole('button', { name: `Edit setup command of ${key}` })).toBeVisible()
  await expectAccessible(page)
})
