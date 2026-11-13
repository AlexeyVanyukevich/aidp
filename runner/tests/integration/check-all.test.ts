import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RUN = resolve(import.meta.dirname, '../../../run')
const JOURNEYS = 'The browser journeys against the whole product'

interface Case {
  name: string
  /** The body of the stubbed `scenario_check`. */
  check: string
  /** The exit code the stubbed `npx playwright` returns. */
  journeys: number
  exit: number
  printed: string[]
  absent: string[]
}

const CASES: Case[] = [
  {
    name: 'a check that returns 3 runs no journeys and prints no block',
    check: 'return 3',
    journeys: 0,
    exit: 3,
    printed: [],
    absent: ['Flaky journeys:', JOURNEYS, 'NPX'],
  },
  {
    name: 'a check whose first command fails and whose last succeeds still fails',
    check: 'false; true',
    journeys: 0,
    exit: 1,
    printed: [],
    absent: ['Flaky journeys:', JOURNEYS, 'NPX'],
  },
  {
    name: 'journeys that fail with 2 print the block and exit 2',
    check: 'true',
    journeys: 2,
    exit: 2,
    printed: [JOURNEYS, 'NPX playwright test --retries=1', 'Flaky journeys:'],
    absent: [],
  },
  {
    name: 'journeys that pass print the block and exit 0',
    check: 'true',
    journeys: 0,
    exit: 0,
    printed: [JOURNEYS, 'Flaky journeys:'],
    absent: [],
  },
]

describe('scenario_check_all', () => {
  it.each(CASES)('$name', ({ check, journeys, exit, printed, absent }) => {
    const script = `
      source "${RUN}"
      need_node() { :; }
      need_deps() { :; }
      need_docker() { :; }
      need_chromium() { :; }
      step() { echo "STEP $1"; }
      ok() { :; }
      scenario_check() { ${check}; }
      npx() {
        echo "NPX $*"
        case "$1" in
          tsx) echo "Flaky journeys:" ;;
          playwright) return ${journeys} ;;
        esac
      }
      scenario_check_all
    `
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    const out = `${result.stdout}${result.stderr}`
    expect(result.status).toBe(exit)
    for (const text of printed) expect(out).toContain(text)
    for (const text of absent) expect(out).not.toContain(text)
  })
})
