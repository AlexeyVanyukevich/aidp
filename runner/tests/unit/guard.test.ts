import { describe, expect, it } from 'vitest'
import { decide, denyOutput } from '../../src/hooks/guard.js'

const CWD = '/work/run-1'
const ctx = (
  phase = 'build',
  allowedFiles: string[] | null = ['src/retry.ts', 'src/retry.test.ts'],
  paused = false,
) => ({
  phase,
  allowedFiles,
  paused,
  cwd: CWD,
  exists: (path: string) => path !== '/work/run-1/db/migrations/002_new.ts',
})
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (file_path: string, tool_name = 'Edit') => ({ tool_name, tool_input: { file_path } })

describe('the guard', () => {
  it.each([
    'git commit --no-verify -m "x"',
    'git commit -n -m "x"',
    'git commit -anm "x"',
    'git -c core.hooksPath=/dev/null commit -m "x"',
    'git -c core.HooksPath=x commit -m "x"',
    'git add . && git commit -m "x" --no-verify',
  ])('denies skipping the commit-msg hook: %s', (command) => {
    const verdict = decide(bash(command), ctx())
    expect(verdict.allow).toBe(false)
    expect(!verdict.allow && verdict.reason).toContain('commit-msg hook')
  })

  it.each([
    'git commit -m "add -n flag"',
    'git commit -m "docs: explain --no-verify"',
    'git commit -m "set core.hooksPath"',
    'git commit -am "x"',
    'git log -n 3',
  ])('allows the commit %s', (command) => {
    expect(decide(bash(command), ctx())).toEqual({ allow: true })
  })

  it.each([
    'npm test',
    'git status',
    'git commit -m "x"',
    'rm src/old.ts',
    'cat README.md',
    'grep -r environment src',
  ])('allows the command %s', (command) => {
    expect(decide(bash(command), ctx())).toEqual({ allow: true })
  })

  it.each([
    ['rm -rf build', /rm -rf/],
    ['rm -fr build', /rm -rf/],
    ['rm -r -f build', /rm -rf/],
    ['rm --recursive --force build', /rm -rf/],
    ['git push origin HEAD', /push/],
    ['git push --force', /push/],
    ['cd x && git reset --hard HEAD~1', /reset --hard/],
    ['cat .env', /\.env/],
    ['cp .env.local /tmp/x', /\.env/],
  ])('denies the command %s', (command, reason) => {
    const verdict = decide(bash(command), ctx())
    expect(verdict.allow).toBe(false)
    if (!verdict.allow) expect(verdict.reason).toMatch(reason)
  })

  it.each([
    ['a planned file, relative', edit('src/retry.ts'), true],
    ['a planned file, absolute', edit('/work/run-1/src/retry.ts'), true],
    ['an unplanned file in Build', edit('src/other.ts'), false],
    ['an unplanned file in Plan', { ...edit('src/other.ts') }, true],
    ['a path outside the worktree', edit('/etc/hosts'), false],
    ['a path escaping with ..', edit('src/../../escape.ts'), false],
    ['an env file', edit('.env'), false],
    ['a nested env file', edit('config/.env.production'), false],
    ['a new migration', edit('db/migrations/002_new.ts', 'Write'), false],
    ['an existing migration, edited', edit('db/migrations/001_initial.ts'), false],
  ])('%s', (name, input, allowed) => {
    const phase = name.includes('in Plan') ? 'plan' : 'build'
    const planFiles = name.includes('migration')
      ? ['db/migrations/002_new.ts', 'db/migrations/001_initial.ts']
      : undefined
    expect(
      decide(input, ctx(phase, planFiles ?? ['src/retry.ts', 'src/retry.test.ts'])).allow,
    ).toBe(allowed)
  })

  describe('migrations', () => {
    const NEW = 'server/src/db/migrations/004_x.ts'
    const OLD = 'server/src/db/migrations/001_initial.ts'
    const INDEX = 'server/src/db/migrations/index.ts'
    const mctx = (phase: string, allowed: string[], approved: string[] = []) => ({
      phase,
      allowedFiles: allowed,
      approvedMigrations: approved,
      paused: false,
      cwd: CWD,
      exists: (path: string) => !path.endsWith('004_x.ts'),
    })
    const reason = (verdict: ReturnType<typeof decide>) => (verdict.allow ? '' : verdict.reason)

    it('refuses a new migration the plan lists, naming the request', () => {
      const verdict = decide(edit(NEW, 'Write'), mctx('build', [NEW]))
      expect(verdict.allow).toBe(false)
      expect(reason(verdict)).toContain('request_approval')
      expect(reason(verdict)).toContain('kind migration')
    })
    it.each(['Edit', 'MultiEdit', 'Write'])('refuses %s of an existing migration', (tool) => {
      const verdict = decide(edit(OLD, tool), mctx('build', [OLD]))
      expect(verdict.allow).toBe(false)
      expect(reason(verdict)).toContain('kind migration')
    })
    it('treats the registry by the plan alone', () => {
      expect(decide(edit(INDEX), mctx('build', [INDEX]))).toEqual({ allow: true })
      expect(reason(decide(edit(INDEX), mctx('build', [])))).toContain('out_of_plan')
    })
    it('lets an approved migration through, in every round', () => {
      expect(decide(edit(NEW, 'Write'), mctx('build', [], [NEW]))).toEqual({ allow: true })
      expect(decide(edit(OLD, 'Edit'), mctx('build', [], [OLD]))).toEqual({ allow: true })
    })
    it('refuses to create a migration outside Build', () => {
      expect(decide(edit(NEW, 'Write'), mctx('plan', [NEW])).allow).toBe(false)
    })

    describe('order', () => {
      const DIR = 'server/src/db/migrations'
      const early = `${DIR}/004_helps.ts`
      const later = `${DIR}/007_helps.ts`
      const existing = `${DIR}/005_plan_kept_from.ts`
      const octx = (allowed: string[], approved: string[] = []) => ({
        phase: 'build',
        allowedFiles: allowed,
        approvedMigrations: approved,
        paused: false,
        cwd: CWD,
        exists: (path: string) => path.endsWith('005_plan_kept_from.ts'),
        migrationSiblings: (dir: string) =>
          dir === DIR
            ? ['004_setup_command.ts', '005_plan_kept_from.ts', '006_project_links.ts']
            : [],
      })
      it('denies a new migration that sorts too early, even when the plan lists it', () => {
        const verdict = decide(edit(early, 'Write'), octx([early]))
        expect(verdict.allow).toBe(false)
        expect(reason(verdict)).toContain('004_helps.ts')
        expect(reason(verdict)).toContain('name order')
        expect(reason(verdict)).toContain('006_project_links')
        expect(reason(verdict)).not.toContain('request_approval')
      })
      it('keeps the request text for a new migration in order', () => {
        const verdict = decide(edit(later, 'Write'), octx([later]))
        expect(reason(verdict)).toContain('creating the migration')
        expect(reason(verdict)).toContain('kind migration')
      })
      it('does not check the order of an existing migration', () => {
        const verdict = decide(edit(existing), octx([existing]))
        expect(reason(verdict)).toContain('changing the migration')
        expect(reason(verdict)).not.toContain('name order')
      })
      it('does not check a migration the owner allowed', () => {
        expect(decide(edit(early, 'Write'), octx([], [early]))).toEqual({ allow: true })
      })
      it('does not look for siblings of a path that is no migration', () => {
        const verdict = decide(edit('src/a.ts', 'Write'), {
          ...octx(['src/a.ts']),
          migrationSiblings: () => {
            throw new Error('listed')
          },
        })
        expect(verdict).toEqual({ allow: true })
      })
    })
  })

  // Slice 3 spec §10: a command or agent left in the background is lost when the turn ends.
  const BACKGROUND =
    'Run it in the foreground: a command or agent left running in the background is lost when your turn ends. Give a long command a timeout instead.'
  it.each<[string, { tool_name: string; tool_input: Record<string, unknown> }, boolean]>([
    [
      'a command sent to the background',
      { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } },
      false,
    ],
    [
      'an agent sent to the background',
      { tool_name: 'Agent', tool_input: { prompt: 'find it', run_in_background: true } },
      false,
    ],
    [
      'a command kept in the foreground',
      { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: false } },
      true,
    ],
    [
      'an agent kept in the foreground',
      { tool_name: 'Agent', tool_input: { prompt: 'find it', run_in_background: false } },
      true,
    ],
    ['a command that does not say', bash('npm test'), true],
    [
      'another tool carrying the key',
      { tool_name: 'Read', tool_input: { file_path: 'src/retry.ts', run_in_background: true } },
      true,
    ],
  ])('%s', (_name, input, allowed) => {
    expect(decide(input, ctx())).toEqual(
      allowed ? { allow: true } : { allow: false, reason: BACKGROUND },
    )
  })

  // Slice 2 spec §5: the builder asks rather than working around the plan.
  it('tells the builder how to ask for a file the plan does not list', () => {
    expect(decide(edit('src/other.ts'), ctx())).toEqual({
      allow: false,
      reason:
        '`src/other.ts` is not in the plan. If the work needs it, call request_approval with kind out_of_plan, the files, and why. Then end your turn.',
    })
  })

  it('allows a file the owner allowed, though the plan does not list it', () => {
    expect(decide(edit('src/http.ts'), ctx('build', ['src/retry.ts', 'src/http.ts'])).allow).toBe(
      true,
    )
  })

  // Slice 2 spec §6: once the run is paused, nothing the agent does may change anything.
  it.each([
    ['Read', { tool_name: 'Read', tool_input: { file_path: 'src/retry.ts' } }],
    ['Bash', bash('npm test')],
    ['a planned edit', edit('src/retry.ts')],
    ['a board tool', { tool_name: 'mcp__board__log_step', tool_input: { summary: 'x' } }],
  ])('refuses %s once the run is paused', (_name, input) => {
    expect(decide(input, ctx('build', ['src/retry.ts'], true))).toEqual({
      allow: false,
      reason: 'The run is paused; end your turn.',
    })
  })

  it('denies with the JSON Claude Code reads', () => {
    expect(JSON.parse(denyOutput('because'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'because',
      },
    })
  })
})

