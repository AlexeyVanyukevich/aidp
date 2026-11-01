import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RUN = resolve(import.meta.dirname, '../../../run')
const STARTED = '2026-11-02T10:15:00Z'
const LINE = `── ./run dev started ${STARTED} ──\n`

interface Case {
  name: string
  part: string
  before: Record<string, string>
  after: Record<string, string>
}

const CASES: Case[] = [
  { name: 'no earlier logs', part: 'web', before: {}, after: { 'web.log': LINE } },
  {
    name: 'a gap in the chain',
    part: 'server',
    before: { 'server.log': 'cur', 'server.log.2': 'two' },
    after: { 'server.log': LINE, 'server.log.1': 'cur', 'server.log.3': 'two' },
  },
  {
    name: 'a full chain drops the oldest',
    part: 'runner',
    before: {
      'runner.log': 'cur',
      'runner.log.1': 'one',
      'runner.log.2': 'two',
      'runner.log.3': 'three',
      'runner.log.4': 'four',
      'runner.log.5': 'five',
    },
    after: {
      'runner.log': LINE,
      'runner.log.1': 'cur',
      'runner.log.2': 'one',
      'runner.log.3': 'two',
      'runner.log.4': 'three',
      'runner.log.5': 'four',
    },
  },
  {
    name: "another part's logs are left alone",
    part: 'runner',
    before: { 'runner.log': 'r', 'server.log': 's', 'server.log.1': 's1', 'server.log.5': 's5' },
    after: {
      'runner.log': LINE,
      'runner.log.1': 'r',
      'server.log': 's',
      'server.log.1': 's1',
      'server.log.5': 's5',
    },
  },
  {
    name: 'only the numbered logs exist',
    part: 'web',
    before: { 'web.log.1': 'one' },
    after: { 'web.log': LINE, 'web.log.2': 'one' },
  },
]

function bash(script: string, cwd: string) {
  return spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8' })
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
}

describe('rotate_log', () => {
  it.each(CASES)('$name', ({ part, before, after }) => {
    const dir = mkdtempSync(join(tmpdir(), 'rotate-'))
    for (const [file, content] of Object.entries(before)) writeFileSync(join(dir, file), content)
    const res = spawnSync(
      'bash',
      ['-c', `source '${RUN}'; rotate_log "$0" ${part} ${STARTED}`, dir],
      { encoding: 'utf8' },
    )
    expect(res.status).toBe(0)
    expect(snapshot(dir)).toEqual(after)
  })
})

describe('sourcing run', () => {
  it('defines its functions without the preamble or the scenarios', () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-'))
    const res = bash(
      `source '${RUN}'; pwd; declare -F rotate_log; declare -F load_env_file || echo no-lib`,
      dir,
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toBe(`${realpathSync(dir)}\nrotate_log\nno-lib\n`)
  })
})
