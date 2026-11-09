import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime, tabTo } from './helpers'

// A description rephrased from the code: Rephrase description queues a rephrase run, the
// rephraser suggests, and the owner accepts (as written or edited) or discards. The fake
// rephraser picks its script by the task's title (see global-setup.ts).
const RUN = { timeout: 30_000 }
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })
const OWN = 'Retry webhooks.'
const SUGGESTED =
  'Retry failed webhook deliveries with delays of 1, 2 and 4 seconds (src/retry.ts). Unsure: whether a 429 counts as a failure.'

async function newTask(request: APIRequestContext, title: string, description = OWN) {
  await registerProject(request, draft())
  const response = await request.post(appUrl('/api/projects/DFT/tasks'), {
    data: { title, description_md: description },
  })
  return (await response.json()) as { id: string; key: string }
}

async function openCard(page: Page, key: string) {
  await page.goto(appUrl('/p/DFT'))
  await page.getByRole('link', { name: new RegExp(`^${key} `) }).click(RUN)
  const card = page.getByRole('dialog')
  return { card, spec: card.getByRole('tabpanel', { name: 'Spec' }) }
}

const rephraseOf = async (request: APIRequestContext, id: string) =>
  (
    (await (await request.get(appUrl(`/api/tasks/${id}`))).json()) as {
      rephrase: { status: string; suggestion: unknown } | null
    }
  ).rephrase

test('a suggested description is accepted by keyboard, edited, with the in-flight state accessible', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Rephrase slowly: webhooks')
  const { card, spec } = await openCard(page, key)
  const description = spec.getByRole('textbox', { name: 'Description', exact: true })
  await expect(description).toHaveValue(OWN)

  const rephrase = spec.getByRole('button', { name: 'Rephrase description' })
  await tabTo(page, rephrase)
  await page.keyboard.press('Enter')
  await expect(spec.getByText('The rephraser is reading the code.').first()).toBeVisible()
  const cancel = spec.getByRole('button', { name: 'Cancel rephrase' })
  await expect(cancel).toBeFocused()
  await expect(spec.getByRole('button', { name: 'Rephrase description' })).toHaveCount(0)
  for (const name of ['Draft spec']) {
    const button = spec.getByRole('button', { name })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAccessibleDescription(
      'Wait for the rephrase to finish, or cancel it.',
    )
  }
  await expectAccessible(page)

  const suggestion = spec.getByRole('textbox', { name: 'Suggestion text' })
  await expect(suggestion).toHaveValue(SUGGESTED, RUN)
  await expect(spec.getByRole('heading', { name: 'Suggested description' })).toBeVisible()
  await expect(
    card.getByRole('status').filter({ hasText: 'A suggested description is ready.' }),
  ).toBeVisible()
  await expect(description).toHaveValue(OWN)
  await expect(spec.getByText('Written from an earlier version of your description.')).toHaveCount(
    0,
  )
  await expectAccessible(page)

  await suggestion.fill('Retry failed webhooks, edited by the owner.')
  const accept = spec.getByRole('button', { name: 'Accept suggestion' })
  await tabTo(page, accept)
  await page.keyboard.press('Enter')
  await expect(
    card.getByRole('status').filter({ hasText: 'Description replaced with the suggestion.' }),
  ).toBeVisible()
  await expect(description).toBeFocused()
  await expect(description).toHaveValue('Retry failed webhooks, edited by the owner.')
  await expect(spec.getByRole('textbox', { name: 'Suggestion text' })).toHaveCount(0)
  await expect(spec.getByRole('button', { name: 'Rephrase description' })).toBeVisible()
})

test('a discard leaves the description alone, and focus returns to it', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Rephrase one: discard')
  const { card, spec } = await openCard(page, key)
  await spec.getByRole('button', { name: 'Rephrase description' }).click()
  await expect(spec.getByRole('textbox', { name: 'Suggestion text' })).toHaveValue(SUGGESTED, RUN)
  await spec.getByRole('button', { name: 'Discard suggestion' }).click()
  await expect(card.getByRole('status').filter({ hasText: 'Suggestion discarded.' })).toBeVisible()
  const description = spec.getByRole('textbox', { name: 'Description', exact: true })
  await expect(description).toBeFocused()
  await expect(description).toHaveValue(OWN)
  await expect(spec.getByRole('textbox', { name: 'Suggestion text' })).toHaveCount(0)
})