// A linked project's checkout is read-only, and its working copy is not the run's to touch.
describe('the guard and linked projects', () => {
  const ZLC = { key: 'ZLC', repo_path: '/repos/zellige', path: '/home/worktrees/run-1-linked/ZLC' }
  const linkedCtx = (phase = 'build') => ({ ...ctx(phase), linked: [ZLC] })
  const read = (tool_name: string, file_path: string) => ({
    tool_name,
    tool_input: tool_name === 'Read' ? { file_path } : { path: file_path },
  })
  const reasonOf = (verdict: ReturnType<typeof decide>) => (verdict.allow ? '' : verdict.reason)

  it.each(['spec', 'plan', 'build', 'verify'])(
    'AC15: refuses Edit and Write in the checkout and in the repo_path in %s, naming the project',
    (phase) => {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
        for (const file of [`${ZLC.path}/src/a.ts`, '/repos/zellige/src/a.ts']) {
          const verdict = decide(edit(file, tool), linkedCtx(phase))
          expect(verdict.allow).toBe(false)
          expect(reasonOf(verdict)).toContain('ZLC')
          expect(reasonOf(verdict)).toContain('read-only')
        }
    },
  )

  it.each(['Read', 'Grep', 'Glob'])('AC16: allows %s in the checkout', (tool) => {
    expect(decide(read(tool, `${ZLC.path}/src`), linkedCtx())).toEqual({ allow: true })
  })

  it.each(['Read', 'Grep', 'Glob'])(
    'AC16: refuses %s in the repo_path, pointing to the checkout',
    (tool) => {
      const verdict = decide(read(tool, '/repos/zellige/src'), linkedCtx())
      expect(verdict.allow).toBe(false)
      expect(reasonOf(verdict)).toContain(ZLC.path)
    },
  )

  it('AC16: leaves a read of another path alone', () => {
    expect(decide(read('Read', '/repos/zellige-other/x'), linkedCtx())).toEqual({ allow: true })
    expect(decide(read('Grep', 'src'), linkedCtx())).toEqual({ allow: true })
  })

  it.each([
    'git -C /repos/zellige log',
    'cat /repos/zellige/package.json',
    'cd /repos/zellige && ls',
  ])('AC17: refuses the Bash command %s, pointing to the checkout', (command) => {
    const verdict = decide(bash(command), linkedCtx())
    expect(verdict.allow).toBe(false)
    expect(reasonOf(verdict)).toContain(ZLC.path)
  })

  it.each([`grep -r Button ${ZLC.path}`, 'cat /repos/zellige-other/x', 'git log'])(
    'AC17: allows the Bash command %s',
    (command) => {
      expect(decide(bash(command), linkedCtx())).toEqual({ allow: true })
    },
  )

  it('AC17: still refuses an Edit outside the worktree that is not a linked path', () => {
    const verdict = decide(edit('/etc/hosts'), linkedCtx())
    expect(reasonOf(verdict)).toContain('outside the worktree')
  })

  it('does nothing different for a run without links', () => {
    expect(decide(bash('cat /repos/zellige/package.json'), ctx())).toEqual({ allow: true })
    expect(decide(read('Read', '/repos/zellige/a'), ctx())).toEqual({ allow: true })
  })
})
