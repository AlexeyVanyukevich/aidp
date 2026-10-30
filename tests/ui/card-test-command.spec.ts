import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { appUrl } from './helpers'

/** A project with `unit` beside its default, and a Backlog card the runner leaves alone. */
async function seeded(request: APIRequestContext) {
  const path = mkdtempSync(join(tmpdir(), 'choice-repo-'))
  execFileSync('git', ['init', '-q', path])
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'git@github.com:owner/choice.git'])
  const key = `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const registered = await request.post(appUrl('/api/projects'), {
    data: {
      key,
      name: 'Choice',
      repo_path: path,
      github_repo: 'owner/choice',
      base_branch: 'main',
    },
  })
  expect(registered.ok()).toBe(true)
  const unit = (await (
    await request.post(appUrl(`/api/projects/${key}/test-commands`), {
      data: { name: 'unit', command: 'npm run unit' },
    })
  ).json()) as { id: string }
  const task = (await (
    await request.post(appUrl(`/api/projects/${key}/tasks`), { data: { title: 'Choose' } })
  ).json()) as { id: string; key: string }
  return { key, unit: unit.id, task: task.id, taskKey: task.key }
}

test('the test command is chosen on the card, saved at once, and offers new commands', async ({
  page,
  request,
}) => {
  const { key, unit, task, taskKey } = await seeded(request)
  await page.goto(appUrl(`/p/${key}/${task}`))
  const select = page.getByRole('combobox', { name: 'Test command' })
  await expect(select).toHaveAccessibleDescription(
    'Project default follows the project if its default changes; a named command does not. A run that has started keeps the command it started with.',
  )
  await expect(select.locator('option')).toHaveText(['Project default (tests)', 'tests', 'unit'])

  await select.focus()
  // Type-ahead lands on `unit` in one change, so one save is in flight.
  await page.keyboard.press('u')
  await expect(
    page.getByRole('status').filter({ hasText: `${taskKey} will test with unit.` }),
  ).toBeVisible()
  await expect(select).toBeFocused()
  const saved = (await (await request.get(appUrl(`/api/tasks/${task}`))).json()) as {
    test_command_id: string
  }
  expect(saved.test_command_id).toBe(unit)

  await select.selectOption({ label: 'Project default (tests)' })
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `${taskKey} will test with the project default (tests).` }),
  ).toBeVisible()

  await request.post(appUrl(`/api/projects/${key}/test-commands`), {
    data: { name: 'lint', command: 'npm run lint' },
  })
  await expect(select.locator('option', { hasText: 'lint' })).toHaveCount(1)
})

test('a failed save is reported in the problem region and the saved choice shows again', async ({
  page,
  request,
}) => {
  const { key, task } = await seeded(request)
  await page.route(`**/api/tasks/${task}`, (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'internal_error', message: 'x' }),
        })
      : route.continue(),
  )
  await page.goto(appUrl(`/p/${key}/${task}`))
  const select = page.getByRole('combobox', { name: 'Test command' })
  await select.selectOption({ label: 'unit' })
  const problem = page.getByRole('alert').filter({ hasText: 'That did not work. Try again.' })
  await expect(problem).toBeFocused()
  await expect(select).toHaveValue('')
  await expect(select.locator('option:checked')).toHaveText('Project default (tests)')
})

test('a card marked Done by hand has no select and says no run tested it', async ({
  page,
  request,
}) => {
  const { key, task } = await seeded(request)
  expect(
    (await request.patch(appUrl(`/api/tasks/${task}`), { data: { state: 'done' } })).ok(),
  ).toBe(true)
  await page.goto(appUrl(`/p/${key}/${task}`))
  await expect(page.getByText('No run tested this task.')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Test command' })).toHaveCount(0)
})
