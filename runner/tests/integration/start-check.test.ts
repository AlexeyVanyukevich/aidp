import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_PATH } from '../../src/self.js'

const FAKE_GH = join(CLI_PATH, '../../tests/fake/fake-gh')
const FAKE_CLAUDE = join(CLI_PATH, '../../tests/fake/fake-claude')

interface Row {
  name: string
  env: Record<string, string | undefined>
  expect: RegExp
  handoff?: boolean
}
const ROWS: Row[] = [
  {
    name: 'AC4 claude missing',
    env: { CLAUDE_BIN: '/nonexistent/claude' },
    expect: /^board-cli: .*CLAUDE_BIN.*\/nonexistent\/claude/,
  },
  {
    name: 'AC5 gh not on PATH',
    env: { GH_BIN: 'no-such-gh-binary' },
    expect: /^board-cli: .*GH_BIN.*no-such-gh-binary/,
  },
  {
    name: 'AC6 handoff kept',
    env: { CLAUDE_BIN: '/nonexistent/claude' },
    expect: /^board-cli: .*CLAUDE_BIN/,
    handoff: true,
  },
  {
    name: 'AC7 no runner key',
    env: { RUNNER_KEY: undefined },
    expect: /^board-cli: Invalid configuration: RUNNER_KEY/,
  },
  {
    name: 'AC7 zero timeout',
    env: { TEST_TIMEOUT_MS: '0' },
    expect: /^board-cli: Invalid configuration: TEST_TIMEOUT_MS/,
  },
]

describe('the start check', () => {
  it.each(ROWS)(
    '$name',
    async (row) => {
      const requests: string[] = []
      const server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`)
        res.statusCode = 500
        res.end()
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const home = mkdtempSync(join(tmpdir(), 'start-check-'))
      const handoff = join(home, 'handoff.json')
      const content = JSON.stringify({
        work: { kind: 'start' },
        claimed_at: new Date().toISOString(),
      })
      if (row.handoff === true) writeFileSync(handoff, content)
      chmodSync(FAKE_GH, 0o755)
      const env: Record<string, string | undefined> = {
        ...process.env,
        RUNNER_KEY: 'k'.repeat(32),
        BOARD_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        BOARD_HOME: home,
        GH_BIN: FAKE_GH,
        CLAUDE_BIN: FAKE_CLAUDE,
        ...row.env,
      }
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (done) => {
          const child = spawn(CLI_PATH, ['daemon'], { env: env as NodeJS.ProcessEnv })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
          child.on('close', (status) => done({ status, stdout, stderr }))
        },
      )
      server.close()
      expect(result.status).toBe(1)
      const lines = result.stderr.split('\n').filter((l) => l !== '')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(row.expect)
      expect(result.stderr).not.toMatch(/^ {4}at /m)
      expect(result.stdout).not.toContain('claiming from')
      expect(requests).toEqual([])
      if (row.handoff === true) {
        expect(existsSync(handoff)).toBe(true)
        expect(readFileSync(handoff, 'utf8')).toBe(content)
      }
    },
    30_000,
  )
})
