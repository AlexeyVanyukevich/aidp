import { expect, test } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, focusedText, runtime, tabTo } from './helpers'

// A run takes a few seconds with the fake claude; three failed attempts take longer.
const RUN = { timeout: 90_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

test('a Failed card with an accepted plan offers to keep it, or to plan again', async ({
  page,
  request,
}) => {
  const key = await approvedTask(request, ask(), 'Fail after a confident plan')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Failed' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: 'Fail after a confident plan' })
  const keep = card.getByRole('button', { name: 'Re-run with this plan' })
  const again = card.getByRole('button', { name: 'Re-run and plan again' })
  await expect(keep).toBeVisible()
  await expect(again).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run', exact: true })).toHaveCount(0)
  await expectAccessible(page)

  // Both are reachable by keyboard, in order.
  await tabTo(page, keep)
  await page.keyboard.press('Tab')
  await expect(again).toBeFocused()

  await page.keyboard.press('Shift+Tab')
  await expect(keep).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: `${key} re-run with the plan` }),
  ).toBeVisible()
  expect(await focusedText(page)).toContain(key)
})

test('a Failed card with no plan to keep offers only planning again', async ({ page, request }) => {
  const key = await approvedTask(request, ask(), 'Cancel at the plan gate')
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: 'Cancel at the plan gate' })
  await card.getByRole('button', { name: 'Cancel run' }).click()
  await expect(card.getByText(`${key} · Failed`)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run and plan again' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Re-run with this plan' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Re-run', exact: true })).toHaveCount(0)
  await expectAccessible(page)
})
