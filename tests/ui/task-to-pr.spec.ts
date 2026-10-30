import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, focusedText, runtime, SPEC } from './helpers'

test('a task goes from the board to a pull request, with its steps and costs on the card', async ({
  page,
  request,
}) => {
  await page.goto(appUrl('/'))
  await expect(page).toHaveTitle('Projects · AI Delivery Platform')
  await expectAccessible(page)

  const fields: [string, string][] = [
    ['Key', 'PAY'],
    ['Name', 'Payments'],
    ['Repository path', runtime().repoPath],
    ['GitHub repository', 'owner/pay'],
    ['Base branch', 'main'],
  ]
  for (const [name, value] of fields)
    await page.getByRole('textbox', { name, exact: true }).fill(value)
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'PAY registered.' })).toBeVisible()
  // A registered project tests with `npm test`; this repository checks for a file instead.
  const commands = (await (
    await request.get(appUrl('/api/projects/PAY/test-commands'))
  ).json()) as {
    id: string
    is_default: boolean
  }[]
  const patched = await request.patch(
    appUrl(`/api/projects/PAY/test-commands/${commands.find((c) => c.is_default)!.id}`),
    { data: { command: 'test -f src/retry.ts' } },
  )
  expect(patched.ok()).toBe(true)
  await expectAccessible(page)

  await page.getByRole('link', { name: 'PAY Payments' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'PAY · Payments' })).toBeFocused()
  await page.getByRole('textbox', { name: 'New task title' }).fill('Back off retries')
  await page.getByRole('button', { name: 'Add task' }).click()
  const backlog = page.getByRole('region', { name: 'Backlog' })
  await expect(backlog.getByRole('link', { name: /^PAY-1 Back off retries/ })).toBeVisible()
  await expectAccessible(page)

  await backlog.getByRole('link', { name: /^PAY-1 / }).click()
  const card = page.getByRole('dialog', { name: 'Back off retries' })
  await expect(card).toBeVisible()
  await expect(page).toHaveTitle('PAY-1 Back off retries · AI Delivery Platform')
  await expectAccessible(page)

  await card.getByRole('textbox', { name: 'Spec' }).fill(SPEC)
  await card.getByRole('button', { name: 'Save as v1' }).click()
  await expect(
    card.getByRole('status').filter({ hasText: 'Saved v1. It lints clean and can be approved.' }),
  ).toBeVisible()
  await expect(card.getByRole('region', { name: 'Lint' })).toContainText(
    'The spec lints clean: 1 requirement, 1 criterion.',
  )
  await card.getByRole('button', { name: 'Approve' }).click()

  // The runner claims it, runs three phases with the fake claude, pushes and opens the PR; the
  // open card hears of each move over the event stream, with no reload, and says so.
  await expect(card.getByRole('status').filter({ hasText: 'PAY-1 is now in Review.' })).toBeVisible(
    { timeout: 90_000 },
  )

  await card.getByRole('tab', { name: 'Timeline' }).click()
  const timeline = card.getByRole('tabpanel', { name: 'Timeline' })
  for (const phase of ['plan', 'build', 'verify'])
    await expect(
      timeline.getByRole('region', { name: new RegExp(`^${phase} · attempt 1`) }),
    ).toBeVisible()
  await expect(timeline).toContainText('Edit src/retry.ts')
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'Cost' }).click()
  await expect(card.getByRole('tabpanel', { name: 'Cost' })).toContainText('Total $')
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  const pr = card.getByRole('tabpanel', { name: 'PR', exact: true })
  await expect(pr.getByRole('link', { name: /^Pull request #7/ })).toBeVisible()
  // owner/pay is not on GitHub, so `gh` cannot list the files: the tab says so in words.
  await expect(pr).toContainText('GitHub did not list the files; they are on the pull request.')
  await expect(pr.getByRole('table', { name: 'Verify report' })).toContainText('pass')
  await expectAccessible(page)

  // Mark done stands in for the drag to Done, and hands focus to the state line as it goes.
  await card.getByRole('button', { name: 'Mark done' }).click()
  await expect.poll(() => focusedText(page)).toBe('PAY-1 · Done')
  await expect(card.getByRole('status').filter({ hasText: 'PAY-1 is now in Done.' })).toBeVisible()

  // The card left Backlog while it was open; closing hands focus to its link in Done.
  await card.getByRole('button', { name: 'Close' }).click()
  await expect(
    page.getByRole('region', { name: 'Done' }).getByRole('link', { name: /^PAY-1 / }),
  ).toBeFocused()
  await expectAccessible(page)
})

test('a drag the table does not allow is refused with a reason, and nothing moves', async ({
  page,
}) => {
  await page.goto(appUrl('/p/PAY'))
  await page.getByRole('textbox', { name: 'New task title' }).fill('Something else')
  await page.getByRole('button', { name: 'Add task' }).click()
  const card = page.getByRole('region', { name: 'Backlog' }).getByRole('link', { name: /^PAY-2 / })
  await card.dragTo(page.getByRole('region', { name: 'Ready' }))
  await expect(
    page.getByRole('status').filter({ hasText: 'Only a card in Review can be dragged' }),
  ).toBeVisible()
  await expect(card).toBeVisible()
  await expectAccessible(page)
})
