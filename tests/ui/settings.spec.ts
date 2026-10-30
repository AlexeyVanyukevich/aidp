import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { appUrl, expectAccessible } from './helpers'

/** A project of its own, so no other journey sees the commands this one adds. */
async function project(request: APIRequestContext): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), 'settings-repo-'))
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'git@github.com:owner/settings.git'])
  const key = `S${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const response = await request.post(appUrl('/api/projects'), {
    data: {
      key,
      name: 'Settings',
      repo_path: path,
      github_repo: 'owner/settings',
      base_branch: 'main',
    },
  })
  expect(response.ok()).toBe(true)
  return key
}

test('the settings page is reached from the board and lists the default command', async ({
  page,
  request,
}) => {
  const key = await project(request)
  await page.goto(appUrl(`/p/${key}`))
  await page.getByRole('link', { name: `Settings of ${key}` }).click()
  await expect(page).toHaveURL(appUrl(`/p/${key}/settings`))
  await expect(page.getByRole('heading', { level: 1, name: `${key} settings` })).toBeFocused()
  await expect(page.getByRole('link', { name: `Board of ${key}` })).toHaveAttribute(
    'href',
    `/p/${key}`,
  )
  const list = page.getByRole('list', { name: `Test commands of ${key}` })
  const item = list.getByRole('listitem')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('tests')
  await expect(item).toContainText('npm test')
  await expect(item).toContainText('Default')
  await expect(item.getByRole('button', { name: 'Edit tests' })).toBeVisible()
  await expect(item.getByRole('button', { name: /Make .* the default/ })).toHaveCount(0)
  await expect(item.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expectAccessible(page)
})

test('the heading and Board link show while the list loads, and an unknown key is a failure', async ({
  page,
  request,
}) => {
  const key = await project(request)
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(`**/api/projects/${key}/test-commands`, async (route) => {
    await held
    return route.continue()
  })
  await page.goto(appUrl(`/p/${key}/settings`))
  await expect(page.getByRole('heading', { level: 1, name: `${key} settings` })).toBeVisible()
  await expect(page.getByRole('link', { name: `Board of ${key}` })).toBeVisible()
  await expect(page.locator('.zl-loading')).toBeVisible()
  release()
  await expect(page.getByRole('list', { name: `Test commands of ${key}` })).toBeVisible()

  await page.goto(appUrl('/p/NOPE/settings'))
  await expect(page.getByRole('heading', { level: 1, name: 'NOPE settings' })).toBeVisible()
  await expect(page.getByText('This project could not be loaded.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
})

test('a command is added, edited, made the default and removed by keyboard alone', async ({
  page,
  request,
}) => {
  const key = await project(request)
  await page.goto(appUrl(`/p/${key}/settings`))
  const status = page.getByRole('status').filter({ hasText: /.+/ })
  const name = page.getByRole('textbox', { name: 'Name', exact: true })

  await name.focus()
  await page.keyboard.type('unit')
  await page.keyboard.press('Tab')
  await page.keyboard.type('npm run unit')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'unit added.' })).toBeVisible()
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('')

  // A taken name is refused on the field, case aside.
  await page.keyboard.type('UNIT')
  await page.keyboard.press('Tab')
  await page.keyboard.type('npm run other')
  await page.keyboard.press('Enter')
  await expect(name).toBeFocused()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toHaveAccessibleDescription(
    'Use 1 to 40 characters that no other test command of this project uses.',
  )
  await expectAccessible(page)
  await name.fill('')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill('')

  const edit = page.getByRole('button', { name: 'Edit unit' })
  await edit.focus()
  await page.keyboard.press('Enter')
  const editName = page.getByRole('textbox', { name: 'Name of unit' })
  await expect(editName).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Command of unit' })).toHaveValue('npm run unit')
  await editName.fill('units')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'units saved.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit units' })).toBeFocused()

  await page.getByRole('button', { name: 'Edit units' }).press('Enter')
  await page.getByRole('button', { name: 'Cancel' }).press('Enter')
  await expect(page.getByRole('button', { name: 'Edit units' })).toBeFocused()

  await page.getByRole('button', { name: 'Make units the default' }).press('Enter')
  await expect(
    page.getByRole('status').filter({ hasText: 'units is now the default.' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit units' })).toBeFocused()

  await page.getByRole('button', { name: 'Remove tests' }).press('Enter')
  await expect(
    status.filter({ hasText: 'tests removed. Tasks that chose it now use the default.' }),
  ).toBeVisible()
  await expect(page.getByRole('list', { name: `Test commands of ${key}` })).toBeFocused()
  await expectAccessible(page)
})

test('a failed removal is reported in the list’s alert, which takes focus', async ({
  page,
  request,
}) => {
  const key = await project(request)
  await request.post(appUrl(`/api/projects/${key}/test-commands`), {
    data: { name: 'unit', command: 'npm run unit' },
  })
  await page.route(`**/api/projects/${key}/test-commands/*`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'x' }),
        })
      : route.continue(),
  )
  await page.goto(appUrl(`/p/${key}/settings`))
  await page.getByRole('button', { name: 'Remove unit' }).click()
  const alert = page.getByRole('alert').filter({ hasText: 'could not be removed' })
  await expect(alert).toHaveText('The test command could not be removed. Try again.')
  await expect(alert).toBeFocused()
})
