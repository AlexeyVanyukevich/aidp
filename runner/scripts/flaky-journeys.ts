// Prints the browser journeys that passed only on a retry, from the JSON report Playwright wrote.
// `./run check:all` runs it last. It always exits zero: the exit code of check:all is the journeys'.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REPORT_PATH = 'test-results/report.json'

interface Spec {
  title?: unknown
  file?: unknown
  line?: unknown
  tests?: unknown
}
interface Suite {
  title?: unknown
  suites?: unknown
  specs?: unknown
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Flaky specs under a suite, in report order. The file's own suite adds no title to the path. */
function walk(suite: Suite, path: string[], found: string[]): void {
  for (const raw of list(suite.specs)) {
    const spec = raw as Spec
    const flaky = list(spec.tests).some(
      (t) => (t as { status?: unknown } | null)?.status === 'flaky',
    )
    if (flaky) {
      found.push(
        `- ${text(spec.file)}:${String(spec.line)} › ${[...path, text(spec.title)].join(' › ')}`,
      )
    }
  }
  for (const child of list(suite.suites)) {
    const inner = child as Suite
    walk(inner, [...path, text(inner.title)], found)
  }
}

/** The block's lines for a parsed report; `null` is a report that is missing or not valid JSON. */
export function flakyBlock(report: unknown): string[] {
  if (report === null || typeof report !== 'object')
    return ['Flaky journeys:', 'No journey report was written.']
  const found: string[] = []
  for (const file of list((report as { suites?: unknown }).suites)) walk(file as Suite, [], found)
  return ['Flaky journeys:', ...(found.length > 0 ? found : ['No journey was flaky.'])]
}

/** The parsed report at a path, or `null` when the file is missing or not valid JSON. */
export function readReport(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(flakyBlock(readReport(resolve(REPORT_PATH))).join('\n'))
}
