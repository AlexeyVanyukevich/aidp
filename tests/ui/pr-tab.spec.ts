import { expect, test } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime, SPEC } from './helpers'

// A run takes a few seconds with the fake claude.
const RUN = { timeout: 90_000 }
const project = () => ({ key: 'ASK', name: 'Asks', path: runtime().askPath, repo: 'owner/ask' })

const OWNER_SPEC = SPEC.replace(
  '\n## Open questions',
  '- AC2 (R1, owner): Given the banner When it shows Then it reads well in a browser\n\n## Open questions',
)

async function approve(
  request: import('@playwright/test').APIRequestContext,
  title: string,
  body: string,
): Promise<string> {
  await registerProject(request, project())
  const task = (await (
    await request.post(appUrl('/api/projects/ASK/tasks'), { data: { title } })
  ).json()) as { id: string; key: string }
  const spec = (await (
    await request.post(appUrl(`/api/tasks/${task.id}/specs`), { data: { body_md: body } })
  ).json()) as { id: string }
  expect((await request.post(appUrl(`/api/specs/${spec.id}/approve`))).ok()).toBe(true)
  return task.key
}

async function openPrTab(page: import('@playwright/test').Page, key: string, title: string) {
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Review' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  return card.getByRole('tabpanel', { name: 'PR', exact: true })
}

test('an owner verdict shows as a badge, with a sentence above the table', async ({
  page,
  request,
}) => {
  const title = 'Hand check at the PR'
  const key = await approve(request, title, OWNER_SPEC)
  const pr = await openPrTab(page, key, title)
  const table = pr.getByRole('table', { name: 'Verify report' })
  await expect(table).toBeVisible(RUN)
  await expect(table.getByRole('row', { name: /^AC2/ })).toContainText('owner')
  const badge = table.getByRole('row', { name: /^AC2/ }).locator('.zl-badge')
  await expect(badge).toHaveText('owner')
  await expect(badge).toHaveClass(/warning/)
  const sentence = pr.getByText('1 criterion is yours to check: AC2.')
  await expect(sentence).toBeVisible()
  const before = await sentence.evaluate(
    (p, t) => !!(p.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
    await table.elementHandle(),
  )
  expect(before).toBe(true)
  await expectAccessible(page)
})

test('a report with no owner verdict has no such sentence', async ({ page, request }) => {
  const title = 'Nothing for the owner'
  const key = await approve(request, title, SPEC)
  const pr = await openPrTab(page, key, title)
  await expect(pr.getByRole('table', { name: 'Verify report' })).toBeVisible(RUN)
  await expect(pr.getByText('yours to check')).toHaveCount(0)
  await expect(pr.getByText('Withdrawn by the owner')).toHaveCount(0)
})

const TWO_CRITERIA = SPEC.replace(
  '\n## Open questions',
  '- AC2 (R1): Given the banner When it shows Then it reads well\n\n## Open questions',
)

test('a withdrawn verdict shows as a badge, with the owner’s words above the table', async ({
  page,
  request,
}) => {
  const title = 'Withdraw a criterion'
  const key = await approve(request, title, TWO_CRITERIA)
  await page.goto(appUrl('/p/ASK'))
  await page
    .getByRole('region', { name: 'Needs approval' })
    .getByRole('link', { name: new RegExp(`^${key} `) })
    .click(RUN)
  const card = page.getByRole('dialog', { name: title })
  const panel = card.getByRole('tabpanel', { name: 'Approvals' })
  await panel
    .getByRole('textbox', { name: 'Changes to ask for' })
    .fill('Drop AC2: the banner is gone.')
  await panel.getByRole('button', { name: 'Send answer' }).click()
  // Approving is a radio like any other, sent with Send answer.
  await panel.getByRole('radio', { name: 'Approve plan' }).check()
  await panel.getByRole('button', { name: 'Send answer' }).click(RUN)
  await expect(card.getByText(`${key} · Review`)).toBeVisible(RUN)

  await card.getByRole('tab', { name: 'PR', exact: true }).click()
  const pr = card.getByRole('tabpanel', { name: 'PR', exact: true })
  const table = pr.getByRole('table', { name: 'Verify report' })
  await expect(table).toBeVisible(RUN)
  const badge = table.getByRole('row', { name: /^AC2/ }).locator('.zl-badge')
  await expect(badge).toHaveText('withdrawn')
  await expect(pr.getByText('Withdrawn by the owner at the plan gate:')).toBeVisible()
  const item = pr.getByRole('listitem').filter({ hasText: 'AC2 — Drop AC2: the banner is gone.' })
  await expect(item).toBeVisible()
  const before = await item.evaluate(
    (li, t) => !!(li.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
    await table.elementHandle(),
  )
  expect(before).toBe(true)
  await expectAccessible(page)
})
