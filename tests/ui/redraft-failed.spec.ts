import { expect, test } from '@playwright/test'
import { appUrl, approvedTask, expectAccessible, focusedText, runtime, tabTo } from './helpers'

const RUN = { timeout: 90_000 }
const ask = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

// AIDP-55: a Failed card goes back to its spec, by keyboard.
test('Redraft spec on a Failed card needs a note, then sends the card to the spec-writer', async ({
  page,
  request,
}) => {
  const title = 'Fail after a confident plan'
  const key = await approvedTask(request, ask(), title)
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Failed' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  const again = card.getByRole('button', { name: 'Re-run and plan again' })
  const redraft = card.getByRole('button', { name: 'Redraft spec' })
  const note = card.getByLabel('Note for the next run')
  await expect(redraft).toBeVisible()
  await expect(card.getByText('Sent with either Re-run button, or with Redraft spec')).toBeVisible()
  await expectAccessible(page)

  // The button follows Re-run and plan again in the Tab order.
  await tabTo(page, again)
  await page.keyboard.press('Tab')
  await expect(redraft).toBeFocused()

  // An empty note sends nothing: the field says why, and takes focus.
  await page.keyboard.press('Enter')
  await expect(card.getByText('Say what to change in the spec.').first()).toBeVisible()
  await expect(note).toBeFocused()
  await expect(note).toHaveAttribute('aria-invalid', 'true')
  await expect(card.getByText(`${key} · Failed`)).toBeVisible()

  await note.fill('AC4 is wrong')
  await tabTo(page, redraft)
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: `${key} goes back to the spec-writer.` }),
  ).toBeVisible(RUN)
  expect(await focusedText(page)).toContain(key)
})
