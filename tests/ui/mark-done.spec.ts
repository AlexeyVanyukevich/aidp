import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime, SPEC, tabTo } from './helpers'

const project = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

async function addTask(
  request: import('@playwright/test').APIRequestContext,
  title: string,
): Promise<{ id: string; key: string }> {
  await registerProject(request, project())
  return (await (
    await request.post(appUrl('/api/projects/ASK/tasks'), { data: { title } })
  ).json()) as { id: string; key: string }
}

test('a Backlog card is marked done by keyboard, and its PR tab says it closed without one', async ({
  page,
  request,
}) => {
  const task = await addTask(request, 'Fixed outside the board')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Backlog' })
    .getByRole('link', { name: new RegExp(`^${task.key} `) })
    .click()
  const card = page.getByRole('dialog', { name: 'Fixed outside the board' })
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'Spec' }).click()
  await expect(
    card.getByRole('tabpanel', { name: 'Spec' }).getByRole('button', { name: 'Mark done' }),
  ).toHaveCount(0)

  const markDone = card.getByRole('button', { name: 'Mark done' })
  await tabTo(page, card.getByRole('button', { name: 'Move down' }))
  await page.keyboard.press('Tab')
  await expect(markDone).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByRole('dialog', { name: 'Confirm' })).toHaveCount(0)
  await expect(
    card.getByRole('status').filter({ hasText: `${task.key} is now in Done.` }),
  ).toBeVisible()
  await expect(card.getByText(`${task.key} · Done`)).toBeFocused()
  await expect(markDone).toHaveCount(0)
  await expect(
    page
      .getByRole('region', { name: 'Done' })
      .getByRole('link', { name: new RegExp(`^${task.key} `) }),
  ).toBeVisible()
  await expectAccessible(page)

  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  await expect(card.getByText('Closed without a pull request.')).toBeVisible()
  await expect(card.getByText('No pull request yet')).toHaveCount(0)
  await expectAccessible(page)
})

test('a card that moved meanwhile gets the notice, with focus', async ({ page, request }) => {
  const task = await addTask(request, 'Moves under the owner')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Backlog' })
    .getByRole('link', { name: new RegExp(`^${task.key} `) })
    .click()
  const card = page.getByRole('dialog', { name: 'Moves under the owner' })
  await expect(card.getByRole('button', { name: 'Mark done' })).toBeVisible()

  // Another actor approves a spec before the owner's click reaches the server.
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const spec = (await (
        await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: SPEC } })
      ).json()) as { id: string }
      await request.post(appUrl(`/api/specs/${spec.id}/approve`))
    }
    await route.continue()
  })
  await card.getByRole('button', { name: 'Mark done' }).click()
  const notice = card.getByText('This card changed meanwhile; its latest state is shown.')
  await expect(notice).toBeVisible()
  await expect(
    card.getByRole('alert').filter({ hasText: 'This card changed meanwhile' }),
  ).toBeFocused()
  await expect(card.getByText(`${task.key} · Done`)).toHaveCount(0)
})
