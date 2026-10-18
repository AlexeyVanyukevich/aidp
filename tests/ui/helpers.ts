import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'

interface Runtime {
  baseURL: string
  repoPath: string
  opsPath: string
}

let cached: Runtime | undefined

export function runtime(): Runtime {
  cached ??= JSON.parse(
    readFileSync(resolve(import.meta.dirname, '.runtime.json'), 'utf8'),
  ) as Runtime
  return cached
}

export const appUrl = (path: string) => `${runtime().baseURL}${path}`

/** WCAG 2.2 AA, as the kit's journey rule names it: one list for every scan. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/** Scans the page as it stands; any violation fails the journey. */
export async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  expect(violations).toEqual([])
}

/** Presses Tab until `target` has focus, as a keyboard user would; fails after `limit` presses. */
export async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let press = 0; press < limit; press++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

/** True when focus is inside the open dialog. */
export const focusInDialog = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest('dialog[open]') != null)

/** The text of whatever has focus — for an element with no role, as the card's state line. */
export const focusedText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent?.trim())

export const SPEC = `## Goal
Failed deliveries back off.

## Requirements
1. R1 – Retries back off

## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1, 2 and 4 seconds

## Open questions
`
