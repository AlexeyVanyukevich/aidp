import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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
    ['Test command', 'true'],
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

/** Registers a project of its own on the Projects page and returns its key and list item. */
async function registered(page: Page) {
  const key = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  await page.goto(appUrl('/'))
  const fields: [string, string][] = [
    ['Key', key],
    ['Name', 'Tested'],
    ['Repository path', repository()],
    ['GitHub repository', 'owner/setup'],
    ['Base branch', 'main'],
    ['Test command', 'true'],
  ]
  for (const [name, value] of fields)
    await page.getByRole('textbox', { name, exact: true }).fill(value)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('status').filter({ hasText: `${key} registered.` })).toBeVisible()
  const item = page.getByRole('listitem').filter({ hasText: `${key} Tested` })
  return { key, item }
}

const PROBLEM = 'This command does not run in that repository.'

test.describe('a project’s test command on the Projects page', () => {
  test('is reached in order, and opens a form on the stored command', async ({ page }) => {
    const { key, item } = await registered(page)
    await expect(item).toContainText('Test command: true')
    await item.getByRole('link', { name: `${key} Tested` }).focus()
    await page.keyboard.press('Tab')
    await expect(item.getByRole('button', { name: `Edit test command of ${key}` })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(item.getByRole('button', { name: `Edit setup command of ${key}` })).toBeFocused()

    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    const field = item.getByRole('textbox', { name: `Test command of ${key}` })
    await expect(field).toBeFocused()
    await expect(field).toHaveValue('true')
    await expect(field).toHaveAccessibleDescription('Runs in the repository after every Build.')
    await page.keyboard.press('Tab')
    await expect(item.getByRole('button', { name: 'Save' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(item.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await expectAccessible(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('main')).toHaveCount(1)
  })

  test('is saved with only the test command, announced, and focus returns', async ({ page }) => {
    const { key, item } = await registered(page)
    let body: unknown
    await page.route(`**/api/projects/${key}`, (route) => {
      if (route.request().method() === 'PATCH') body = route.request().postDataJSON()
      return route.continue()
    })
    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    await item.getByRole('textbox', { name: `Test command of ${key}` }).fill('echo ok')
    await item.getByRole('button', { name: 'Save' }).click()
    await expect(item).toContainText('Test command: echo ok')
    expect(body).toEqual({ test_command: 'echo ok' })
    await expect(item.getByRole('button', { name: `Edit test command of ${key}` })).toBeFocused()
    await expect(
      page.getByRole('status').filter({ hasText: `${key}’s test command is now echo ok.` }),
    ).toBeVisible()
  })

  test('ignores a second click while saving', async ({ page }) => {
    const { key, item } = await registered(page)
    let requests = 0
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route(`**/api/projects/${key}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      requests += 1
      await held
      return route.continue()
    })
    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    const save = item.getByRole('button', { name: 'Save' })
    await save.click()
    await expect(save).toHaveAttribute('aria-busy', 'true')
    await save.click({ force: true })
    release()
    await expect(item).toContainText('Test command: true')
    expect(requests).toBe(1)
  })

  test('is left alone by Cancel', async ({ page }) => {
    const { key, item } = await registered(page)
    let requests = 0
    await page.route(`**/api/projects/${key}`, (route) => {
      if (route.request().method() === 'PATCH') requests += 1
      return route.continue()
    })
    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    await item.getByRole('textbox', { name: `Test command of ${key}` }).fill('echo ok')
    await item.getByRole('button', { name: 'Cancel' }).click()
    await expect(item).toContainText('Test command: true')
    await expect(item.getByRole('button', { name: `Edit test command of ${key}` })).toBeFocused()
    await expect(page.getByRole('status').filter({ hasText: 'test command is now' })).toHaveCount(0)
    expect(requests).toBe(0)
  })

  test('is refused on its field when it does not run', async ({ page }) => {
    const { key, item } = await registered(page)
    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    const field = item.getByRole('textbox', { name: `Test command of ${key}` })
    await field.fill('no-such-tool-anywhere')
    await item.getByRole('button', { name: 'Save' }).click()
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(field).toHaveAccessibleDescription(new RegExp(PROBLEM))
    await expectAccessible(page)
  })

  test('reports another failure in a live region that was already there', async ({ page }) => {
    const { key, item } = await registered(page)
    await page.route(`**/api/projects/${key}`, (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'internal_error', message: 'x' }),
          })
        : route.continue(),
    )
    await item.getByRole('button', { name: `Edit test command of ${key}` }).click()
    // The form's own region comes first in the item and is empty until the save fails.
    const region = item.getByRole('alert').first()
    await expect(region).toHaveText('')
    await item.getByRole('button', { name: 'Save' }).click()
    await expect(region).toHaveText('The test command could not be saved. Try again.')
    await expect(item.getByRole('textbox', { name: `Test command of ${key}` })).toBeVisible()
  })
})
