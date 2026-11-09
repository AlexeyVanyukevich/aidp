import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { appUrl, expectAccessible, registerProject } from './helpers'

const repositories = new Map<string, string>()
function repository(key: string): string {
  let path = repositories.get(key)
  if (path === undefined) {
    path = mkdtempSync(join(tmpdir(), 'prioritise-repo-'))
    execFileSync('git', ['init', '-q', path])
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `git@github.com:owner/${key}.git`])
    repositories.set(key, path)
  }
  return path
}

async function register(request: APIRequestContext, key: string): Promise<void> {
  await registerProject(request, {
    key,
    name: `Project ${key}`,
    path: repository(key),
    repo: `owner/${key.toLowerCase()}`,
  })
}

async function addTasks(
  request: APIRequestContext,
  key: string,
  positions: number[],
): Promise<string[]> {
  const ids: string[] = []
  for (const [index, position] of positions.entries()) {
    const created = await request.post(appUrl(`/api/projects/${key}/tasks`), {
      data: { title: `Card ${index + 1}` },
    })
    const task = (await created.json()) as { id: string }
    const patched = await request.patch(appUrl(`/api/tasks/${task.id}`), { data: { position } })
    expect(patched.ok()).toBe(true)
    ids.push(task.id)
  }
  return ids
}

const prioritise = (page: Page) => page.getByRole('button', { name: 'Prioritise' })
const region = (page: Page) => page.locator('.announce')

interface Record {
  text: string
  frame: number
}

/** Stamps every change of the live region with the number of frames painted so far. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __log: Record[] }
    w.__frames = 0
    w.__log = []
    const tick = () => {
      w.__frames += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const status = document.querySelector('.announce')!
    new MutationObserver(() =>
      w.__log.push({ text: status.textContent ?? '', frame: w.__frames }),
    ).observe(status, { childList: true, characterData: true, subtree: true })
  })
}

const log = (page: Page) =>
  page.evaluate(() => (window as unknown as { __log: Record[] }).__log.slice())

const mark = async (page: Page) => (await log(page)).length

/** From `since` on: the region empty, then `text`, with at least two frames between. */
async function expectEmptyThen(page: Page, since: number, text: string): Promise<void> {
  // The region may already read `text`, so the outcome is awaited in the log, not in the DOM.
  await expect
    .poll(async () => (await log(page)).slice(since).filter((r) => r.text === text).length)
    .toBeGreaterThan(0)
  const records = (await log(page)).slice(since)
  const empty = records.findIndex((r) => r.text === '')
  expect(empty).toBeGreaterThanOrEqual(0)
  const written = records.slice(empty + 1).filter((r) => r.text === text)
  expect(written).toHaveLength(1)
  expect(written[0]!.frame - records[empty]!.frame).toBeGreaterThanOrEqual(2)
}

const cardTitles = (page: Page) =>
  page.getByRole('region', { name: 'Backlog' }).getByRole('listitem').allInnerTexts()

function reorderRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/tasks/reorder')) seen.push(r.url())
  })
  return seen
}

test('prioritising keeps the order, announces each press again, and holds focus', async ({
  page,
  request,
}) => {
  await register(request, 'PRA')
  await addTasks(request, 'PRA', [0.5, 0.25, 7, 0.125])
  await page.goto(appUrl('/p/PRA'))
  await expect(page.getByRole('region', { name: 'Backlog' }).getByRole('listitem')).toHaveCount(4)
  const before = await cardTitles(page)

  await prioritise(page).click()
  await expect(region(page)).toHaveText('4 tasks reordered.')
  await expect.poll(() => cardTitles(page)).toEqual(before)
  await expect(prioritise(page)).toBeFocused()
  await expect(prioritise(page)).toHaveAttribute('type', 'button')

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expectAccessible(page)

  await watch(page)
  let since = await mark(page)
  await prioritise(page).click()
  await expectEmptyThen(page, since, 'The tasks were already in order.')
  since = await mark(page)
  await prioritise(page).click()
  await expectEmptyThen(page, since, 'The tasks were already in order.')

  // A held request: the button is busy and the earlier message stays.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/tasks/reorder', async (route) => {
    await held
    await route.continue()
  })
  await prioritise(page).click()
  await expect(prioritise(page)).toHaveAttribute('aria-busy', 'true')
  await expect(region(page)).toHaveText('The tasks were already in order.')
  release()
  await expect(prioritise(page)).not.toHaveAttribute('aria-busy', 'true')
  await expect(prioritise(page)).toBeFocused()
})

test('a failed reorder is announced', async ({ page, request }) => {
  await register(request, 'PRE')
  await page.route('**/tasks/reorder', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'internal_error', message: 'boom' }),
    }),
  )
  await addTasks(request, 'PRE', [3])
  await page.goto(appUrl('/p/PRE'))
  await expect(page.getByRole('region', { name: 'Backlog' }).getByRole('listitem')).not.toHaveCount(
    0,
  )
  await prioritise(page).click()
  await expect(region(page)).toHaveText('The board could not be reordered. Try again.')
  await expect(prioritise(page)).toBeFocused()
})

test('a single changed task is counted in the singular', async ({ page, request }) => {
  await register(request, 'PRC')
  await addTasks(request, 'PRC', [1, 5])
  await page.goto(appUrl('/p/PRC'))
  const answered = page.waitForResponse((r) => r.url().endsWith('/tasks/reorder'))
  await prioritise(page).click()
  expect(await (await answered).json()).toEqual({ reordered: 1 })
  await expect(region(page)).toHaveText('1 task reordered.')
})

