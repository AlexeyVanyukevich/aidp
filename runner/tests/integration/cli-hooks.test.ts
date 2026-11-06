import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { realExec } from '../../src/exec.js'
import { runnerCode } from '../../src/fingerprint.js'
import { Git } from '../../src/git.js'
import { CLI_PATH } from '../../src/self.js'
import { targetRepository, useTestGitIdentity } from './target-repo.js'

const CODE = runnerCode()

/** `undefined` unsets a variable. */
function call(args: string[], input: object, env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    BOARD_RUNNER_CODE: CODE,
    ...env,
  }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return spawnSync(CLI_PATH, args, {
    input: JSON.stringify(input),
    env: merged as Record<string, string>,
    encoding: 'utf8',
    cwd: tmpdir(),
  })
}

describe('board-cli as a hook', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'))
  const env = {
    BOARD_URL: 'http://127.0.0.1:9', // nothing listens: the event must be buffered
    BOARD_RUN_TOKEN: 't',
    BOARD_RUN_ID: '00000000-0000-4000-8000-000000000001',
    BOARD_PHASE_ID: '00000000-0000-4000-8000-000000000002',
    BOARD_PHASE: 'build',
    BOARD_AGENT: 'builder',
    BOARD_RUN_DIR: runDir,
    BOARD_WORKTREE: runDir,
  }

  it('buffers a tool call when the board is unreachable, and exits 0 so the agent goes on', () => {
    const result = call(
      ['event', 'PostToolUse'],
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} },
      env,
    )
    expect(result.status).toBe(0)
    const buffered = readFileSync(join(runDir, 'events.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(buffered).toEqual([
      expect.objectContaining({ type: 'tool_call', tool: 'Bash', target: 'ls' }),
    ])
  })

  it('denies an edit outside the plan through stdout', () => {
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['src/retry.ts']))
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Edit', tool_input: { file_path: join(runDir, 'src/other.ts') } },
      env,
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('marks the run paused when the board pauses it, and then refuses every tool', () => {
    expect(existsSync(join(runDir, 'paused'))).toBe(false)
    const after = call(
      ['event', 'PostToolUse'],
      {
        tool_name: 'mcp__board__request_approval',
        tool_input: { question: 'Which?' },
        tool_response: [
          {
            type: 'text',
            text: 'Paused: the owner will answer on the board, and the answer will arrive as your next message. End your turn now.',
          },
        ],
      },
      env,
    )
    expect(after.status).toBe(0)
    expect(existsSync(join(runDir, 'paused'))).toBe(true)

    const refused = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Read', tool_input: { file_path: join(runDir, 'x') } },
      env,
    )
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecisionReason).toBe(
      'The run is paused; end your turn.',
    )
    rmSync(join(runDir, 'paused'))
  })

  it('stays silent to allow', () => {
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Bash', tool_input: { command: 'npm test' } },
      env,
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  // R3, R4: the guard compares the runner's code with the one the phase started with.
  const CODES: { name: string; value: string | undefined; denied: boolean }[] = [
    { name: 'matches', value: CODE, denied: false },
    { name: 'is unset', value: undefined, denied: true },
    { name: 'is empty', value: '', denied: true },
    { name: 'is different', value: 'another-value', denied: true },
  ]
  it.each(CODES)('the guard on a Read when BOARD_RUNNER_CODE $name', ({ value, denied }) => {
    const result = call(
      ['guard'],
      { cwd: runDir, tool_name: 'Read', tool_input: { file_path: join(runDir, 'x') } },
      { ...env, BOARD_RUNNER_CODE: value },
    )
    expect(result.status).toBe(0)
    if (!denied) return expect(result.stdout).toBe('')
    const output = JSON.parse(result.stdout).hookSpecificOutput
    expect(output.permissionDecision).toBe('deny')
    expect(output.permissionDecisionReason).toContain("runner's code changed")
    expect(output.permissionDecisionReason).toContain('End your turn')
  })

  it.each(CODES)('the event hook records the event when BOARD_RUNNER_CODE $name', ({ value }) => {
    const before = existsSync(join(runDir, 'events.ndjson'))
      ? readFileSync(join(runDir, 'events.ndjson'), 'utf8').split('\n').length
      : 0
    const result = call(
      ['event', 'PostToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: {} },
      { ...env, BOARD_RUNNER_CODE: value },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    const after = readFileSync(join(runDir, 'events.ndjson'), 'utf8').split('\n').length
    expect(after).toBeGreaterThan(before)
  })

  /** A worktree directory with a `src` subdirectory, as a plain directory. */
  const plainWorktree = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plain-')))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['src/retry.ts']))
    return dir
  }
  const edit = (cwd: string, file_path: string) => ({
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path },
  })

  it('AC14: checks a relative path against the worktree, not the directory the call ended in', () => {
    const worktree = plainWorktree()
    const wenv = { ...env, BOARD_WORKTREE: worktree }
    const src = join(worktree, 'src')
    expect(call(['guard'], edit(src, 'retry.ts'), wenv).stdout).toBe('')
    const denied = call(['guard'], edit(src, 'other.ts'), wenv)
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  interface Link {
    name: string
    worktree: 'real' | 'link'
    cwd: 'real' | 'link'
    path: (real: string, link: string) => string
    refusal: string | null
  }
  const LINKS: Link[] = ['real', 'link'].flatMap((form) =>
    (
      [
        { name: 'relative', path: () => 'retry.ts', refusal: null },
        {
          name: 'link form',
          path: (_r: string, l: string) => join(l, 'src/retry.ts'),
          refusal: null,
        },
        { name: 'real form', path: (r: string) => join(r, 'src/retry.ts'), refusal: null },
        {
          name: 'unplanned link form',
          path: (_r: string, l: string) => join(l, 'src/other.ts'),
          refusal: 'src/other.ts',
        },
      ] as const
    ).map((row) => ({
      ...row,
      name: `AC15: worktree ${form}, ${row.name}`,
      worktree: form as 'real' | 'link',
      cwd: (form === 'real' ? 'link' : 'real') as 'real' | 'link',
    })),
  )
  it.each(LINKS)('$name', (row) => {
    const real = plainWorktree()
    const link = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'link')
    symlinkSync(real, link)
    const pick = (form: 'real' | 'link') => (form === 'real' ? real : link)
    const result = call(['guard'], edit(join(pick(row.cwd), 'src'), row.path(real, link)), {
      ...env,
      BOARD_WORKTREE: pick(row.worktree),
    })
    expect(result.status).toBe(0)
    if (row.refusal === null) expect(result.stdout).toBe('')
    else {
      const output = JSON.parse(result.stdout).hookSpecificOutput
      expect(output.permissionDecision).toBe('deny')
      expect(output.permissionDecisionReason).toContain(row.refusal)
      expect(output.permissionDecisionReason).toContain('not in the plan')
    }
  })

  const MISSING = [
    { name: 'unset', value: '', mentions: [] as string[] },
    {
      name: 'a path that does not exist',
      value: '/no/such/worktree',
      mentions: ['/no/such/worktree'],
    },
  ]
  it.each(MISSING)(
    'AC16: the guard refuses every tool call when BOARD_WORKTREE is $name',
    (row) => {
      const result = call(
        ['guard'],
        { cwd: runDir, tool_name: 'Bash', tool_input: { command: 'ls' } },
        { ...env, BOARD_WORKTREE: row.value },
      )
      expect(result.status).toBe(0)
      const output = JSON.parse(result.stdout).hookSpecificOutput
      expect(output.permissionDecision).toBe('deny')
      expect(output.permissionDecisionReason).toContain('BOARD_WORKTREE')
      for (const m of row.mentions) expect(output.permissionDecisionReason).toContain(m)
    },
  )
})

describe('board-cli feedback on a Bash call in Build', () => {
  beforeAll(useTestGitIdentity)

  /** A run directory and a worktree in which a Bash call has just created `notes.txt`. */
  async function setup(
    over: { allowed?: boolean; base?: string; notes?: boolean; plan?: string[] } = {},
  ) {
    const { repo } = targetRepository()
    const worktree = join(mkdtempSync(join(tmpdir(), 'wt-')), 'run')
    await new Git(realExec, 'gh').prepareWorktree(repo, 'main', 'board/PAY-1-r1', worktree)
    if (over.notes !== false) writeFileSync(join(worktree, 'notes.txt'), 'x\n')
    const runDir = mkdtempSync(join(tmpdir(), 'run-'))
    if (over.allowed !== false)
      writeFileSync(
        join(runDir, 'allowed-files.json'),
        JSON.stringify(over.plan ?? ['src/retry.ts']),
      )
    writeFileSync(join(runDir, 'base-branch.txt'), over.base ?? 'main')
    const env = {
      BOARD_URL: 'http://127.0.0.1:9',
      BOARD_RUN_TOKEN: 't',
      BOARD_RUN_ID: '00000000-0000-4000-8000-000000000001',
      BOARD_PHASE_ID: '00000000-0000-4000-8000-000000000002',
      BOARD_PHASE: 'build',
      BOARD_AGENT: 'builder',
      BOARD_RUN_DIR: runDir,
      BOARD_WORKTREE: worktree,
    }
    return { worktree, runDir, env }
  }
  const bash = (cwd: string) => ({
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo x > notes.txt' },
    tool_response: {},
  })
  const recorded = (runDir: string) => readFileSync(join(runDir, 'events.ndjson'), 'utf8')

  it('AC17: blocks with the report when the call left a file outside the plan', async () => {
    const { worktree, runDir, env } = await setup()
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as { decision: string; reason: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('notes.txt')
    expect(recorded(runDir)).toContain('"tool":"Bash"')
  })

  interface Quiet {
    name: string
    input: (worktree: string) => object
    over?: { allowed?: boolean; base?: string; notes?: boolean; plan?: string[] }
    phase?: string
  }
  const QUIET: Quiet[] = [
    {
      name: 'the tool is Edit',
      input: (cwd) => ({ ...bash(cwd), tool_name: 'Edit', tool_input: { file_path: 'notes.txt' } }),
    },
    { name: 'the phase is verify', input: bash, phase: 'verify' },
    { name: 'the run directory has no allowed-files.json', input: bash, over: { allowed: false } },
    { name: 'origin/<base> cannot be read', input: bash, over: { base: 'nope' } },
  ]
  it.each(QUIET)('AC18: stays silent, records the event and exits 0 when $name', async (row) => {
    const { worktree, runDir, env } = await setup(row.over)
    const result = call(
      ['event', 'PostToolUse'],
      row.input(worktree),
      row.phase === undefined ? env : { ...env, BOARD_PHASE: row.phase },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(recorded(runDir)).toContain('tool_call')
  })

  const DIFFERS = 'a migration that differs from the one the owner approved'
  const MIGRATION = 'db/migrations/004_x.ts'
  const APPROVED = 'export const x = 1\n'
  const migrationRun = async (written: string) => {
    const made = await setup({ notes: false, plan: [] })
    writeFileSync(
      join(made.runDir, 'approved-migrations.json'),
      JSON.stringify([{ path: MIGRATION, content: APPROVED }]),
    )
    mkdirSync(join(made.worktree, 'db/migrations'), { recursive: true })
    writeFileSync(join(made.worktree, MIGRATION), written)
    return made
  }

  it('AC18: blocks when a Bash call rewrote an approved migration with other content', async () => {
    const { worktree, env } = await migrationRun('export const x = 2\n')
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    const output = JSON.parse(result.stdout) as { decision: string; reason: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain(`\`${MIGRATION}\` – ${DIFFERS}`)
    expect(output.reason).not.toContain('export const x')
  })

  it('stays silent when the approved migration holds the approved content, CRLF or not', async () => {
    const { worktree, env } = await migrationRun('export const x = 1\r\n')
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('stays silent when nothing outside the plan changed', async () => {
    const { worktree, runDir, env } = await setup()
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['notes.txt']))
    const result = call(['event', 'PostToolUse'], bash(worktree), env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('AC3: a planned new file made from a subdirectory is not a violation', async () => {
    const { worktree, env } = await setup({ notes: false, plan: ['sub/new.ts'] })
    mkdirSync(join(worktree, 'sub'))
    writeFileSync(join(worktree, 'sub/new.ts'), 'x\n')
    const result = call(['event', 'PostToolUse'], bash(join(worktree, 'sub')), env)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('AC4: an unplanned file at the root is found from a subdirectory', async () => {
    const { worktree, env } = await setup()
    const result = call(['event', 'PostToolUse'], bash(join(worktree, 'src')), env)
    const output = JSON.parse(result.stdout) as { decision: string; reason: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('notes.txt')
  })

  it('AC5: an unplanned file is found from a directory outside the worktree', async () => {
    const { env } = await setup()
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    const result = call(['event', 'PostToolUse'], bash(outside), env)
    const output = JSON.parse(result.stdout) as { decision: string; reason: string }
    expect(output.decision).toBe('block')
    expect(output.reason).toContain('notes.txt')
  })

  const NO_WORKTREE = [
    { name: 'unset', value: '', mentions: [] as string[] },
    {
      name: 'a path that does not exist',
      value: '/no/such/worktree',
      mentions: ['/no/such/worktree'],
    },
  ]
  it.each(NO_WORKTREE)(
    'AC6: blocks, records the event and exits 0 when BOARD_WORKTREE is $name',
    async (row) => {
      const { worktree, runDir, env } = await setup()
      const result = call(['event', 'PostToolUse'], bash(worktree), {
        ...env,
        BOARD_WORKTREE: row.value,
      })
      expect(result.status).toBe(0)
      const output = JSON.parse(result.stdout) as { decision: string; reason: string }
      expect(output.decision).toBe('block')
      expect(output.reason).toContain('BOARD_WORKTREE')
      for (const m of row.mentions) expect(output.reason).toContain(m)
      expect(recorded(runDir)).toContain('tool_call')
    },
  )
})

describe('board-cli guard when it cannot check a call', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'run-'))
  const base = {
    BOARD_RUNNER_CODE: CODE,
    BOARD_PHASE: 'build',
    BOARD_RUN_DIR: runDir,
    BOARD_WORKTREE: runDir,
  }
  const EDIT = { cwd: runDir, tool_name: 'Edit', tool_input: { file_path: join(runDir, 'x.ts') } }
  const BASH = { cwd: runDir, tool_name: 'Bash', tool_input: { command: 'ls' } }

  interface Failure {
    name: string
    files?: Record<string, string>
    env?: Record<string, string>
    stdin?: string
    input?: object
    /** What the refusal's error names: the row's own cause, not some other failure. */
    names: string
  }
  const FAILURES: Failure[] = [
    { name: 'BOARD_RUN_DIR unset', env: { BOARD_RUN_DIR: '' }, names: 'BOARD_RUN_DIR' },
    { name: 'BOARD_PHASE unset', env: { BOARD_PHASE: '' }, names: 'BOARD_PHASE' },
    { name: 'stdin is not json', stdin: 'not json', names: '"not json" is not valid JSON' },
    {
      name: 'allowed-files.json is not json',
      files: { 'allowed-files.json': 'not json' },
      input: EDIT,
      names: 'allowed-files.json',
    },
    {
      // JSON.parse quotes the text it read, newline and all; the error must stay one line.
      name: 'allowed-files.json is not json and ends in a newline',
      files: { 'allowed-files.json': 'not json\n' },
      names: 'allowed-files.json',
    },
    {
      name: 'allowed-files.json is a string',
      files: { 'allowed-files.json': '"abc"' },
      names: 'allowed-files.json',
    },
    {
      name: 'allowed-files.json is an object',
      files: { 'allowed-files.json': '{}' },
      names: 'allowed-files.json',
    },
    {
      name: 'approved-migrations.json is not json',
      files: { 'approved-migrations.json': 'not json' },
      names: 'approved-migrations.json',
    },
    {
      name: 'approved-migrations.json is a list of plain strings (the old form)',
      files: { 'approved-migrations.json': '["server/src/db/migrations/004_x.ts"]' },
      names: 'approved-migrations.json',
    },
    {
      name: 'approved-migrations.json is [1]',
      files: { 'approved-migrations.json': '[1]' },
      names: 'approved-migrations.json',
    },
    { name: 'linked.json is not json', files: { 'linked.json': 'not json' }, names: 'linked.json' },
    {
      name: 'linked.json lacks fields',
      files: { 'linked.json': '[{"key":"X"}]' },
      names: 'linked.json',
    },
  ]
  const FILES = ['allowed-files.json', 'approved-migrations.json', 'linked.json']

  it.each(FAILURES)('AC1, AC2: refuses and exits 0 when $name', (row) => {
    for (const f of FILES) rmSync(join(runDir, f), { force: true })
    for (const [name, text] of Object.entries(row.files ?? {}))
      writeFileSync(join(runDir, name), text)
    const result = spawnSync(CLI_PATH, ['guard'], {
      input: row.stdin ?? JSON.stringify(row.input ?? BASH),
      env: { ...process.env, ...base, ...row.env },
      encoding: 'utf8',
      cwd: tmpdir(),
    })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout).hookSpecificOutput
    expect(output.permissionDecision).toBe('deny')
    const reason = output.permissionDecisionReason as string
    const prefix = 'The guard could not check this call: '
    const suffix = '. End your turn, and say why in your last message; do not work around it.'
    expect(reason.startsWith(prefix)).toBe(true)
    expect(reason.endsWith(suffix)).toBe(true)
    const message = reason.slice(prefix.length, reason.length - suffix.length)
    expect(message).toContain(row.names)
    const line = result.stderr.split('\n').find((l) => l.startsWith('board-cli guard: '))
    expect(line).toBeDefined()
    expect(line).toContain(message)
    for (const f of FILES) rmSync(join(runDir, f), { force: true })
  })

  it('AC9: a well-formed plan still denies an unplanned edit', () => {
    writeFileSync(join(runDir, 'allowed-files.json'), JSON.stringify(['src/retry.ts']))
    const result = spawnSync(CLI_PATH, ['guard'], {
      input: JSON.stringify({ ...EDIT, tool_input: { file_path: join(runDir, 'src/other.ts') } }),
      env: { ...process.env, ...base },
      encoding: 'utf8',
      cwd: tmpdir(),
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
      'not in the plan',
    )
    rmSync(join(runDir, 'allowed-files.json'))
  })
})