test('a description typed and not saved is saved before the run starts', async ({
  page,
  request,
}) => {
  const created = await newTask(request, 'Rephrase one: unsaved')
  const { spec } = await openCard(page, created.key)
  await spec.getByRole('textbox', { name: 'Description', exact: true }).fill('Typed words.')
  await spec.getByRole('button', { name: 'Rephrase description' }).click()
  await expect(spec.getByRole('textbox', { name: 'Suggestion text' })).toHaveValue(SUGGESTED, RUN)
  const task = (await (await request.get(appUrl(`/api/tasks/${created.id}`))).json()) as {
    description_md: string
  }
  expect(task.description_md).toBe('Typed words.')
})

test('a blank description is marked, focused, and sends no request', async ({ page, request }) => {
  const { key } = await newTask(request, 'Rephrase one: blank')
  const { spec } = await openCard(page, key)
  const description = spec.getByRole('textbox', { name: 'Description', exact: true })
  await description.fill('   ')
  const sent: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') sent.push(r.url())
  })
  await spec.getByRole('button', { name: 'Rephrase description' }).click()
  await expect(
    spec.getByText('Write a description first; the rephraser works from it.'),
  ).toBeVisible()
  await expect(description).toHaveAttribute('aria-invalid', 'true')
  await expect(description).toBeFocused()
  expect(sent).toEqual([])
})

test('a suggestion written from an earlier description says so, and stacks at 320 px', async ({
  page,
  request,
}) => {
  const created = await newTask(request, 'Rephrase one: stale')
  await request.post(appUrl(`/api/tasks/${created.id}/actions/rephrase`))
  await expect
    .poll(async () => (await rephraseOf(request, created.id))?.suggestion, RUN)
    .not.toBeNull()
  await request.patch(appUrl(`/api/tasks/${created.id}`), {
    data: { description_md: 'Changed since.' },
  })
  await page.setViewportSize({ width: 320, height: 900 })
  const { spec } = await openCard(page, created.key)
  await expect(spec.getByText('Written from an earlier version of your description.')).toBeVisible()
  const description = spec.getByRole('textbox', { name: 'Description', exact: true })
  const suggestion = spec.getByRole('textbox', { name: 'Suggestion text' })
  const above = (await description.boundingBox())!
  const below = (await suggestion.boundingBox())!
  expect(below.y).toBeGreaterThanOrEqual(above.y + above.height)
  // The card, not the board behind it: the Spec tab and the dialog hold nothing wider than they are.
  for (const container of [spec, page.getByRole('dialog')])
    expect(await container.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await expectAccessible(page)
})

test('a run that saves nothing says so, and a cancelled one says nothing', async ({
  page,
  request,
}) => {
  const { key } = await newTask(request, 'Rephrase nothing: webhooks')
  const { spec } = await openCard(page, key)
  await spec.getByRole('button', { name: 'Rephrase description' }).click()
  await expect(
    spec.getByText('The last rephrase did not finish: the rephraser saved no suggestion.'),
  ).toBeVisible(RUN)
  await expectAccessible(page)

  const slow = await newTask(request, 'Rephrase slowly: cancel')
  const second = await openCard(page, slow.key)
  await second.spec.getByRole('button', { name: 'Rephrase description' }).click()
  await second.spec.getByRole('button', { name: 'Cancel rephrase' }).click()
  const description = second.spec.getByRole('textbox', { name: 'Description', exact: true })
  await expect(description).toBeFocused()
  await expect(second.spec.getByRole('button', { name: 'Rephrase description' })).toBeVisible()
  await expect(second.spec.getByText('The last rephrase did not finish')).toHaveCount(0)
})