test('an empty board sends nothing and announces every press', async ({ page, request }) => {
  await register(request, 'PRB')
  const seen = reorderRequests(page)
  await page.goto(appUrl('/p/PRB'))
  await expect(page.getByRole('region', { name: 'Backlog' })).toBeVisible()
  await watch(page)
  await prioritise(page).click()
  await expect(region(page)).toHaveText('There are no tasks to reorder.')
  const since = await mark(page)
  await prioritise(page).click()
  await expectEmptyThen(page, since, 'There are no tasks to reorder.')
  expect(seen).toEqual([])
})

test('two presses in one task announce once, after an empty frame', async ({ page, request }) => {
  await register(request, 'PRB')
  await page.goto(appUrl('/p/PRB'))
  await expect(page.getByRole('region', { name: 'Backlog' })).toBeVisible()
  await prioritise(page).click()
  await expect(region(page)).toHaveText('There are no tasks to reorder.')
  await watch(page)
  const since = await mark(page)
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Prioritise',
    )!
    button.click()
    button.click()
  })
  await expectEmptyThen(page, since, 'There are no tasks to reorder.')
})

const UNLOADED: [string, (page: Page) => Promise<void>][] = [
  [
    'the board request fails',
    (page) => page.route('**/api/projects/PRB/tasks', (route) => route.abort()),
  ],
  [
    'the board request is held',
    (page) => page.route('**/api/projects/PRB/tasks', () => new Promise<void>(() => undefined)),
  ],
]

for (const [name, arrange] of UNLOADED) {
  test(`${name}: nothing is sent and every press is announced`, async ({ page, request }) => {
    await register(request, 'PRB')
    const seen = reorderRequests(page)
    await arrange(page)
    await page.goto(appUrl('/p/PRB'))
    await expect(prioritise(page)).toBeVisible()
    await watch(page)
    await prioritise(page).click()
    await expect(region(page)).toHaveText('The board has not loaded yet.')
    const since = await mark(page)
    await prioritise(page).click()
    await expectEmptyThen(page, since, 'The board has not loaded yet.')
    expect(seen).toEqual([])
  })
}

test('Tab reaches the button last, and Enter in the title does not press it', async ({
  page,
  request,
}) => {
  await register(request, 'PRB')
  const seen = reorderRequests(page)
  await page.goto(appUrl('/p/PRB'))
  const heading = page.getByRole('heading', { level: 1 })
  await heading.focus()
  await expect(heading).toBeFocused()
  const name = (locator: Locator) => locator.evaluate((e) => e === document.activeElement)
  const order = [
    page.getByRole('link', { name: 'Settings of PRB' }),
    page.getByRole('textbox', { name: 'New task title' }),
    page.getByRole('button', { name: 'Add task' }),
    prioritise(page),
  ]
  for (const target of order) {
    await page.keyboard.press('Tab')
    expect(await name(target)).toBe(true)
  }
  expect(await name(heading)).toBe(false)
  await page.getByRole('textbox', { name: 'New task title' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Enter a title.')).toBeVisible()
  expect(seen).toEqual([])
})

const WIDTHS = [320, 700, 1280]
for (const width of WIDTHS) {
  test(`Prioritise sits after Add task and is not stretched: ${width} wide`, async ({
    page,
    request,
  }) => {
    await register(request, 'PRG')
    await page.setViewportSize({ width, height: 900 })
    await page.goto(appUrl('/p/PRG'))
    const input = page.getByRole('textbox', { name: 'New task title' })
    const add = page.getByRole('button', { name: 'Add task' })
    await expect(input).toBeVisible()

    const measure = async () => {
      const box = async (l: Locator) => (await l.boundingBox())!
      const [p, a, i] = [await box(prioritise(page)), await box(add), await box(input)]
      const extra = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Prioritise',
        )!
        const probe = document.createElement('div')
        probe.style.marginTop = 'var(--zl-space-3)'
        document.body.append(probe)
        const space = parseFloat(getComputedStyle(probe).marginTop)
        probe.remove()
        const before = button.style.width
        button.style.width = 'max-content'
        const natural = button.getBoundingClientRect().width
        button.style.width = before
        const head = document.querySelector('.board-head')!
        return {
          space,
          natural,
          width: button.getBoundingClientRect().width,
          margin: getComputedStyle(button).marginBlockStart,
          noScroll: head.scrollWidth <= head.clientWidth,
        }
      })
      const error = page.getByText('Enter a title.')
      const e = (await error.count()) > 0 ? await box(error) : undefined
      return { p, a, i, e, ...extra }
    }
    const check = async () => {
      const m = await measure()
      expect(Math.abs(m.width - m.natural)).toBeLessThanOrEqual(1)
      expect(m.noScroll).toBe(true)
      if (width >= 700) {
        expect(Math.abs(m.p.y - m.a.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(m.p.y + m.p.height - (m.a.y + m.a.height))).toBeLessThanOrEqual(1)
        expect(m.p.x).toBeGreaterThanOrEqual(m.a.x + m.a.width - 1)
        expect(m.margin).toBe('0px')
      } else {
        const above = m.e ? m.e.y + m.e.height : m.i.y + m.i.height
        expect(Math.abs(m.p.y - (above + m.space))).toBeLessThanOrEqual(1)
        expect(Math.abs(m.p.x - m.i.x)).toBeLessThanOrEqual(1)
      }
    }
    await check()
    await add.click()
    await expect(page.getByText('Enter a title.')).toBeVisible()
    await check()
  })
}
