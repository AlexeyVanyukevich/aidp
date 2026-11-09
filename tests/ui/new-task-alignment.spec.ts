import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, tabTo } from './helpers'

const LONG_NAME = 'A project whose name is long enough to wrap onto several lines of the header'

interface Layout {
  label: string
  key: string
  name: string
  width: number
}

const LAYOUTS: Layout[] = [
  { label: 'wide, short name', key: 'NTA', name: 'Short', width: 1280 },
  { label: 'medium, wrapping name', key: 'NTB', name: LONG_NAME, width: 700 },
  { label: 'narrow, wrapping name', key: 'NTB', name: LONG_NAME, width: 320 },
]

/** One repository of its own per key, so no other journey's project shares its path. */
const repositories = new Map<string, string>()
function repository(key: string): string {
  let path = repositories.get(key)
  if (path === undefined) {
    path = mkdtempSync(join(tmpdir(), 'align-repo-'))
    execFileSync('git', ['init', '-q', path])
    execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `git@github.com:owner/${key}.git`])
    repositories.set(key, path)
  }
  return path
}

const project = (key: string, name: string) => ({
  key,
  name,
  path: repository(key),
  repo: `owner/${key.toLowerCase()}`,
})

async function open(page: Page, layout: Layout, request: Parameters<typeof registerProject>[0]) {
  await registerProject(request, project(layout.key, layout.name))
  await page.setViewportSize({ width: layout.width, height: 900 })
  await page.goto(appUrl(`/p/${layout.key}`))
  const input = page.getByRole('textbox', { name: 'New task title' })
  await expect(input).toBeVisible()
  return {
    input,
    button: page.getByRole('button', { name: 'Add task' }),
    prioritise: page.getByRole('button', { name: 'Prioritise' }),
    heading: page.getByRole('heading', { level: 1 }),
    settings: page.getByRole('link', { name: `Settings of ${layout.key}` }),
    notice: page.getByRole('status'),
    columns: page.locator('.columns').first(),
    head: page.locator('.board-head'),
  }
}

async function box(locator: import('@playwright/test').Locator) {
  const b = await locator.boundingBox()
  expect(b).not.toBeNull()
  return b!
}

for (const layout of LAYOUTS) {
  test(`the new-task form stays aligned with and without its error: ${layout.label}`, async ({
    page,
    request,
  }) => {
    const ui = await open(page, layout, request)
    const noScroll = () =>
      page.evaluate(() => {
        const head = document.querySelector('.board-head')!
        const form = document.querySelector('.new-task')!.getBoundingClientRect()
        return head.scrollWidth <= head.clientWidth && form.right <= window.innerWidth
      })

    const input0 = await box(ui.input)
    const button0 = await box(ui.button)
    const heading0 = await box(ui.heading)
    const head0 = await box(ui.head)
    const columns0 = await box(ui.columns)
    const prioritise0 = await box(ui.prioritise)
    expect(Math.abs(button0.y + button0.height - (input0.y + input0.height))).toBeLessThanOrEqual(1)
    expect(Math.abs(button0.y - input0.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(button0.height - input0.height)).toBeLessThanOrEqual(1)
    // At 320 the button has its own row under the form, so the head ends at its bottom.
    const headEnd = layout.width === 320 ? prioritise0 : input0
    expect(Math.abs(head0.y + head0.height - (headEnd.y + headEnd.height))).toBeLessThanOrEqual(1)
    expect(await noScroll()).toBe(true)
    // The link is as wide as its text, so the header's empty space does not open Settings.
    const [linkWidth, textWidth] = await ui.settings.evaluate((link) => {
      const text = document.createRange()
      text.selectNodeContents(link)
      return [link.getBoundingClientRect().width, text.getBoundingClientRect().width]
    })
    expect(Math.abs(linkWidth - textWidth)).toBeLessThanOrEqual(1)

    await ui.button.click()
    const error = page.getByText('Enter a title.')
    await expect(error).toBeVisible()
    const errorBox = await box(error)
    const input1 = await box(ui.input)
    const button1 = await box(ui.button)
    const heading1 = await box(ui.heading)
    const columns1 = await box(ui.columns)
    const notice = await box(ui.notice)

    expect(errorBox.y).toBeGreaterThanOrEqual(input1.y + input1.height - 1)
    expect(Math.abs(button1.y + button1.height - (input1.y + input1.height))).toBeLessThanOrEqual(1)
    expect(Math.abs(button1.y - input1.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(button1.height - input1.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(input1.y - input0.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(button1.y - button0.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(heading1.y - heading0.y)).toBeLessThanOrEqual(1)
    // The error overlaps neither the status notice nor the columns, which start lower.
    expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(notice.y + 1)
    expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(columns1.y + 1)
    expect(columns1.y).toBeGreaterThan(columns0.y)
    expect(await noScroll()).toBe(true)
  })
}

test('the error is described and invalid, and the board has no axe violations', async ({
  page,
  request,
}) => {
  const ui = await open(page, LAYOUTS[0]!, request)
  await ui.button.click()
  await expect(ui.input).toBeFocused()
  await expect(ui.input).toHaveAttribute('aria-invalid', 'true')
  await expect(ui.input).toHaveAccessibleDescription('Enter a title.')
  await expectAccessible(page)
})

const FOCUS_WAYS: {
  way: string
  focus: (page: Page, input: import('@playwright/test').Locator) => Promise<void>
}[] = [
  { way: 'Tab', focus: (page, input) => tabTo(page, input) },
  { way: 'click', focus: (_page, input) => input.click() },
]

for (const { way, focus } of FOCUS_WAYS) {
  test(`focusing the empty title by ${way} shows no error`, async ({ page, request }) => {
    const ui = await open(page, LAYOUTS[0]!, request)
    await focus(page, ui.input)
    await expect(ui.input).toBeFocused()
    await expect(page.getByText('Enter a title.')).toHaveCount(0)
    await expect(ui.input).not.toHaveAttribute('aria-invalid', 'true')
  })
}

test('the error stays while typing and goes when the task is added', async ({ page, request }) => {
  const ui = await open(page, LAYOUTS[0]!, request)
  await ui.button.click()
  await expect(page.getByText('Enter a title.')).toBeVisible()
  await ui.input.fill('Aligned task')
  await expect(page.getByText('Enter a title.')).toBeVisible()
  await expect(ui.input).toHaveAttribute('aria-invalid', 'true')
  await expect(ui.input).toHaveAccessibleDescription('Enter a title.')
  await ui.button.click()
  await expect(page.getByText('Enter a title.')).toHaveCount(0)
  await expect(page.getByText('Aligned task')).toBeVisible()
})
