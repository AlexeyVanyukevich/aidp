import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api.js'
import type { ArtifactView, Checkpoint, RunnerEvent, RunWork, Work } from '../../src/contract.js'
import {
  carryOut,
  cleanUp,
  INTERRUPTED,
  type DeliveryDeps,
  type Phases,
} from '../../src/delivery.js'
import { Git, GitError } from '../../src/git.js'
import { StartFailure } from '../../src/phases/process.js'
import { LOG_FILE } from '../../src/worktree-log.js'
import type { PhaseRecord, StepResult } from '../../src/phases/phase.js'
import {
  BRANCH,
  FORK,
  ORIGIN,
  RUN,
  RUN_DIR,
  START,
  type Script,
  checkpoint,
  harness,
  resume,
  withPlan,
} from './run-harness.js'

describe('a run carried out from the start, as slice 1 did', () => {
  it('plans, builds, verifies, and opens the pull request', async () => {
    const h = harness({})
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls).toEqual([
      'start plan-1',
      'end plan-1 ok',
      'start build-1',
      'end build-1 ok',
      'start verify-1',
      'end verify-1 ok',
    ])
    expect(h.gitCalls).toEqual([
      `worktree ${BRANCH}`,
      `push ${BRANCH}`,
      'find pr',
      'create pr',
      'remove',
    ])
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'review', pr_number: 9, branch: BRANCH },
    })
    expect(h.checkpoints().map((c) => c.stage)).toEqual(
      expect.arrayContaining(['prepare', 'plan', 'build', 'tests', 'verify', 'push', 'pr']),
    )
    expect(readFileSync(join(h.home, 'runs', RUN.id, 'allowed-files.json'), 'utf8')).toBe(
      '["src/retry.ts"]',
    )
  })

  it('hands a failing report to the next build, and gives up after the third', async () => {
    const h = harness({ verdicts: ['fail', 'fail', 'fail'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start verify-1',
      'start build-2',
      'start verify-2',
      'start build-3',
      'start verify-3',
    ])
    expect(h.handoffs['build-2']).toContain('<verify_report>')
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('opens the pull request when the report holds pass and owner and no fail', async () => {
    const h = harness({ verdicts: ['owner-pass'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start verify-1',
    ])
    expect(h.gitCalls).toContain(`push ${BRANCH}`)
    expect(h.gitCalls).toContain('create pr')
  })

  it('opens the pull request when the report holds pass and withdrawn and no fail', async () => {
    const h = harness({ verdicts: ['withdrawn-pass'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start verify-1',
    ])
    expect(h.gitCalls).toContain('create pr')
  })

  it('still fails after the third report that holds an owner and a fail', async () => {
    const h = harness({ verdicts: ['owner-fail', 'owner-fail', 'owner-fail'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start verify'))).toHaveLength(3)
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('counts a build with no commit as a failed verify, without running Verify', async () => {
    const h = harness({ commits: [0, 1] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start build-2',
      'start verify-2',
    ])
    expect(h.handoffs['build-2']).toContain('made no commit')
  })

  it.each([
    ['a planner that saved no plan', { savesPlan: false }, 'the planner saved no plan'],
    [
      'a plan phase that failed',
      { acts: { 'plan-1': ['fails' as const] } },
      'the plan phase failed',
    ],
    [
      'a verifier that saved no report',
      { verdicts: ['no-report' as const] },
      'the verifier saved no report',
    ],
  ])('fails the run on %s, saying why', async (_name, script, reason) => {
    const h = harness(script)
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed', reason } })
    expect(h.gitCalls.at(-1)).toBe('remove')
  })

  it('ends a cancelled run as cancelled', async () => {
    const h = harness({ acts: { 'build-1': ['cancelled'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('cancelled')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'cancelled' } })
  })
})

describe('a run holding a copied plan', () => {
  const KEPT: RunWork = { ...RUN, kept_plan: { artifact_id: 'plan-1', from_run: 1 } }
  const kept = (h: ReturnType<typeof harness>) => {
    withPlan(h)
    return { kind: 'start', run: KEPT } as Extract<Work, { kind: 'start' }>
  }

  it('AC6: starts no planner and raises no gate; Build follows prepare', async () => {
    const h = harness({})
    expect(await carryOut(kept(h), h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start build-1',
      'start verify-1',
    ])
    expect(h.calls.some((c) => c.includes('plan-'))).toBe(false)
    expect(h.of('approval_requested')).toEqual([])
    expect(h.handoffs['build-1']).toContain('<plan>')
    expect(readFileSync(join(h.home, 'runs', RUN.id, 'allowed-files.json'), 'utf8')).toBe(
      '["src/retry.ts"]',
    )
    expect(h.checkpoints().every((c) => c.plan_artifact_id === 'plan-1')).toBe(true)
  })

  it('AC7: a resume from before Build goes on in Build with the plan, no planner', async () => {
    const h = harness({})
    withPlan(h)
    const work: Work = {
      kind: 'resume',
      run: KEPT,
      checkpoint: { ...checkpoint('prepare', 1), plan_artifact_id: 'plan-1' },
      message: INTERRUPTED,
      allowed_files: ['src/retry.ts'],
    }
    expect(await carryOut(work as Extract<Work, { kind: 'resume' }>, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))[0]).toBe('start build-1')
    expect(h.of('approval_requested')).toEqual([])
  })
})

describe('a re-planning run', () => {
  it('AC9: hands the planner the previous plans, and a medium plan still meets the gate', async () => {
    const h = harness({ confidence: ['medium'] })
    const work = {
      kind: 'start',
      run: { ...RUN, previous_plans: [{ run: 1, accepted: true, body_md: 'old plan' }] },
    } as Extract<Work, { kind: 'start' }>
    await carryOut(work, h.deps)
    expect(h.handoffs['plan-1']).toContain(
      '<previous_plan run="1" accepted="yes">\nold plan\n</previous_plan>',
    )
    expect(h.handoffs['plan-1']).not.toContain('<plan>')
    expect(h.of('approval_requested')).toHaveLength(1)
  })
})

describe('a re-planning run with plan answers', () => {
  // RUN is run 2: the planner sees run 1's answer, the verifier sees both.
  const answers = [
    { run: 1, approved: false, text: 'keep tests in tests/unit' },
    { run: 2, approved: false, text: 'Drop AC2: the file is gone.' },
  ]
  it('AC6, AC7: the planner is handed the earlier runs’ answers, the verifier every one', async () => {
    const h = harness({})
    const work = { kind: 'start', run: { ...RUN, plan_answers: answers } } as Extract<
      Work,
      { kind: 'start' }
    >
    await carryOut(work, h.deps)
    const one = '<plan_answer run="1" approved="no">\nkeep tests in tests/unit\n</plan_answer>'
    const two = '<plan_answer run="2" approved="no">\nDrop AC2: the file is gone.\n</plan_answer>'
    expect(h.handoffs['plan-1']).toContain(one)
    expect(h.handoffs['plan-1']).not.toContain('run="2"')
    expect(h.handoffs['verify-1']).toContain(one)
    expect(h.handoffs['verify-1']).toContain(two)
    expect(h.handoffs['build-1']).not.toContain('<plan_answer')
  })

  it('AC7: the verifier’s answers over the bound end with the left-out tag', async () => {
    const h = harness({})
    const long = [1, 1, 1].map((run) => ({ run, approved: false, text: 'x'.repeat(8_000) }))
    const work = { kind: 'start', run: { ...RUN, plan_answers: long } } as Extract<
      Work,
      { kind: 'start' }
    >
    await carryOut(work, h.deps)
    expect(h.handoffs['verify-1']).toContain('<plan_answers_left_out count="1" runs="1"/>')
  })

  it('AC8: a claim without the field gives a handoff without the tag', async () => {
    const h = harness({})
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    expect(h.handoffs['plan-1']).not.toContain('<plan_answer')
  })
})

describe('pausing and resuming', () => {
  it('releases a run that pauses in Build: no phase end, no run end, the worktree kept', async () => {
    const h = harness({ acts: { 'build-1': ['paused'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.calls).toEqual(['start plan-1', 'end plan-1 ok', 'start build-1'])
    expect(h.runEnd()).toBeUndefined()
    expect(h.gitCalls).not.toContain('remove')
    const last = h.checkpoints().at(-1)!
    expect(last).toMatchObject({ stage: 'build', attempt: 1, plan_artifact_id: 'plan-1' })
    expect(last.session).toMatchObject({ id: expect.any(String) })
  })

  it('resumes Build with the answer and carries on to a pull request', async () => {
    const h = withPlan(harness({}))
    const outcome = await carryOut(
      resume(
        checkpoint('build', 1, 'build-phase'),
        'The owner answered your question:\n\nBlue',
      ) as Extract<Work, { kind: 'resume' }>,
      h.deps,
    )
    expect(outcome).toBe('review')
    expect(h.calls).toEqual([
      'resume build-1: The owner answered your question:\n\nBlue',
      'end build-1 ok',
      'start verify-1',
      'end verify-1 ok',
    ])
    expect(h.gitCalls).not.toContain(`worktree ${BRANCH}`)
  })

  it('writes the approved migrations beside the allowed files on resume', async () => {
    const h = withPlan(harness({}))
    const M = 'server/src/db/migrations/004_x.ts'
    const work = {
      ...resume(checkpoint('build', 1, 'build-phase'), 'The owner allowed the migration.', [
        'src/retry.ts',
        M,
      ]),
      approved_migrations: [{ path: M, content: 'export const x = 1\n' }],
    } as Extract<Work, { kind: 'resume' }>
    await carryOut(work, h.deps)
    const dir = join(h.home, 'runs', RUN.id)
    expect(JSON.parse(readFileSync(join(dir, 'approved-migrations.json'), 'utf8'))).toEqual([
      { path: M, content: 'export const x = 1\n' },
    ])
    expect(JSON.parse(readFileSync(join(dir, 'allowed-files.json'), 'utf8'))).toContain(M)
  })

  it.each([
    ['plain strings', ['server/src/db/migrations/004_x.ts']],
    ['an entry without content', [{ path: 'a' }]],
    ['an entry whose content is a number', [{ path: 'a', content: 1 }]],
  ])('fails a claim whose approved_migrations holds %s, before any phase', async (_name, claim) => {
    const h = withPlan(harness({}))
    const work = {
      ...resume(checkpoint('build', 1, 'build-phase'), 'Go on.', ['src/retry.ts']),
      approved_migrations: claim,
    } as Extract<Work, { kind: 'resume' }>
    expect(await carryOut(work, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: expect.stringContaining('approved_migrations') },
    })
    expect(h.calls).toEqual([])
    expect(existsSync(join(RUN_DIR(h.home), 'approved-migrations.json'))).toBe(false)
  })

  it('writes the base branch to the run directory on start and on resume', async () => {
    const started = withPlan(harness({}))
    await carryOut(START as Extract<Work, { kind: 'start' }>, started.deps)
    expect(readFileSync(join(started.home, 'runs', RUN.id, 'base-branch.txt'), 'utf8')).toBe('main')
    const resumed = withPlan(harness({}))
    await carryOut(
      resume(checkpoint('build', 1, 'build-phase'), 'Go on.', ['src/retry.ts']) as Extract<
        Work,
        { kind: 'resume' }
      >,
      resumed.deps,
    )
    expect(readFileSync(join(resumed.home, 'runs', RUN.id, 'base-branch.txt'), 'utf8')).toBe('main')
  })

  it('stops at the plan gate when the planner is not confident', async () => {
    const h = harness({ confidence: ['medium'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.calls).toEqual(['start plan-1'])
    expect(h.of('approval_requested')).toEqual([
      expect.objectContaining({
        phase_id: expect.any(String),
        payload: expect.objectContaining({
          approval_id: expect.any(String),
          kind: 'plan',
          context_md: '1. Backoff',
        }),
      }),
    ])
  })

  it('fails the run in plain words when the board refuses the plan gate', async () => {
    const refusal = new ApiError(
      400,
      'POST /api/runner/events answered 400: {"error":"validation_error"}',
      {
        error: 'validation_error',
        details: { findings: [{ field: 'context_md', code: 'too_long' }] },
      },
    )
    const h = harness({ confidence: ['medium'], refuse: refusal })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.calls).toContain('end plan-1 failed')
    const reason = String(h.runEnd()?.payload.reason)
    expect(reason).toBe('The board refused the plan gate: context_md is too long.')
    expect(reason).not.toContain('answered 400')
    expect(reason).not.toContain('{')
  })

  it('fails the run with a bare sentence when the refusal names nothing', async () => {
    const h = harness({ confidence: ['medium'], refuse: new ApiError(400, 'answered 400: no') })
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'The board refused the plan gate.' },
    })
  })

  it('starts Build once the owner approves the plan', async () => {
    const h = withPlan(harness({}))
    expect(
      await carryOut(
        resume(checkpoint('plan', 1, 'plan-phase'), null) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 2)).toEqual(['end plan-1 ok', 'start build-1'])
  })

  it('resumes the planner with the changes the owner asks for, then gates the new plan', async () => {
    const h = withPlan(harness({ confidence: ['high'] }))
    expect(
      await carryOut(
        resume(checkpoint('plan', 1, 'plan-phase'), 'Split step 2.') as Extract<
          Work,
          { kind: 'resume' }
        >,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 3)).toEqual([
      'resume plan-1: Split step 2.',
      'end plan-1 ok',
      'start build-1',
    ])
  })
})

describe('blocks', () => {
  it('blocks the run on a push git refused, with the command and its output', async () => {
    const h = harness({ push: ['fails'] })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: {
        blocks: true,
        cause: 'step_failed',
        stage: 'push',
        command: `git push -u origin ${BRANCH}`,
        output: 'rejected',
      },
    })
    expect(h.runEnd()).toBeUndefined()
  })

  it('retries the push on Resume, and opens the pull request', async () => {
    const h = withPlan(harness({}))
    expect(
      await carryOut(
        resume(checkpoint('push', 1), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.gitCalls).toEqual([`push ${BRANCH}`, 'find pr', 'create pr', 'remove'])
  })

  it('takes the pull request a stopped run already opened, rather than creating another', async () => {
    const h = withPlan(harness({ prOpen: true }))
    expect(
      await carryOut(
        resume(checkpoint('pr', 1), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.gitCalls).not.toContain('create pr')
    expect(h.runEnd()).toMatchObject({ payload: { pr_number: 5 } })
  })

  it('blocks the run when the daemon stops it mid-Verify', async () => {
    const h = harness({ acts: { 'verify-1': ['shutdown'] } })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: { blocks: true, cause: 'runner_stopped', stage: 'verify' },
    })
  })

  // Spec R5, R6: the code moved under a phase. The phase's result is kept, then the run blocks.
  describe('when the runner code moved during a phase', () => {
    it('blocks the run as a failed runner code check, keeping the session', async () => {
      const h = harness({ acts: { 'build-1': ['moved'] } })
      expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
      expect(h.of('error').at(-1)).toMatchObject({
        payload: {
          blocks: true,
          cause: 'step_failed',
          stage: 'build',
          command: 'runner code check',
          output: expect.stringContaining('Resume then continues the run'),
        },
      })
      expect(h.checkpoints().at(-1)).toMatchObject({
        stage: 'build',
        session: { id: expect.any(String) },
      })
    })

    it.each<[string, 'moved-paused' | 'moved-cancelled' | 'moved-shutdown', string]>([
      ['paused', 'moved-paused', 'released'],
      ['cancelled', 'moved-cancelled', 'cancelled'],
      ['shut down', 'moved-shutdown', 'released'],
    ])('handles a phase that was %s as before', async (_name, act, outcome) => {
      const h = harness({ acts: { 'build-1': [act] } })
      expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe(outcome)
      const last = h.of('error').at(-1)
      expect(last?.payload?.command).not.toBe('runner code check')
    })
  })

  describe('a resume whose worktree is gone', () => {
    const SETUP = 'npm ci'
    const WITH_SETUP: RunWork = { ...RUN, project: { ...RUN.project, setup_command: SETUP } }
    const claim = (script: Script, stage: 'build' | 'plan' = 'build') => {
      const h = withPlan(harness({ worktreeGone: true, setupCommand: SETUP, ...script }))
      const work = {
        ...resume(checkpoint(stage, 1, 'p'), INTERRUPTED),
        run: WITH_SETUP,
      } as Extract<Work, { kind: 'resume' }>
      return { h, work }
    }
    const setups = (h: ReturnType<typeof harness>) =>
      h.of('tool_call').filter((e) => e.tool === 'setup_command')

    it('re-creates it on the branch, sets up once and goes on', async () => {
      const { h, work } = claim({})
      expect(await carryOut(work, h.deps)).toBe('review')
      expect(h.gitCalls).toContain(`add on ${BRANCH}`)
      expect(setups(h)).toHaveLength(1)
      expect(h.of('tool_call').find((e) => e.tool === 'recreate_worktree')).toMatchObject({
        agent: 'runner',
        status: 'ok',
        payload: { caller: 'delivery_resume', result: 'recreated', branch: BRANCH },
      })
      expect(h.log().find((l) => l.action === 'recreate')).toMatchObject({
        caller: 'delivery_resume',
        result: 'recreated',
      })
    })

    it('AC21: runs setup exactly once when the Plan-stage refresh does it', async () => {
      const { h, work } = claim({}, 'plan')
      await carryOut(work, h.deps)
      expect(setups(h)).toHaveLength(1)
    })

    it('AC22: fails the run when the branch is gone as well', async () => {
      const { h, work } = claim({ branchGone: true })
      expect(await carryOut(work, h.deps)).toBe('failed')
      const reason = `the run's worktree and its branch ${BRANCH} are gone`
      expect(h.runEnd()).toMatchObject({ payload: { reason } })
      expect(h.log().find((l) => l.action === 'recreate')).toMatchObject({ result: 'failed' })
      expect(h.of('tool_call').find((e) => e.tool === 'recreate_worktree')).toMatchObject({
        status: 'error',
        payload: { result: 'failed' },
      })
    })

    it('AC23: blocks as step_failed and clears what a failed add left', async () => {
      const { h, work } = claim({ recreateFails: true })
      expect(await carryOut(work, h.deps)).toBe('released')
      expect(h.of('error').at(-1)?.payload).toMatchObject({ blocks: true, cause: 'step_failed' })
      expect(existsSync(join(h.home, 'worktrees', RUN.id))).toBe(false)
      expect(h.log().some((l) => l.caller === 'recreate')).toBe(true)
    })

    it('AC24: blocks as step_failed and removes the worktree when setup fails', async () => {
      const { h, work } = claim({ setupExits: [1] })
      expect(await carryOut(work, h.deps)).toBe('released')
      expect(h.of('error').at(-1)?.payload).toMatchObject({ blocks: true, cause: 'step_failed' })
      expect(existsSync(join(h.home, 'worktrees', RUN.id))).toBe(false)
      expect(h.log().find((l) => l.caller === 'recreate' && l.action === 'remove')).toBeDefined()
    })
  })

  it('starts a phase again when its session is gone and held no message', async () => {
    const h = withPlan(harness({ acts: { 'build-1': ['gone', 'ok'] }, hasMessages: false }))
    expect(
      await carryOut(
        resume(checkpoint('build', 1, 'b'), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('review')
    expect(h.calls.slice(0, 3)).toEqual([
      `resume build-1: ${INTERRUPTED}`,
      'restart build-1',
      'end build-1 ok',
    ])
  })

  it('fails a run whose session is gone with its messages', async () => {
    const h = withPlan(harness({ acts: { 'build-1': ['gone'] }, hasMessages: true }))
    expect(
      await carryOut(
        resume(checkpoint('build', 1, 'b'), INTERRUPTED) as Extract<Work, { kind: 'resume' }>,
        h.deps,
      ),
    ).toBe('failed')
    expect(h.runEnd()).toMatchObject({
      payload: { reason: "the run's Claude Code session is gone; Re-run starts again from Plan" },
    })
  })
})

describe('cleaning up', () => {
  it('removes the worktree of a run cancelled while paused', async () => {
    // The board knows no path for a run that never ended: the runner's own convention finds it.
    const h = harness({})
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: null } },
      h.deps,
    )
    expect(h.gitCalls).toEqual(['remove'])
  })
})

describe('a delivery run of a project that links another', () => {
  const ZLC = {
    key: 'ZLC',
    name: 'Zellige',
    note: 'the kit',
    repo_path: '/zlc',
    github_repo: 'owner/zellige',
    base_branch: 'main',
  }
  const LINKED: Work = { kind: 'start', run: { ...RUN, links: [ZLC] } }

  it('AC19: pushes and opens its pull request only for its own project', async () => {
    const h = harness({})
    expect(await carryOut(LINKED, h.deps)).toBe('review')
    const linkedPath = join(h.home, 'worktrees', `${RUN.id}-linked`, 'ZLC')
    expect(h.gitCalls).toContain(`linked /zlc main ${linkedPath}`)
    const worktree = join(h.home, 'worktrees', RUN.id)
    expect(h.writes).toEqual([
      `push in ${worktree}`,
      `create pr in ${worktree} for owner/pay on main`,
    ])
    expect(h.gitCalls).toContain('remove linked /zlc')
  })

  it('makes the checkout in prepare, before any phase, and makes none without links', async () => {
    const withLinks = harness({})
    await carryOut(LINKED, withLinks.deps)
    expect(withLinks.gitCalls.findIndex((c) => c.startsWith('linked'))).toBe(1)
    const without = harness({})
    await carryOut(START, without.deps)
    expect(without.gitCalls.some((c) => c.startsWith('linked'))).toBe(false)
  })

  it('AC12: a cleanup claimed after a Cancel removes the linked checkouts too', async () => {
    const h = harness({})
    const runDir = join(h.home, 'runs', RUN.id)
    mkdirSync(runDir, { recursive: true })
    const path = join(h.home, 'worktrees', `${RUN.id}-linked`, 'ZLC')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(runDir, 'linked.json'), JSON.stringify([{ ...ZLC, path }]))
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: null } },
      h.deps,
    )
    expect(h.gitCalls).toEqual(['remove linked /zlc', 'remove'])
    expect(existsSync(path)).toBe(false)
  })

  it('AC12: logs the cleanup’s removals with caller cleanup, and sends no event', async () => {
    const h = harness({})
    const runDir = join(h.home, 'runs', RUN.id)
    mkdirSync(runDir, { recursive: true })
    const path = join(h.home, 'worktrees', `${RUN.id}-linked`, 'ZLC')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(runDir, 'linked.json'), JSON.stringify([{ ...ZLC, path }]))
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: null } },
      h.deps,
    )
    expect(h.log().map((l) => `${l.action} ${l.caller} ${l.result}`)).toEqual([
      'remove cleanup removed',
      'delete cleanup deleted',
      'remove cleanup removed',
    ])
    expect(h.of('tool_call')).toEqual([])
  })

  it('AC15: refuses a worktree path that belongs to another run', async () => {
    const h = harness({})
    const other = join(h.home, 'worktrees', 'another-run')
    mkdirSync(other, { recursive: true })
    await cleanUp(
      { kind: 'cleanup', run: { id: RUN.id, repo_path: '/repo', worktree_path: other } },
      h.deps,
    )
    expect(h.gitCalls).toEqual([])
    expect(existsSync(other)).toBe(true)
    expect(h.log().map((l) => l.result)).toContain('refused')
    expect(h.log().find((l) => l.result === 'refused')?.path).toBe(other)
  })
})

describe('the run’s end and its removals', () => {
  const start = START as Extract<Work, { kind: 'start' }>
  const failing: Work = { ...start, run: { ...RUN, spec: null } }

  it('AC4: keeps the worktree when the board refuses run_end, and says why', async () => {
    const error = new ApiError(401, 'Unauthorized', undefined)
    const h = harness({ runEndFails: error })
    const worktree = join(h.home, 'worktrees', RUN.id)

    await expect(carryOut(failing, h.deps)).rejects.toBe(error)

    expect(h.gitCalls).not.toContain('remove')
    expect(existsSync(worktree)).toBe(true)
    const ending = h.log().filter((l) => l.caller === 'run_end')
    expect(ending).toHaveLength(1)
    expect(ending[0]).toMatchObject({
      action: 'keep',
      caller: 'run_end',
      result: 'kept',
      output: error.message,
    })
  })

  it('AC5: removes the worktree when run_end is spooled for a network failure', async () => {
    const h = harness({ runEndFails: new TypeError('fetch failed') })
    const outcome = await carryOut(failing, h.deps)
    expect(outcome).toBe('failed')
    expect(readFileSync(join(h.home, 'events.ndjson'), 'utf8')).toContain('"run_end"')
    expect(h.log().find((l) => l.caller === 'run_end')?.result).toBe('removed')
    expect(existsSync(join(h.home, 'worktrees', RUN.id))).toBe(false)
  })

  it('AC6: sends run_end first, then the removal as a runner tool call', async () => {
    const h = harness({})
    await carryOut(failing, h.deps)
    const types = h.sent.map((e) => e.type)
    const endAt = types.indexOf('run_end')
    const removal = h.sent.findIndex((e) => e.tool === 'remove_worktree')
    expect(endAt).toBeGreaterThan(-1)
    expect(removal).toBeGreaterThan(endAt)
    expect(h.sent[removal]).toMatchObject({
      agent: 'runner',
      target: join(h.home, 'worktrees', RUN.id),
      status: 'ok',
      payload: { action: 'remove', caller: 'run_end', result: 'removed', run_id: RUN.id },
    })
  })

  it('AC8: cuts git’s output at 4,096 characters and ends the run as before', async () => {
    const output = `${'a'.repeat(5_904)}${'z'.repeat(4_096)}`
    const h = harness({ removeFails: new GitError('git worktree remove', output) })
    expect(await carryOut(failing, h.deps)).toBe('failed')
    const line = h.log().find((l) => l.caller === 'run_end' && l.action === 'remove')
    expect(line).toMatchObject({ result: 'failed', output: 'z'.repeat(4_096) })
    const event = h.sent.find((e) => e.tool === 'remove_worktree')
    expect(event).toMatchObject({ status: 'error', payload: { output: 'z'.repeat(4_096) } })
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed' } })
  })

  it('AC10: removes the worktree although the log cannot be written', async () => {
    const h = harness({})
    mkdirSync(join(h.home, LOG_FILE))
    expect(await carryOut(failing, h.deps)).toBe('failed')
    expect(existsSync(join(h.home, 'worktrees', RUN.id))).toBe(false)
  })

  it('AC11: logs a remove line per checkout and a delete line for the -linked directory', async () => {
    const h = harness({})
    const two: Work = {
      ...failing,
      run: {
        ...RUN,
        spec: null,
        links: [
          {
            key: 'ZLC',
            name: 'Z',
            note: '',
            repo_path: '/zlc',
            github_repo: 'o/z',
            base_branch: 'main',
          },
          {
            key: 'ZLR',
            name: 'R',
            note: '',
            repo_path: '/zlr',
            github_repo: 'o/r',
            base_branch: 'main',
          },
        ],
      },
    }
    await carryOut(two, h.deps)
    const ours = h.log().filter((l) => l.caller === 'run_end')
    expect(ours.filter((l) => l.action === 'remove' && l.path.includes('-linked'))).toHaveLength(2)
    expect(ours.filter((l) => l.action === 'delete')).toHaveLength(1)
  })

  it('AC13: logs absent paths, calls no git and sends no removal event', async () => {
    const h = harness({ worktreeGone: true })
    await carryOut(failing, h.deps)
    const ours = h.log().filter((l) => l.caller === 'run_end')
    expect(ours.map((l) => `${l.action} ${l.result}`)).toEqual(['remove absent', 'delete absent'])
    expect(h.gitCalls).not.toContain('remove')
    expect(h.sent.some((e) => e.tool === 'remove_worktree')).toBe(false)
  })
})

describe('the files gate', () => {
  const start = START as Extract<Work, { kind: 'start' }>
  const EXTRA = { committed: ['src/extra.ts'] }
  const resumeAt = (cp: Checkpoint, allowed?: string[]) =>
    resume(cp, INTERRUPTED, allowed) as Extract<Work, { kind: 'resume' }>
  const gateFailure = (attempt: number): Checkpoint => ({
    ...checkpoint('build', attempt),
    failing_report_id: 'files_gate',
  })

  it('AC10: a commit outside the plan skips the test command and sends Build round again', async () => {
    const h = harness({ trees: [EXTRA, {}] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start plan-1',
      'start build-1',
      'start build-2',
      'start verify-2',
    ])
    expect(h.testRuns).toHaveLength(1)
    expect(readFileSync(join(RUN_DIR(h.home), 'files-gate-report.md'), 'utf8')).toContain(
      'src/extra.ts',
    )
    const second = h.checkpoints().find((c) => c.stage === 'build' && c.attempt === 2)
    expect(second).toMatchObject({ failing_report_id: 'files_gate' })
    for (const text of ['src/extra.ts', 'not in the plan', 'out_of_plan', 'migration'])
      expect(h.handoffs['build-2']).toContain(text)
  })

  it('AC11: an untracked file and no commit hands the gate report, not the no-commit text', async () => {
    const h = harness({ commits: [0, 1], trees: [{ uncommitted: ['src/extra.ts'] }, {}] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.handoffs['build-2']).toContain('src/extra.ts')
    expect(h.handoffs['build-2']).not.toContain('made no commit')
  })

  it('AC12: once the owner allows the file, the test command runs and Verify follows', async () => {
    const h = withPlan(harness({ initial: EXTRA }))
    const allowed = ['src/retry.ts', 'src/extra.ts']
    const at = { ...checkpoint('tests', 2), failing_report_id: 'files_gate' }
    expect(await carryOut(resumeAt(at, allowed), h.deps)).toBe('review')
    expect(h.calls).toContain('start verify-2')
    expect(h.testRuns).toHaveLength(1)
  })

  describe('an approved migration the build changed', () => {
    const M = 'server/src/db/migrations/004_x.ts'
    const APPROVED = 'export const x = 1\n'
    const atTests = (attempt: number) =>
      ({
        ...resume(checkpoint('tests', attempt), INTERRUPTED, []),
        approved_migrations: [{ path: M, content: APPROVED }],
      }) as Extract<Work, { kind: 'resume' }>
    const withGit = (h: ReturnType<typeof harness>, head: string | null) => {
      Object.assign(h.deps.git, { fileAtHead: async () => head })
      return h.deps
    }
    const writeWorktreeFile = (h: ReturnType<typeof harness>, content: string) => {
      const file = join(h.home, 'worktrees', RUN.id, M)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, content)
    }

    it('AC19: skips the test command, names the path in the report and goes back to Build', async () => {
      const h = withPlan(harness({ initial: { uncommitted: [M] } }))
      writeWorktreeFile(h, 'export const x = 2\n')
      await carryOut(atTests(1), withGit(h, null))
      expect(h.testRuns).toHaveLength(0)
      const report = readFileSync(join(RUN_DIR(h.home), 'files-gate-report.md'), 'utf8')
      expect(report).toContain(
        `\`${M}\` – a migration that differs from the one the owner approved`,
      )
      expect(h.calls).toContain('start build-2')
    })
    it('AC19: ends the run failed on attempt 3', async () => {
      const h = withPlan(harness({ initial: { uncommitted: [M] } }))
      writeWorktreeFile(h, 'export const x = 2\n')
      expect(await carryOut(atTests(3), withGit(h, null))).toBe('failed')
      expect(h.runEnd()).toMatchObject({
        payload: { reason: expect.stringContaining(M) },
      })
      expect(h.testRuns).toHaveLength(0)
    })
    it('hands every Build session the approved content, a restarted one included', async () => {
      const h = withPlan(harness({ initial: { uncommitted: [M] } }))
      writeWorktreeFile(h, 'export const x = 2\n')
      await carryOut(atTests(1), withGit(h, null))
      expect(h.handoffs['build-2']).toContain(
        `<approved_migration path="${M}">\n\`\`\`\n${APPROVED}\`\`\`\n</approved_migration>`,
      )
    })
    it('lets the tests run when the file holds the approved content', async () => {
      const h = withPlan(harness({ initial: { uncommitted: [M] } }))
      writeWorktreeFile(h, 'export const x = 1\r\n')
      expect(await carryOut(atTests(1), withGit(h, null))).toBe('review')
      expect(h.testRuns).toHaveLength(1)
    })
  })

  it('AC13: a Build resumed after a refusal is handed the report file, with no git command', async () => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    mkdirSync(RUN_DIR(h.home), { recursive: true })
    writeFileSync(join(RUN_DIR(h.home), 'files-gate-report.md'), 'REPORT-TEXT-FROM-FILE')
    expect(await carryOut(resumeAt(gateFailure(2)), h.deps)).toBe('released')
    expect(h.handoffs['build-2']).toContain('REPORT-TEXT-FROM-FILE')
    expect(h.changed()).toBe(0)
  })

  it('AC13: with the report file missing, the handoff tells the builder to check its files', async () => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    await carryOut(resumeAt(gateFailure(2)), h.deps)
    expect(h.handoffs['build-2']).toContain("only the plan's files")
  })

  it('AC13: a run resumed at the tests stage runs the gate again', async () => {
    const h = withPlan(harness({ initial: EXTRA, trees: [{}] }))
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('review')
    expect(h.calls.filter((c) => c.startsWith('start'))).toEqual([
      'start build-2',
      'start verify-2',
    ])
    expect(h.handoffs['build-2']).toContain('src/extra.ts')
    expect(h.testRuns).toHaveLength(1)
  })

  it('AC14: a failing git command blocks at the tests stage, and Resume runs the gate again', async () => {
    const h = withPlan(harness({ changedFails: [1] }))
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('released')
    expect(h.testRuns).toHaveLength(0)
    expect(h.of('error').at(-1)).toMatchObject({
      payload: {
        blocks: true,
        cause: 'step_failed',
        stage: 'tests',
        command: 'git -C wt merge-base HEAD origin/main',
      },
    })
    expect(h.runEnd()).toBeUndefined()
    expect(await carryOut(resumeAt(checkpoint('tests', 1)), h.deps)).toBe('review')
    expect(h.testRuns).toHaveLength(1)
  })

  it.each(['allowed-files.json', 'approved-migrations.json', 'excluded-paths.json'])(
    'AC10: a malformed %s fails a run resumed at the tests stage, and the test command does not run',
    async (name) => {
      const h = withPlan(harness({}))
      mkdirSync(RUN_DIR(h.home), { recursive: true })
      writeFileSync(join(RUN_DIR(h.home), name), 'not json')
      expect(await carryOut(resumeAt(checkpoint('tests', 1), []), h.deps)).toBe('failed')
      expect(h.runEnd()).toMatchObject({
        payload: { outcome: 'failed', reason: expect.stringContaining(name) },
      })
      expect(h.testRuns).toHaveLength(0)
    },
  )

  const many = Array.from({ length: 22 }, (_, i) => `p${String(i).padStart(2, '0')}.ts`)
  it('AC15: ends the run on the third refusal, naming up to 20 paths', async () => {
    const h = harness({ trees: [EXTRA, EXTRA, { committed: many }] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.calls.filter((c) => c.startsWith('start build'))).toHaveLength(3)
    expect(h.runEnd()).toMatchObject({
      payload: {
        reason: `the build changed files the run does not allow, on attempt 3: ${many.slice(0, 20).join(', ')}, and 2 more`,
      },
    })
  })

  it('AC15: names the paths when attempts 1 and 2 failed at Verify', async () => {
    const h = harness({ trees: [{}, {}, EXTRA], verdicts: ['fail', 'fail'] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({
      payload: {
        reason: 'the build changed files the run does not allow, on attempt 3: src/extra.ts',
      },
    })
  })

  it('AC16: sends a files_gate event with the violations, and an ok one when there are none', async () => {
    const h = harness({ trees: [{ committed: ['src/extra.ts'], uncommitted: ['notes.txt'] }, {}] })
    await carryOut(start, h.deps)
    const gates = h.of('tool_call').filter((e) => e.tool === 'files_gate')
    expect(gates).toHaveLength(2)
    expect(gates[0]).toMatchObject({
      agent: 'runner',
      status: 'error',
      target: '2 paths the run does not allow',
      payload: {
        violations: [
          { path: 'src/extra.ts', reason: 'not in the plan', committed: true },
          { path: 'notes.txt', reason: 'not in the plan', committed: false },
        ],
      },
    })
    expect(gates[1]).toMatchObject({
      status: 'ok',
      target: 'every changed path is allowed',
      payload: { violations: [] },
    })
  })

  it('AC16: words one violation in the singular', async () => {
    const h = harness({ trees: [{ committed: ['src/extra.ts'] }, {}] })
    await carryOut(start, h.deps)
    expect(h.of('tool_call').find((e) => e.tool === 'files_gate')).toMatchObject({
      target: '1 path the run does not allow',
    })
  })

  it('AC19: pushes nothing and fails the run when Verify moved HEAD', async () => {
    const h = harness({ verifyHeads: ['def456'] })
    expect(await carryOut(start, h.deps)).toBe('failed')
    expect(h.writes).toEqual([])
    expect(h.gitCalls).not.toContain(`push ${BRANCH}`)
    expect(h.runEnd()).toMatchObject({
      payload: {
        outcome: 'failed',
        reason: 'Verify changed the branch: HEAD is def456, Build ended on abc123',
      },
    })
  })

  it('AC19: pushes as today when HEAD is where the gate left it', async () => {
    const h = harness({ verifyHeads: ['abc123'] })
    expect(await carryOut(start, h.deps)).toBe('review')
    expect(h.gitCalls).toContain(`push ${BRANCH}`)
  })

  describe('exclusions', () => {
    it('AC6: a file the runner’s test run wrote is excluded on the next attempt', async () => {
      const h = harness({
        trees: [{}, { uncommitted: ['coverage.txt'] }],
        testWrites: [['coverage.txt']],
        verdicts: ['fail', 'pass'],
      })
      expect(await carryOut(start, h.deps)).toBe('review')
      expect(
        JSON.parse(readFileSync(join(RUN_DIR(h.home), 'excluded-paths.json'), 'utf8')),
      ).toEqual(['coverage.txt'])
      expect(h.testRuns).toHaveLength(2)
    })

    it('AC7: before any runner test run, a file the builder’s own test run left is a violation', async () => {
      const h = harness({ trees: [{ uncommitted: ['coverage.txt'] }, {}] })
      expect(await carryOut(start, h.deps)).toBe('review')
      expect(h.handoffs['build-2']).toContain('`coverage.txt` – not in the plan (uncommitted)')
      expect(h.handoffs['build-2']).toContain('delete the file if a command you ran generated it')
    })

    it('records what setup left in the worktree as excluded', async () => {
      const setup = 'npm ci'
      const h = harness({ setupCommand: setup, afterSetup: ['package-lock.json'] })
      const work = {
        kind: 'start',
        run: { ...RUN, project: { ...RUN.project, setup_command: setup } },
      } as Extract<Work, { kind: 'start' }>
      expect(await carryOut(work, h.deps)).toBe('review')
      expect(
        JSON.parse(readFileSync(join(RUN_DIR(h.home), 'excluded-paths.json'), 'utf8')),
      ).toEqual(['package-lock.json'])
    })
  })
})

const START_FAILURE = new StartFailure('/missing/claude', 'spawn /missing/claude ENOENT')

describe('a process that fails to start', () => {
  it('AC11: blocks the run as step_failed and keeps the worktree', async () => {
    const h = harness({ startThrows: START_FAILURE })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('released')
    const errors = h.of('error')
    expect(errors.at(-1)).toMatchObject({
      payload: {
        blocks: true,
        cause: 'step_failed',
        stage: 'plan',
        command: '/missing/claude',
        output: 'spawn /missing/claude ENOENT',
      },
    })
    expect(h.checkpoints().at(-1)).toMatchObject({ stage: 'plan' })
    expect(h.sent.findIndex((e) => e.type === 'checkpoint')).toBeLessThan(
      h.sent.findIndex((e) => e.type === 'error'),
    )
    expect(h.runEnd()).toBeUndefined()
    expect(h.gitCalls).not.toContain('remove')
  })

  it('AC13: a plain error still ends the run failed', async () => {
    const h = harness({ startThrows: new Error('boom') })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed', reason: 'boom' } })
  })

  it('AC15: Resume resumes the session the failed start was given, then restarts it if gone', async () => {
    const first = harness({ startThrows: START_FAILURE })
    await carryOut(START as Extract<Work, { kind: 'start' }>, first.deps)
    const blocked = first.checkpoints().at(-1)!
    expect(blocked.phase_id).not.toBeNull()
    expect(blocked.session?.id).toBeDefined()

    const again = withPlan(harness({ acts: { 'plan-1': ['gone', 'ok'] }, hasMessages: false }))
    const work = resume(blocked, INTERRUPTED, [])
    await carryOut(work as Extract<Work, { kind: 'resume' }>, again.deps)
    expect(again.calls.some((c) => c.startsWith('resume plan-1'))).toBe(true)
    expect(again.calls).toContain('restart plan-1')
    expect(again.restarts).toHaveLength(1)
    expect(again.restarts[0]?.phaseId).toBe(blocked.phase_id)
    expect(again.restarts[0]?.handoff).toContain('phase="plan" attempt="1"')
    expect(
      again.sent.some(
        (e) => e.type === 'run_end' && (e.payload as { outcome?: string }).outcome === 'failed',
      ),
    ).toBe(false)
  })
})

describe('a Plan-stage resume refreshes the base first', () => {
  const SETUP = 'npm ci'
  const WITH_SETUP: RunWork = { ...RUN, project: { ...RUN.project, setup_command: SETUP } }
  const claim = (
    message: string | null,
    run: RunWork = WITH_SETUP,
    cp = checkpoint('plan', 1, 'plan-phase'),
  ) => ({ ...resume(cp, message), run }) as Extract<Work, { kind: 'resume' }>
  const seed = (h: ReturnType<typeof harness>, files: Record<string, string>) => {
    mkdirSync(RUN_DIR(h.home), { recursive: true })
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(RUN_DIR(h.home), name), text)
  }
  const file = (h: ReturnType<typeof harness>, name: string) => join(RUN_DIR(h.home), name)
  const NOTE_FOR_B = (h: ReturnType<typeof harness>) =>
    h.calls.find((c) => c.startsWith('resume plan-1'))!
  const answerEvents = (h: ReturnType<typeof harness>) =>
    h.of('tool_call').filter((e) => e.tool === 'saved_answer')

  const MOVE = { head: 'def456', commits: 3, paths: ['a.ts', 'b.ts'] }

  it.each<[string, string | null, boolean]>([
    ['words at the gate', 'Split step 2.', true],
    ['Approve plan', null, false],
    ['an answer to the planner’s own question', 'The owner answered your question:\n\nBlue', true],
    ['Resume after a block', INTERRUPTED, true],
  ])(
    'AC1, AC2: %s fetches, fast-forwards and sets up once, before any phase',
    async (_n, message, planner) => {
      const h = withPlan(harness({ setupCommand: SETUP, moveTo: MOVE }))
      await carryOut(claim(message), h.deps)
      // The tests stage fetches and sets up again later; the refresh is what comes before any phase.
      const refresh = h.order.slice(0, h.order.indexOf('phase'))
      expect(refresh).toEqual(['fetch', 'undo', 'ff', 'setup'])
      expect(h.order.filter((o) => o === 'ff')).toHaveLength(1)
      expect(h.calls.some((c) => c.startsWith('resume plan'))).toBe(planner)
      if (!planner) expect(h.calls.slice(0, 2)).toEqual(['end plan-1 ok', 'start build-1'])
    },
  )

  // The tests stage fetches by itself (R5); only the refresh fast-forwards.
  it.each<[string, Checkpoint, RunWork, string]>([
    ['Build', checkpoint('build', 1, 'build-phase'), WITH_SETUP, 'phase'],
    ['tests', checkpoint('tests', 1), WITH_SETUP, 'fetch'],
    ['Verify', checkpoint('verify', 1, 'verify-phase'), WITH_SETUP, 'phase'],
    [
      'a kept plan',
      checkpoint('plan', 1),
      { ...WITH_SETUP, kept_plan: { artifact_id: 'plan-1', from_run: 1 } },
      'phase',
    ],
  ])('AC3: a resume in %s does no refresh', async (_n, cp, run, first) => {
    const h = withPlan(harness({ setupCommand: SETUP, moveTo: MOVE }))
    await carryOut(claim(INTERRUPTED, run, cp), h.deps)
    expect(h.order).not.toContain('ff')
    expect(h.order[0]).toBe(first)
  })

  it('AC3: a Build resume gets its message unchanged and writes no plan-base.txt', async () => {
    const h = withPlan(harness({ moveTo: MOVE }))
    await carryOut(claim('Blue', RUN, checkpoint('build', 1, 'build-phase')), h.deps)
    expect(h.calls[0]).toBe('resume build-1: Blue')
    expect(existsSync(file(h, 'plan-base.txt'))).toBe(false)
  })

  it.each<[string, Script, string]>([
    ['the fetch', { fails: 'fetch' }, 'git fetch origin main'],
    ['the fast-forward', { fails: 'ff' }, 'git merge --ff-only origin/main'],
    ['a linked project’s checkout', { fails: 'link' }, 'git -C /chr fetch origin main'],
  ])('AC6, AC9: %s failing blocks the run at plan, with no phase', async (_n, script, command) => {
    const h = withPlan(harness(script))
    const run: RunWork = {
      ...RUN,
      links: [
        {
          key: 'CHR',
          name: 'c',
          note: '',
          repo_path: '/chr',
          github_repo: 'o/c',
          base_branch: 'main',
        },
      ],
    }
    expect(await carryOut(claim('Go', run), h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: { blocks: true, cause: 'step_failed', stage: 'plan', command },
    })
    expect(h.checkpoints().at(-1)?.stage).toBe('plan')
    expect(h.order).not.toContain('phase')
  })

  it('AC7: remakes the checkouts from the current links, not restoring the stale one', async () => {
    const h = withPlan(harness({ confidence: ['medium'] }))
    const link = (key: string) => ({
      key,
      name: key,
      note: 'n',
      repo_path: `/${key.toLowerCase()}`,
      github_repo: `o/${key}`,
      base_branch: 'main',
    })
    const path = join(h.home, 'worktrees', `${RUN.id}-linked`)
    seed(h, { 'linked.json': JSON.stringify([{ ...link('ZLC'), path: join(path, 'ZLC') }]) })
    const run: RunWork = { ...RUN, links: [link('CHR'), link('ZLR')] }
    // No session: the planner starts, and its handoff names the checkouts.
    const work = claim('Go', run, checkpoint('plan', 1))
    expect(await carryOut(work, h.deps)).toBe('released')
    expect(h.gitCalls).toContain(`linked /chr main ${join(path, 'CHR')}`)
    expect(h.gitCalls).toContain(`linked /zlr main ${join(path, 'ZLR')}`)
    expect(h.gitCalls.filter((c) => c.startsWith('linked /zlc'))).toEqual([])
    const listed = JSON.parse(readFileSync(file(h, 'linked.json'), 'utf8')) as { key: string }[]
    expect(listed.map((c) => c.key)).toEqual(['CHR', 'ZLR'])
    expect(h.handoffs['plan-1']).toContain('CHR')
    expect(h.handoffs['plan-1']).toContain('ZLR')
    expect(h.handoffs['plan-1']).not.toContain('ZLC')
  })

  it('AC8: a run with no linked.json gets its link checked out and listed', async () => {
    const h = withPlan(harness({ confidence: ['medium'] }))
    const run: RunWork = {
      ...RUN,
      links: [
        {
          key: 'CHR',
          name: 'c',
          note: '',
          repo_path: '/chr',
          github_repo: 'o/c',
          base_branch: 'main',
        },
      ],
    }
    await carryOut(claim('Go', run), h.deps)
    expect(h.gitCalls.some((c) => c.startsWith('linked /chr'))).toBe(true)
    expect(readFileSync(file(h, 'linked.json'), 'utf8')).toContain('"CHR"')
  })

  it('AC10: runs setup once as a tool_call and records what it left as excluded', async () => {
    const h = withPlan(harness({ setupCommand: SETUP, afterSetup: ['package-lock.json'] }))
    await carryOut(claim('Go'), h.deps)
    expect(h.of('tool_call').filter((e) => e.tool === 'setup_command')).toHaveLength(1)
    expect(JSON.parse(readFileSync(file(h, 'excluded-paths.json'), 'utf8'))).toEqual([
      'package-lock.json',
    ])
  })

  it('AC10: a project without setup gets an empty excluded list', async () => {
    const h = withPlan(harness({}))
    seed(h, { 'excluded-paths.json': '["old"]' })
    await carryOut(claim('Go', RUN), h.deps)
    expect(JSON.parse(readFileSync(file(h, 'excluded-paths.json'), 'utf8'))).toEqual([])
  })

  it('AC10: a failing setup blocks at plan with no phase', async () => {
    const h = withPlan(harness({ setupCommand: SETUP, setupExits: [1] }))
    expect(await carryOut(claim('Go'), h.deps)).toBe('released')
    expect(h.of('error').at(-1)).toMatchObject({
      payload: { cause: 'step_failed', stage: 'plan', command: SETUP },
    })
    expect(h.order).not.toContain('phase')
  })

  describe('the base-moved note', () => {
    it.each<[string, Record<string, string>]>([
      ['plan-base.txt names the old commit', { 'plan-base.txt': 'abc123' }],
      ['a run paused before the file existed', {}],
    ])('AC11: %s: the session gets the note, then the message', async (_n, files) => {
      const h = withPlan(harness({ moveTo: MOVE }))
      seed(h, files)
      await carryOut(claim('Split step 2.', RUN), h.deps)
      const message = h.calls.find((c) => c.startsWith('resume plan-1'))!
      expect(message).toContain('abc123')
      expect(message).toContain('def456')
      expect(message).toContain('3 commits')
      expect(message).toContain('a.ts\nb.ts')
      expect(message.endsWith('\n\nSplit step 2.')).toBe(true)
      expect(readFileSync(file(h, 'plan-base.txt'), 'utf8')).toBe('def456')
    })

    it('AC13: with the base unmoved the message is exactly the incoming one', async () => {
      const h = withPlan(harness({}))
      seed(h, { 'plan-base.txt': 'abc123' })
      await carryOut(claim('Split step 2.', RUN), h.deps)
      expect(h.calls[0]).toBe('resume plan-1: Split step 2.')
    })

    it.each<[string, Record<string, string>]>([
      ['with plan-base.txt naming A', { 'plan-base.txt': 'abc123' }],
      ['with no plan-base.txt', {}],
    ])(
      'AC14: a refresh that moved HEAD and blocked still gives the note next time, %s',
      async (_n, files) => {
        const h = withPlan(harness({ setupCommand: SETUP, setupExits: [1, 0], moveTo: MOVE }))
        seed(h, files)
        expect(await carryOut(claim('Split step 2.'), h.deps)).toBe('released')
        expect(h.order).not.toContain('phase')
        expect(await carryOut(claim('Split step 2.'), h.deps)).toBe('review')
        const message = NOTE_FOR_B(h)
        expect(message).toContain('abc123')
        expect(message).toContain('def456')
        expect(message.endsWith('\n\nSplit step 2.')).toBe(true)
      },
    )

    it('AC15: Approve plan with a moved base refreshes, then starts Build with no planner resume', async () => {
      const h = withPlan(harness({ moveTo: MOVE }))
      await carryOut(claim(null, RUN), h.deps)
      expect(h.order[0]).toBe('fetch')
      expect(h.calls.some((c) => c.startsWith('resume'))).toBe(false)
      expect(h.handoffs['build-1']).toContain('<plan>')
    })
  })

  describe('the saved answer', () => {
    const SAVED_WORDS = JSON.stringify({ kind: 'words', text: 'Split step 2.' })
    const WORDS_TARGET = "delivered the owner's answer kept from before the block"
    const APPROVAL_TARGET = 'went on to Build on the Approve plan kept from before the block'

    it('AC16: the planner gets the saved words in place of the nudge, announced, and the file goes', async () => {
      const h = withPlan(harness({}))
      seed(h, { 'pending-answer.json': SAVED_WORDS })
      await carryOut(claim(INTERRUPTED, RUN), h.deps)
      expect(h.calls[0]).toBe('resume plan-1: Split step 2.')
      expect(answerEvents(h)).toHaveLength(1)
      expect(answerEvents(h)[0]).toMatchObject({
        target: WORDS_TARGET,
        status: 'ok',
        agent: 'runner',
      })
      expect(existsSync(file(h, 'pending-answer.json'))).toBe(false)
    })

    it('AC17: saved approval goes to Build; the file goes once the build checkpoint is sent', async () => {
      const h = withPlan(harness({}))
      seed(h, { 'pending-answer.json': JSON.stringify({ kind: 'approved' }) })
      let atBuildCheckpoint: boolean | undefined
      const send = h.deps.sink.send.bind(h.deps.sink)
      h.deps.sink.send = async (events) => {
        const result = await send(events)
        if (
          atBuildCheckpoint === undefined &&
          events.some(
            (e) => e.type === 'checkpoint' && (e.payload as { stage?: string }).stage === 'build',
          )
        )
          atBuildCheckpoint = existsSync(file(h, 'pending-answer.json'))
        return result
      }
      await carryOut(claim(INTERRUPTED, RUN), h.deps)
      expect(h.calls.some((c) => c.startsWith('resume'))).toBe(false)
      expect(h.calls.slice(0, 2)).toEqual(['end plan-1 ok', 'start build-1'])
      expect(answerEvents(h)[0]).toMatchObject({ target: APPROVAL_TARGET })
      // The file was still there when the checkpoint was sent, and gone afterwards.
      expect(atBuildCheckpoint).toBe(true)
      expect(existsSync(file(h, 'pending-answer.json'))).toBe(false)
    })

    it('AC18: words are cleared after a normal return, and a shutdown-stopped process gives a plain nudge next', async () => {
      const done = withPlan(harness({}))
      await carryOut(claim('Split step 2.', RUN), done.deps)
      expect(existsSync(file(done, 'pending-answer.json'))).toBe(false)

      const h = withPlan(harness({ acts: { 'plan-1': ['shutdown'] } }))
      expect(await carryOut(claim('Split step 2.', RUN), h.deps)).toBe('released')
      expect(existsSync(file(h, 'pending-answer.json'))).toBe(false)
      const again = withPlan(harness({}))
      seed(again, {})
      await carryOut(claim(INTERRUPTED, RUN), again.deps)
      expect(again.calls[0]).toBe(`resume plan-1: ${INTERRUPTED}`)
      expect(answerEvents(again)).toEqual([])
    })

    it('AC19: a process that fails to start leaves the answer in the file', async () => {
      const h = withPlan(harness({ phaseThrows: true }))
      await carryOut(claim('Split step 2.', RUN), h.deps)
      expect(JSON.parse(readFileSync(file(h, 'pending-answer.json'), 'utf8'))).toEqual({
        kind: 'words',
        text: 'Split step 2.',
      })
    })

    it('AC14: a process that fails to start with the typed error leaves the answer too', async () => {
      const h = withPlan(harness({ phaseThrows: START_FAILURE }))
      await carryOut(claim('Split step 2.', RUN), h.deps)
      expect(JSON.parse(readFileSync(file(h, 'pending-answer.json'), 'utf8'))).toEqual({
        kind: 'words',
        text: 'Split step 2.',
      })
    })

    it('AC16: a blocked refresh keeps the answer, and the next Resume delivers it', async () => {
      const h = withPlan(harness({ setupCommand: SETUP, setupExits: [1, 0] }))
      await carryOut(claim('Split step 2.'), h.deps)
      expect(existsSync(file(h, 'pending-answer.json'))).toBe(true)
      await carryOut(claim(INTERRUPTED), h.deps)
      expect(h.calls[0]).toBe('resume plan-1: Split step 2.')
    })

    it('AC20: a message other than the nudge is delivered, not the saved one', async () => {
      const h = withPlan(harness({ fails: 'ff' }))
      seed(h, { 'pending-answer.json': SAVED_WORDS })
      await carryOut(claim('Something else.', RUN), h.deps)
      expect(JSON.parse(readFileSync(file(h, 'pending-answer.json'), 'utf8'))).toEqual({
        kind: 'words',
        text: 'Something else.',
      })
      const ok = withPlan(harness({}))
      seed(ok, { 'pending-answer.json': SAVED_WORDS })
      await carryOut(claim('Something else.', RUN), ok.deps)
      expect(ok.calls[0]).toBe('resume plan-1: Something else.')
      expect(answerEvents(ok)).toEqual([])
    })

    it('AC21: a nudge with nothing saved reaches the planner as the nudge, after any note', async () => {
      const h = withPlan(harness({ moveTo: MOVE }))
      seed(h, { 'plan-base.txt': 'abc123' })
      await carryOut(claim(INTERRUPTED, RUN), h.deps)
      expect(h.calls[0]!.endsWith(`\n\n${INTERRUPTED}`)).toBe(true)
      expect(answerEvents(h)).toEqual([])
    })
  })
})

// The tests stage runs on the base as it stands (AIDP-54).
describe('the tests stage on the current base', () => {
  const SETUP = 'npm ci'
  const WITH_SETUP: RunWork = { ...RUN, project: { ...RUN.project, setup_command: SETUP } }
  const dir = (h: ReturnType<typeof harness>) => RUN_DIR(h.home)
  const seed = (h: ReturnType<typeof harness>, files: Record<string, string>) => {
    mkdirSync(dir(h), { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir(h), name), text)
  }
  const text = (h: ReturnType<typeof harness>, name: string) =>
    readFileSync(join(dir(h), name), 'utf8')
  const has = (h: ReturnType<typeof harness>, name: string) => existsSync(join(dir(h), name))
  const at = (
    stage: Checkpoint['stage'],
    attempt: number,
    run: RunWork = RUN,
    phase?: string,
  ): Extract<Work, { kind: 'resume' }> =>
    ({ ...resume(checkpoint(stage, attempt, phase), INTERRUPTED), run }) as Extract<
      Work,
      { kind: 'resume' }
    >
  /** What happened before the first phase call of the tests stage's own round. */
  const beforePhase = (h: ReturnType<typeof harness>) => h.order.slice(0, h.order.indexOf('phase'))
  const events = (h: ReturnType<typeof harness>, tool: string) =>
    h.of('tool_call').filter((e) => e.tool === tool)
  const MOVED = { fetchTo: [ORIGIN] }

  interface SetupRow {
    name: string
    seed: string | null
    script: Script
    withSetup: boolean
    order: string[]
  }
  const SETUP_ROWS: SetupRow[] = [
    {
      name: 'equal to the merge-base, base not moved',
      seed: FORK,
      script: {},
      withSetup: true,
      order: ['fetch', 'gate'],
    },
    {
      name: 'different from it (the builder rebased), base not moved',
      seed: 'other',
      script: {},
      withSetup: true,
      order: ['fetch', 'undo', 'setup', 'gate'],
    },
    {
      name: 'missing, base not moved',
      seed: null,
      script: {},
      withSetup: true,
      order: ['fetch', 'undo', 'setup', 'gate'],
    },
    {
      name: 'different from it, base moved since the builder’s rebase',
      seed: 'other',
      script: MOVED,
      withSetup: true,
      order: ['fetch', 'undo', 'gate', 'undo', 'rebase', 'setup'],
    },
    {
      name: 'missing, and the project has no setup command',
      seed: null,
      script: {},
      withSetup: false,
      order: ['fetch', 'gate'],
    },
  ]
  it.each(SETUP_ROWS)('AC2: setup-base.txt $name', async (row) => {
    const h = withPlan(harness({ setupCommand: SETUP, ...row.script }))
    if (row.seed !== null) seed(h, { 'setup-base.txt': row.seed })
    await carryOut(at('tests', 1, row.withSetup ? WITH_SETUP : RUN), h.deps)
    expect(beforePhase(h)).toEqual(row.order)
    expect(h.testRuns).toHaveLength(1)
  })

  it('AC8, AC14: rebases a base that gained commits, sets up on it, and records what it tested', async () => {
    const h = withPlan(
      harness({ setupCommand: SETUP, afterSetup: ['package-lock.json'], ...MOVED }),
    )
    seed(h, { 'setup-base.txt': FORK })
    await carryOut(at('tests', 1, WITH_SETUP), h.deps)
    expect(beforePhase(h)).toEqual(['fetch', 'gate', 'undo', 'rebase', 'setup'])
    expect(text(h, 'gate-head.txt')).toBe('rebased-1')
    expect(text(h, 'tested-base.txt')).toBe(ORIGIN)
    expect(text(h, 'setup-base.txt')).toBe(ORIGIN)
    expect(JSON.parse(text(h, 'excluded-paths.json'))).toEqual(['package-lock.json'])
    expect(events(h, 'base_rebase')).toHaveLength(1)
    expect(events(h, 'base_rebase')[0]).toMatchObject({
      agent: 'runner',
      status: 'ok',
      target: `rebased onto ${ORIGIN}, 3 commits later`,
      payload: { from: FORK, to: ORIGIN, commits: 3, paths: ['a.ts'] },
    })
    expect(h.testRuns).toEqual(['npm test'])
  })

  it('AC9: an unmoved base is fetched and nothing else is done', async () => {
    const h = withPlan(harness({ setupCommand: SETUP }))
    seed(h, { 'setup-base.txt': FORK })
    await carryOut(at('tests', 1, WITH_SETUP), h.deps)
    expect(beforePhase(h)).toEqual(['fetch', 'gate'])
    expect(events(h, 'base_rebase')).toEqual([])
    expect(text(h, 'tested-base.txt')).toBe(FORK)
  })

  it('AC3: a branch the owner rebased by hand after the attempt-3 block is set up before the gate', async () => {
    const h = withPlan(harness({ setupCommand: SETUP, afterSetup: ['package-lock.json'] }))
    seed(h, { 'excluded-paths.json': '[]' })
    await carryOut(at('tests', 3, WITH_SETUP), h.deps)
    expect(beforePhase(h)).toEqual(['fetch', 'undo', 'setup', 'gate'])
    expect(JSON.parse(text(h, 'excluded-paths.json'))).toEqual(['package-lock.json'])
    expect(h.testRuns).toHaveLength(1)
  })

  it('AC4: a setup that fails after the rebase blocks at tests, and Resume undoes its leftovers first', async () => {
    const h = withPlan(
      harness({ setupCommand: SETUP, setupExits: [1, 0], afterSetup: ['lock.json'], ...MOVED }),
    )
    seed(h, { 'setup-base.txt': FORK })
    expect(await carryOut(at('tests', 1, WITH_SETUP), h.deps)).toBe('released')
    expect(h.of('error').at(-1)?.payload).toMatchObject({
      blocks: true,
      cause: 'step_failed',
      stage: 'tests',
      command: SETUP,
    })
    expect(text(h, 'setup-base.txt')).toBe(FORK)
    expect(h.testRuns).toEqual([])

    h.order.length = 0
    await carryOut(at('tests', 1, WITH_SETUP), h.deps)
    expect(beforePhase(h)).toEqual(['fetch', 'undo', 'setup', 'gate'])
    expect(events(h, 'files_gate').at(-1)).toMatchObject({
      status: 'ok',
      payload: { violations: [] },
    })
    expect(h.testRuns).toEqual(['npm test'])
    expect(text(h, 'setup-base.txt')).toBe(ORIGIN)
  })

  it('AC7: only the builder’s uncommitted paths are named when the runner rebases', async () => {
    const h = withPlan(
      harness({
        ...MOVED,
        initial: { uncommitted: ['src/retry.ts', 'lock.json'] },
      }),
    )
    seed(h, { 'excluded-paths.json': '["lock.json"]' })
    await carryOut(at('tests', 1), h.deps)
    expect(events(h, 'undo_uncommitted')).toHaveLength(1)
    expect(events(h, 'undo_uncommitted')[0]).toMatchObject({
      target: 'undid 1 paths the build left uncommitted',
      payload: { paths: ['src/retry.ts'] },
    })
  })

  it('AC7: no undo_uncommitted event when only the runner’s own paths are uncommitted', async () => {
    const h = withPlan(harness({ ...MOVED, initial: { uncommitted: ['lock.json'] } }))
    seed(h, { 'excluded-paths.json': '["lock.json"]' })
    await carryOut(at('tests', 1), h.deps)
    expect(h.order).toContain('undo')
    expect(events(h, 'undo_uncommitted')).toEqual([])
  })

  interface UndoRow {
    name: string
    uncommitted: string[]
    excluded: string[]
    undone: string[]
  }
  const UNDO_ROWS: UndoRow[] = [
    {
      name: 'an allowed edit and an excluded path',
      uncommitted: ['src/retry.ts', 'lock.json'],
      excluded: ['lock.json'],
      undone: ['src/retry.ts'],
    },
    {
      name: 'only excluded paths',
      uncommitted: ['lock.json'],
      excluded: ['lock.json'],
      undone: [],
    },
    { name: 'nothing uncommitted', uncommitted: [], excluded: [], undone: [] },
  ]
  it.each(UNDO_ROWS)('AC2, AC3: undoes only the builder’s paths first: $name', async (row) => {
    const h = withPlan(
      harness({ initial: { uncommitted: row.uncommitted }, testWrites: [['made.txt']] }),
    )
    seed(h, { 'excluded-paths.json': JSON.stringify(row.excluded), 'undone-paths.json': '["old"]' })
    await carryOut(at('tests', 1), h.deps)
    expect(h.testSaw[0]).toEqual(row.uncommitted.filter((p) => row.excluded.includes(p)))
    expect(events(h, 'undo_uncommitted')).toHaveLength(row.undone.length === 0 ? 0 : 1)
    if (row.undone.length > 0)
      expect(events(h, 'undo_uncommitted')[0]).toMatchObject({
        status: 'ok',
        target: `undid ${row.undone.length} paths the build left uncommitted`,
        payload: { paths: row.undone },
      })
    expect(JSON.parse(text(h, 'undone-paths.json'))).toEqual(row.undone)
    expect(h.order).not.toContain('setup')
    expect(JSON.parse(text(h, 'excluded-paths.json'))).toEqual([...row.excluded, 'made.txt'])
  })

  it('AC4: a Verify resumed with no test output undoes the builder’s edit before the tests', async () => {
    const h = withPlan(harness({ initial: { uncommitted: ['src/retry.ts'] } }))
    await carryOut(at('verify', 1), h.deps)
    expect(h.testSaw[0]).toEqual([])
    expect(events(h, 'undo_uncommitted')).toHaveLength(1)
    expect(JSON.parse(text(h, 'undone-paths.json'))).toEqual(['src/retry.ts'])
    expect(h.handoffs['verify-1']).toContain('Before the test command ran')
    expect(h.handoffs['verify-1']).toContain('src/retry.ts')
  })

  interface NoCommitRow {
    name: string
    seed: string
    script: Script
  }
  const NO_COMMIT_ROWS: NoCommitRow[] = [
    { name: 'setup owed', seed: 'other', script: {} },
    { name: 'a rebase owed', seed: FORK, script: MOVED },
    { name: 'neither owed', seed: FORK, script: {} },
  ]
  it.each(NO_COMMIT_ROWS)('AC6: no commit leaves the worktree alone: $name', async (row) => {
    const h = withPlan(
      harness({
        setupCommand: SETUP,
        commits: [0],
        initial: { uncommitted: ['src/retry.ts'] },
        acts: { 'build-2': ['paused'] },
        ...row.script,
      }),
    )
    seed(h, { 'setup-base.txt': row.seed })
    await carryOut({ ...at('tests', 1, WITH_SETUP), checkpoint: checkpoint('tests', 1) }, h.deps)
    expect(h.order).not.toContain('undo')
    expect(h.order).not.toContain('setup')
    expect(h.order).not.toContain('rebase')
    expect(h.testRuns).toEqual([])
    expect(events(h, 'undo_uncommitted')).toEqual([])
    expect(has(h, 'gate-head.txt')).toBe(false)
    expect(has(h, 'tested-base.txt')).toBe(false)
    expect(h.handoffs['build-2']).toContain('made no commit')
  })

  it('AC7: a no-commit stage still reports a path the run does not allow', async () => {
    const h = withPlan(
      harness({
        commits: [0],
        initial: { uncommitted: ['secret.txt'] },
        acts: { 'build-2': ['paused'] },
      }),
    )
    await carryOut(at('tests', 1), h.deps)
    expect(h.handoffs['build-2']).toContain('secret.txt')
    expect(h.handoffs['build-2']).not.toContain('made no commit')
  })

  it('AC10: with commits, setup and a rebase owed, the setup-owed undo records the edit and the R2 undo does nothing', async () => {
    const h = withPlan(
      harness({ setupCommand: SETUP, initial: { uncommitted: ['src/retry.ts'] }, ...MOVED }),
    )
    seed(h, { 'setup-base.txt': 'other' })
    await carryOut(at('tests', 1, WITH_SETUP), h.deps)
    expect(h.order.slice(0, h.order.indexOf('phase'))).toEqual([
      'fetch',
      'undo',
      'gate',
      'undo',
      'rebase',
      'setup',
    ])
    expect(events(h, 'undo_uncommitted')).toHaveLength(1)
    expect(JSON.parse(text(h, 'undone-paths.json'))).toEqual(['src/retry.ts'])
  })

  interface StaleRow {
    name: string
    script: Script
    uncommitted: string[]
    expected: string[]
  }
  const STALE_ROWS: StaleRow[] = [
    {
      name: 'a rebase in progress and a builder edit',
      script: { rebasing: { onto: ORIGIN, paths: ['x.ts'] } },
      uncommitted: ['src/retry.ts'],
      expected: ['src/retry.ts'],
    },
    { name: 'nothing undone', script: {}, uncommitted: [], expected: [] },
  ]
  it.each(STALE_ROWS)(
    'AC11: undone-paths.json holds only this stage’s paths: $name',
    async (row) => {
      const h = withPlan(
        harness({
          ...row.script,
          initial: { uncommitted: row.uncommitted },
          acts: { 'build-2': ['paused'] },
        }),
      )
      seed(h, { 'undone-paths.json': '["stale"]' })
      await carryOut(at('tests', 1), h.deps)
      expect(JSON.parse(text(h, 'undone-paths.json'))).toEqual(row.expected)
    },
  )

  const PARAGRAPH = (paths: string[]) =>
    `The runner undid these paths the build left uncommitted:\n${paths.join('\n')}\nOnly committed work is tested, shown in the diff and pushed.`
  interface ReportRow {
    name: string
    failing: string
    undone: string[]
    base: (h: ReturnType<typeof harness>) => string
  }
  const VERIFY_BODY = 'the verify report body'
  const REPORT_ROWS: ReportRow[] = []
  for (const [failing, base] of [
    ['report-x', () => VERIFY_BODY],
    ['files_gate', (h: ReturnType<typeof harness>) => text(h, 'files-gate-report.md')],
    ['base_conflict', (h: ReturnType<typeof harness>) => text(h, 'base-conflict-report.md')],
  ] as const)
    for (const undone of [['a.ts', 'b.ts'], []])
      REPORT_ROWS.push({
        name: `${failing}, ${undone.length === 0 ? 'file empty' : 'paths undone'}`,
        failing,
        undone,
        base,
      })
  REPORT_ROWS.push({
    name: 'no_commit, file empty',
    failing: 'no_commit',
    undone: [],
    base: () => 'The build made no commit, so there was nothing to verify. Commit your work.',
  })
  it.each(REPORT_ROWS)('AC14: Build report paragraph: $name', async (row) => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    h.artifacts.push({
      id: 'report-x',
      kind: 'verify_report',
      phase_id: 'v',
      body_md: VERIFY_BODY,
      uri: null,
      data: { summary: 's', criteria: [] },
    } as never)
    seed(h, {
      'undone-paths.json': JSON.stringify(row.undone),
      'files-gate-report.md': 'the gate report',
      'base-conflict-report.md': 'the conflict report',
    })
    const work = {
      ...at('build', 2),
      checkpoint: { ...checkpoint('build', 2), failing_report_id: row.failing },
    } as Extract<Work, { kind: 'resume' }>
    await carryOut(work, h.deps)
    const handoff = h.handoffs['build-2'] ?? ''
    expect(handoff).not.toContain('Before the test command ran')
    const body = row.base(h)
    if (row.undone.length > 0) expect(handoff).toContain(`${body}\n\n${PARAGRAPH(row.undone)}`)
    else {
      expect(handoff).toContain(body)
      expect(handoff).not.toContain('The runner undid these paths')
    }
  })

  interface VerifyNoteRow {
    name: string
    uncommitted: string[]
    moved: boolean
  }
  const VERIFY_NOTE_ROWS: VerifyNoteRow[] = [
    { name: 'undone paths, no base move', uncommitted: ['src/retry.ts'], moved: false },
    { name: 'undone paths and a base move', uncommitted: ['src/retry.ts'], moved: true },
    { name: 'a base move only', uncommitted: [], moved: true },
    { name: 'neither', uncommitted: [], moved: false },
  ]
  it.each(VERIFY_NOTE_ROWS)('AC13: Verify note: $name', async (row) => {
    const h = withPlan(
      harness({
        initial: { uncommitted: row.uncommitted },
        moveTo: { head: 'abc123', commits: 4, paths: ['x.ts'] },
      }),
    )
    seed(h, row.moved ? { 'build-base.txt': 'B', 'tested-base.txt': 'T' } : {})
    await carryOut(at('verify', 1), h.deps)
    const handoff = h.handoffs['verify-1'] ?? ''
    const moved =
      'The base branch moved since Build began. It was at B; the branch is now tested on T, 4 commits later.\nPaths changed between them:\nx.ts\nCheck that the change still meets the spec with these changes to the base in place.'
    const undone = `Before the test command ran, the runner undid these paths the build left uncommitted:\nsrc/retry.ts\nOnly committed work is tested, shown in the diff and pushed.`
    const expected = [
      row.moved ? moved : undefined,
      row.uncommitted.length > 0 ? undone : undefined,
    ]
      .filter((n) => n !== undefined)
      .join('\n\n')
    if (expected === '') expect(handoff).not.toContain('<note>')
    else expect(handoff).toContain(expected)
    if (!row.moved) expect(handoff).not.toContain('The base branch moved')
    if (row.uncommitted.length === 0) expect(handoff).not.toContain('Before the test command ran')
  })

  interface GateHeadRow {
    name: string
    script: Script
    head: string | null
  }
  const GATE_HEAD_ROWS: GateHeadRow[] = [
    { name: 'nothing owed', script: {}, head: 'abc123' },
    { name: 'a rebase owed', script: MOVED, head: 'rebased-1' },
    {
      name: 'a passing gate, then a rebase conflict',
      script: { ...MOVED, conflicts: [['src/a.ts']], acts: { 'build-2': ['paused'] } },
      head: null,
    },
  ]
  it.each(GATE_HEAD_ROWS)('AC9: gate-head.txt is written once, at the end: $name', async (row) => {
    const h = withPlan(harness(row.script))
    await carryOut(at('tests', 1), h.deps)
    expect(h.order).toContain('gate')
    if (row.head === null) expect(has(h, 'gate-head.txt')).toBe(false)
    else expect(text(h, 'gate-head.txt')).toBe(row.head)
  })

  describe('a conflict with the base', () => {
    const CONFLICTS = ['src/a.ts', 'src/b.ts']
    const start = (script: Script) => {
      const h = withPlan(harness({ setupCommand: SETUP, fetchTo: [ORIGIN], ...script }))
      return { h, work: { ...START, run: WITH_SETUP } as Extract<Work, { kind: 'start' }> }
    }

    it('AC11: goes back to Build with the report, and does not run the tests', async () => {
      const { h, work } = start({
        conflicts: [CONFLICTS],
        acts: { 'build-2': ['paused'] },
        afterSetup: ['package-lock.json'],
      })
      expect(await carryOut(work, h.deps)).toBe('released')
      expect(h.testRuns).toEqual([])
      expect(h.order).toContain('abort')
      expect(JSON.parse(text(h, 'excluded-paths.json'))).toEqual([])
      expect(has(h, 'setup-base.txt')).toBe(false)
      expect(h.checkpoints().at(-1)).toMatchObject({
        stage: 'build',
        attempt: 2,
        failing_report_id: 'base_conflict',
      })
      const report = text(h, 'base-conflict-report.md')
      expect(report).toContain(ORIGIN)
      for (const path of CONFLICTS) expect(report).toContain(path)
      expect(report).toContain('git rebase origin/main')
      expect(h.handoffs['build-2']).toContain(`<verify_report>\n${report}`)
      expect(events(h, 'base_rebase')[0]).toMatchObject({
        status: 'error',
        target: '2 paths conflict with the base',
        payload: { to: ORIGIN, conflicts: CONFLICTS },
      })
    })

    it('AC11: the second Build round tests the rebased branch', async () => {
      const { h, work } = start({ conflicts: [CONFLICTS] })
      expect(await carryOut(work, h.deps)).toBe('review')
      expect(h.testRuns).toEqual(['npm test'])
      expect(events(h, 'base_rebase').map((e) => e.status)).toEqual(['error', 'ok'])
    })

    it('AC11: uses a fixed text when the report file is gone', async () => {
      const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
      const work = {
        ...resume({ ...checkpoint('build', 2), failing_report_id: 'base_conflict' }, null),
        run: WITH_SETUP,
      } as Extract<Work, { kind: 'resume' }>
      await carryOut(work, h.deps)
      expect(h.handoffs['build-2']).toContain(
        '<verify_report>\nThe branch conflicts with the base branch. Run `git rebase origin/main`',
      )
    })

    it('AC12: a rebase found at the start of the stage is aborted before the fetch and the gate', async () => {
      const h = withPlan(
        harness({
          rebasing: { onto: ORIGIN, paths: CONFLICTS },
          acts: { 'build-2': ['paused'] },
        }),
      )
      expect(await carryOut(at('tests', 1), h.deps)).toBe('released')
      expect(h.order[0]).toBe('abort')
      expect(h.order).not.toContain('fetch')
      expect(h.order).not.toContain('gate')
      expect(h.testRuns).toEqual([])
      expect(h.checkpoints().at(-1)).toMatchObject({
        attempt: 2,
        failing_report_id: 'base_conflict',
      })
      expect(events(h, 'base_rebase')[0]).toMatchObject({
        status: 'error',
        payload: { to: ORIGIN, conflicts: CONFLICTS },
      })
    })

    it('AC13: on attempt 3 the run is blocked at tests, not failed', async () => {
      const h = withPlan(harness({ ...MOVED, conflicts: [CONFLICTS], setupCommand: SETUP }))
      seed(h, { 'setup-base.txt': FORK })
      expect(await carryOut(at('tests', 3, WITH_SETUP), h.deps)).toBe('released')
      expect(h.runEnd()).toBeUndefined()
      const blocked = h.of('error').at(-1)?.payload as Record<string, string>
      expect(blocked).toMatchObject({
        blocks: true,
        cause: 'step_failed',
        stage: 'tests',
        command: 'git rebase origin/main',
      })
      for (const path of CONFLICTS) expect(blocked.output).toContain(path)
      expect(blocked.output).toContain('git rebase --continue')
      expect(blocked.output).toContain('then Resume.')
      expect(h.checkpoints().at(-1)).toMatchObject({ stage: 'tests', attempt: 3 })
      expect(JSON.parse(text(h, 'excluded-paths.json'))).toEqual([])
      expect(has(h, 'setup-base.txt')).toBe(false)
      expect(h.testRuns).toEqual([])
    })
  })

  interface ResumeRow {
    stage: Checkpoint['stage']
    phase?: string
    rebasing: boolean
    expected: 'resumes build' | 'base_conflict' | 'blocks' | 'gone'
  }
  const RESUMES: ResumeRow[] = [
    { stage: 'build', phase: 'build-phase', rebasing: true, expected: 'resumes build' },
    { stage: 'tests', rebasing: true, expected: 'base_conflict' },
    { stage: 'plan', phase: 'plan-phase', rebasing: true, expected: 'blocks' },
    { stage: 'verify', phase: 'verify-phase', rebasing: true, expected: 'blocks' },
    { stage: 'push', rebasing: true, expected: 'blocks' },
    { stage: 'pr', rebasing: true, expected: 'blocks' },
    { stage: 'build', phase: 'build-phase', rebasing: false, expected: 'gone' },
    { stage: 'push', rebasing: false, expected: 'gone' },
  ]
  it.each(RESUMES)(
    'AC5: a worktree off the branch at $stage, rebase in progress: $rebasing, $expected',
    async (row) => {
      const h = withPlan(
        harness({
          ...(row.rebasing
            ? { rebasing: { onto: ORIGIN, paths: ['a.ts'] } }
            : { branchNow: 'HEAD' }),
          acts: { 'build-1': ['paused'], 'build-2': ['paused'] },
        }),
      )
      const outcome = await carryOut(at(row.stage, 1, RUN, row.phase), h.deps)
      if (row.expected === 'gone') {
        expect(outcome).toBe('failed')
        expect(h.runEnd()?.payload).toMatchObject({ reason: "the run's worktree is gone" })
      } else if (row.expected === 'blocks') {
        expect(outcome).toBe('released')
        const blocked = h.of('error').at(-1)?.payload as Record<string, string>
        expect(blocked).toMatchObject({
          blocks: true,
          cause: 'step_failed',
          stage: row.stage,
          command: 'git rebase',
        })
        expect(blocked.output).toContain('`git rebase --abort`')
        expect(blocked.output).not.toContain('--continue')
        expect(h.calls).toEqual([])
      } else if (row.expected === 'resumes build') {
        expect(h.calls[0]).toMatch(/^resume build-1/)
      } else {
        expect(h.checkpoints().at(-1)).toMatchObject({
          attempt: 2,
          failing_report_id: 'base_conflict',
        })
      }
    },
  )

  it('AC6: a rebase the owner finished before Resume at push ends as Verify changing the branch', async () => {
    const h = withPlan(harness({}))
    seed(h, { 'gate-head.txt': 'before-the-rebase' })
    expect(await carryOut(at('push', 1), h.deps)).toBe('failed')
    expect(h.runEnd()?.payload).toMatchObject({
      reason: expect.stringContaining('Verify changed the branch'),
    })
  })

  it('R11: Build’s first attempt records the base it began on, once', async () => {
    const h = withPlan(harness({ acts: { 'build-1': ['paused'] } }))
    await carryOut(at('build', 1), h.deps)
    expect(text(h, 'build-base.txt')).toBe(FORK)
    writeFileSync(join(dir(h), 'build-base.txt'), 'earlier')
    await carryOut(at('build', 1), h.deps)
    expect(text(h, 'build-base.txt')).toBe('earlier')
  })

  interface NoteRow {
    name: string
    marks: { build?: string; verify?: string; tested?: string }
    note: 'Build began' | 'the last Verify' | null
    from?: string
    verifyBase: string | null
  }
  const NOTE_ROWS: NoteRow[] = [
    {
      name: 'unchanged since Build',
      marks: { build: 'B', tested: 'B' },
      note: null,
      verifyBase: 'B',
    },
    {
      name: 'moved since Build, no Verify yet',
      marks: { build: 'B', tested: 'T' },
      note: 'Build began',
      from: 'B',
      verifyBase: 'T',
    },
    {
      name: 'moved since the last Verify',
      marks: { build: 'B', verify: 'V', tested: 'T' },
      note: 'the last Verify',
      from: 'V',
      verifyBase: 'T',
    },
    {
      name: 'moved since Build but not since the last Verify',
      marks: { build: 'B', verify: 'T', tested: 'T' },
      note: null,
      verifyBase: 'T',
    },
    { name: 'no tested base', marks: { build: 'B' }, note: null, verifyBase: null },
    { name: 'no reference at all', marks: { tested: 'T' }, note: null, verifyBase: null },
  ]
  it.each(NOTE_ROWS)('AC15: $name', async (row) => {
    const h = withPlan(harness({ moveTo: { head: 'abc123', commits: 4, paths: ['x.ts', 'y.ts'] } }))
    seed(
      h,
      Object.fromEntries(
        Object.entries(row.marks).map(([mark, commit]) => [`${mark}-base.txt`, commit]),
      ),
    )
    await carryOut(at('verify', 1), h.deps)
    const handoff = h.handoffs['verify-1'] ?? ''
    if (row.note === null) expect(handoff).not.toContain('<note>')
    else {
      expect(handoff).toContain(
        `The base branch moved since ${row.note}. It was at ${row.from}; the branch is now tested on T, 4 commits later.\nPaths changed between them:\nx.ts\ny.ts\nCheck that the change still meets the spec with these changes to the base in place.`,
      )
    }
    if (row.verifyBase === null) expect(has(h, 'verify-base.txt')).toBe(false)
    else expect(text(h, 'verify-base.txt')).toBe(row.verifyBase)
  })

  it('R11: lists the first 100 paths and how many more', async () => {
    const paths = Array.from({ length: 103 }, (_, i) => `p${String(i).padStart(3, '0')}.ts`)
    const h = withPlan(harness({ moveTo: { head: 'abc123', paths } }))
    seed(h, { 'build-base.txt': 'B', 'tested-base.txt': 'T' })
    await carryOut(at('verify', 1), h.deps)
    expect(h.handoffs['verify-1']).toContain(`${paths[99]}\nand 3 more\nCheck that`)
    expect(h.handoffs['verify-1']).not.toContain(paths[100]!)
  })

  describe('the push stage and the pull request', () => {
    const LATE = [{ sha: 'abc1234', subject: 'fix: late' }]
    const pushed = async (script: Script, files: Record<string, string>) => {
      const h = withPlan(harness({ ...script }))
      seed(h, { 'gate-head.txt': 'abc123', ...files })
      const outcome = await carryOut(at('push', 1), h.deps)
      return { h, outcome }
    }

    it('AC16: records the commits that reached the base after the tests, and pushes anyway', async () => {
      const { h, outcome } = await pushed({ ...MOVED, untested: LATE }, { 'tested-base.txt': FORK })
      expect(outcome).toBe('review')
      expect(JSON.parse(text(h, 'untested-commits.json'))).toEqual(LATE)
      expect(events(h, 'base_check')).toHaveLength(1)
      expect(events(h, 'base_check')[0]).toMatchObject({
        status: 'error',
        target: '1 commits reached main after the tests',
        payload: { tested: FORK, now: ORIGIN, commits: LATE },
      })
      expect(h.gitCalls).toContain(`push ${BRANCH}`)
      const body = h.prBodies[0]!
      expect(body).toContain(`Tested on \`main\` at \`${FORK}\`.`)
      expect(body).toContain('## Not tested with this change\n\nabc1234 fix: late')
      expect(body.indexOf('## Not tested')).toBeLessThan(body.indexOf('## Verify report'))
      expect(body.indexOf('Tested on')).toBeGreaterThan(body.indexOf('PAY-1, run 2'))
    })

    it('AC16: lists the first 20 commits and how many more', async () => {
      const many = Array.from({ length: 22 }, (_, i) => ({ sha: `s${i}`, subject: `c${i}` }))
      const { h } = await pushed({ ...MOVED, untested: many }, { 'tested-base.txt': FORK })
      const body = h.prBodies[0]!
      expect(body).toContain('s19 c19\nand 2 more\n\n## Verify report')
      expect(body).not.toContain('s20 c20')
    })

    it('AC17: an unmoved base sends no base_check, drops a stale list, and keeps no section', async () => {
      const { h } = await pushed(
        {},
        { 'tested-base.txt': FORK, 'untested-commits.json': JSON.stringify(LATE) },
      )
      expect(events(h, 'base_check')).toEqual([])
      expect(has(h, 'untested-commits.json')).toBe(false)
      expect(h.prBodies[0]).toContain(`Tested on \`main\` at \`${FORK}\`.`)
      expect(h.prBodies[0]).not.toContain('## Not tested')
    })

    it('AC17: a run without tested-base.txt fetches nothing and writes the body as before', async () => {
      const { h } = await pushed({}, {})
      expect(h.order).not.toContain('fetch')
      expect(events(h, 'base_check')).toEqual([])
      expect(h.prBodies[0]).toBe('PAY-1, run 2, spec v1.\n\n## Verify report\n\n\n')
    })

    it('R12: a failed fetch blocks the run at push', async () => {
      const { h, outcome } = await pushed({ fails: 'fetch' }, { 'tested-base.txt': FORK })
      expect(outcome).toBe('released')
      expect(h.of('error').at(-1)?.payload).toMatchObject({ cause: 'step_failed', stage: 'push' })
      expect(h.gitCalls).not.toContain(`push ${BRANCH}`)
    })
  })

  it('R7: a whole run writes the base it tested', async () => {
    const h = harness({})
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    expect(text(h, 'tested-base.txt')).toBe(FORK)
    expect(text(h, 'gate-head.txt')).toBe('abc123')
    expect(h.prBodies[0]).toContain(`Tested on \`main\` at \`${FORK}\`.`)
  })
})

describe('the handoff', () => {
  it('carries no summary of a Help phase', async () => {
    const { buildHandoff } = await import('../../src/phases/handoff.js')
    const text = buildHandoff({
      taskKey: 'PAY-1',
      title: 'T',
      phase: 'build',
      attempt: 1,
      budgetUsd: null,
      summaries: [
        { phase: 'plan', attempt: 1, text: 'Planned' },
        { phase: 'help', attempt: 1, text: 'Suggested option b' },
      ],
    })
    expect(text).toContain('Planned')
    expect(text).not.toContain('Suggested option b')
    expect(text).not.toContain('phase="help"')
  })
})

describe('the help prompt', () => {
  it('escapes the task title and key, so a title cannot close the tag', async () => {
    const { helpPrompt } = await import('../../src/help.js')
    const text = helpPrompt({
      id: 'h',
      mode: 'suggest',
      approval_id: 'a',
      question_index: null,
      phase_id: 'p',
      attempt: 1,
      run: {
        id: 'r',
        number: 1,
        worktree_path: null,
        task: { id: 't', key: 'PAY"-1', title: 'Fix <b> & </task> more', budget_usd: null },
      },
    })
    expect(text).toContain('<task key="PAY&quot;-1">Fix &lt;b&gt; &amp; &lt;/task&gt; more</task>')
    expect(text.match(/<\/task>/g)).toHaveLength(1)
  })
})

describe('the test command’s result', () => {
  const dir = (h: ReturnType<typeof harness>) => RUN_DIR(h.home)
  const worktreeOf = (h: ReturnType<typeof harness>) => join(h.home, 'worktrees', RUN.id)
  const starts = (h: ReturnType<typeof harness>) =>
    h.calls.filter((c) => c.startsWith('start ')).map((c) => c.slice('start '.length))
  const blocks = (h: ReturnType<typeof harness>) =>
    h
      .of('error')
      .map(
        (e) =>
          e.payload as {
            blocks?: boolean
            cause?: string
            stage?: string
            command?: string
            output?: string
          },
      )
      .filter((p) => p.blocks === true)
  const instruction = (h: ReturnType<typeof harness>) =>
    `In ${worktreeOf(h)}, make \`npm test\` pass and commit the fix, then Resume. A failure in a file outside the plan is fixed on the base branch instead: push the fix to \`origin/main\`, then Resume, and the tests stage rebases the branch onto it before the command runs. Only committed work is tested: Resume undoes uncommitted changes first, and a path outside the plan committed in the worktree fails the files gate, which ends the run on attempt 3.`
  const OUTSIDE =
    'If the cause was outside the code, for example the machine slept or the disk was full, Resume runs the command again as it is.'
  const resumed = (cp: Checkpoint, message: string | null = null) =>
    resume(cp, message) as Extract<Work, { kind: 'resume' }>
  const TEST_FAILED: Checkpoint['failing_report_id'] = 'test_command'

  interface Result {
    exitCode: number | null
    timedOut?: boolean
    output?: string
    truncated?: boolean
  }
  interface Row {
    name: string
    results: Result[]
    buildHeads: (string | undefined)[]
    starts: string[]
    testRuns: number
    outcome: 'review' | 'released'
    /** The block's first line, its attempt, and whether R7's line belongs to it. */
    block?: { first: string; attempt: number; outside: boolean }
    /** The failing report id on the checkpoint that opens build-2. */
    failing?: string
  }
  const PASS: Result = { exitCode: 0 }
  const FAIL: Result = { exitCode: 1 }
  const KILLED: Result = { exitCode: null, timedOut: true }
  const HEADS = [undefined, 'head-2', 'head-3']
  const ROWS: Row[] = [
    {
      name: 'exit 0',
      results: [PASS],
      buildHeads: [],
      starts: ['plan-1', 'build-1', 'verify-1'],
      testRuns: 1,
      outcome: 'review',
    },
    {
      name: 'exit 1, then exit 0',
      results: [FAIL, PASS],
      buildHeads: HEADS,
      starts: ['plan-1', 'build-1', 'build-2', 'verify-2'],
      testRuns: 2,
      outcome: 'review',
      failing: 'test_command',
    },
    {
      name: 'exit 137, then exit 0',
      results: [{ exitCode: 137 }, PASS],
      buildHeads: HEADS,
      starts: ['plan-1', 'build-1', 'build-2', 'verify-2'],
      testRuns: 2,
      outcome: 'review',
      failing: 'test_command',
    },
    {
      name: 'a timeout on attempt 1',
      results: [KILLED],
      buildHeads: [],
      starts: ['plan-1', 'build-1'],
      testRuns: 1,
      outcome: 'released',
      block: { first: 'the test command was killed after its timeout', attempt: 1, outside: true },
    },
    {
      name: 'not run or killed on attempt 1',
      results: [{ exitCode: null, timedOut: false }],
      buildHeads: [],
      starts: ['plan-1', 'build-1'],
      testRuns: 1,
      outcome: 'released',
      block: { first: 'the test command did not run or was killed', attempt: 1, outside: true },
    },
    {
      name: 'exit 1 on all three attempts',
      results: [FAIL, FAIL, FAIL],
      buildHeads: HEADS,
      starts: ['plan-1', 'build-1', 'build-2', 'build-3'],
      testRuns: 3,
      outcome: 'released',
      block: { first: 'the test command failed on attempt 3', attempt: 3, outside: false },
    },
    {
      name: 'exit 1 twice, then a timeout on attempt 3',
      results: [FAIL, FAIL, KILLED],
      buildHeads: HEADS,
      starts: ['plan-1', 'build-1', 'build-2', 'build-3'],
      testRuns: 3,
      outcome: 'released',
      block: { first: 'the test command was killed after its timeout', attempt: 3, outside: true },
    },
    {
      name: 'exit 1, then a Build that commits nothing',
      results: [FAIL],
      buildHeads: [],
      starts: ['plan-1', 'build-1', 'build-2'],
      testRuns: 1,
      outcome: 'released',
      block: {
        first: 'the build changed nothing after the test command failed',
        attempt: 2,
        outside: false,
      },
    },
  ]

  it.each(ROWS)('AC1–AC3, AC7, AC9, AC10, AC15, AC19: $name', async (row) => {
    const h = harness({ testResults: row.results, buildHeads: row.buildHeads })
    expect(await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)).toBe(row.outcome)
    expect(starts(h)).toEqual(row.starts)
    expect(h.testRuns).toHaveLength(row.testRuns)
    expect(h.runEnd()?.payload).not.toMatchObject({ reason: 'verify failed three times' })
    if (row.outcome === 'review')
      expect(h.runEnd()).toMatchObject({ payload: { outcome: 'review' } })
    else expect(h.runEnd()).toBeUndefined()

    const events = h.of('tool_call').filter((e) => e.tool === 'test_command')
    expect(events).toHaveLength(row.testRuns)
    events.forEach((e, i) => {
      const result = row.results[i] ?? PASS
      expect(e.status).toBe(result.exitCode === 0 ? 'ok' : 'error')
      expect(e.payload).toMatchObject({
        exit_code: result.exitCode,
        timed_out: result.timedOut ?? false,
      })
    })

    if (row.failing !== undefined) {
      const second = h.checkpoints().find((c) => c.stage === 'build' && c.attempt === 2)
      expect(second?.failing_report_id).toBe(row.failing)
    }
    if (row.block === undefined) {
      expect(blocks(h)).toEqual([])
      return
    }
    const [block, ...more] = blocks(h)
    expect(more).toEqual([])
    expect(block).toMatchObject({ cause: 'step_failed', stage: 'tests', command: 'npm test' })
    const output = block?.output ?? ''
    expect(output.startsWith(row.block.first)).toBe(true)
    expect(output.endsWith(instruction(h))).toBe(true)
    if (row.block.outside) expect(output).toContain(`${OUTSIDE}\n${instruction(h)}`)
    else expect(output).not.toContain('If the cause was outside the code')
    expect(h.checkpoints().at(-1)).toMatchObject({ stage: 'tests', attempt: row.block.attempt })
    if (row.block.attempt === 3 && row.block.first.includes('failed'))
      expect(output).toContain('exit code: 1')
    const phaseEnds = h.calls.filter((c) => c.startsWith('end build-2'))
    if (row.block.first.includes('changed nothing')) expect(phaseEnds).toEqual(['end build-2 ok'])
  })

  const LONG = 'FIRST-LINE\n' + 'x'.repeat(30_000) + '\nLAST-LINE'
  it('AC4: the report keeps the end of a long output and names the rules', async () => {
    const h = withPlan(
      harness({
        testResults: [{ exitCode: 1, output: LONG, truncated: false }],
        acts: { 'build-2': ['paused'] },
        buildHeads: HEADS,
      }),
    )
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    const report = h.handoffs['build-2'] ?? ''
    expect(report).toContain('`npm test`')
    expect(report).toContain('exit code: 1')
    expect(report).toContain('[output cut to its end]')
    expect(report).toContain('LAST-LINE')
    expect(report).not.toContain('FIRST-LINE')
    expect(report).toContain("changing only the plan's files")
    expect(report).toContain('say so in your summary')
    expect(existsSync(join(dir(h), 'test-command-report.md'))).toBe(true)
  })

  it.each([
    { truncated: true, cut: true },
    { truncated: false, cut: false },
  ])('AC5: a short output with truncated $truncated', async ({ truncated, cut }) => {
    const h = harness({
      testResults: [{ exitCode: 1, output: 'short', truncated }],
      acts: { 'build-2': ['paused'] },
      buildHeads: HEADS,
    })
    await carryOut(START as Extract<Work, { kind: 'start' }>, h.deps)
    const report = h.handoffs['build-2'] ?? ''
    expect(report.includes('[output cut to its end]')).toBe(cut)
  })

  it('AC6: a missing report file gives the fixed text', async () => {
    const h = withPlan(harness({ acts: { 'build-2': ['paused'] } }))
    const cp = { ...checkpoint('build', 2), failing_report_id: TEST_FAILED }
    await carryOut(resumed(cp), h.deps)
    expect(h.handoffs['build-2']).toContain('The test command `npm test` failed')
  })

  it('AC8: a run blocked on attempt 3 tests again on Resume, and opens the pull request', async () => {
    const h = withPlan(harness({}))
    const cp = { ...checkpoint('tests', 3), failing_report_id: TEST_FAILED }
    expect(await carryOut(resumed(cp), h.deps)).toBe('review')
    expect(h.testRuns).toHaveLength(1)
    expect(starts(h)).toEqual(['verify-3'])
  })

  it('AC20 and AC21: a Resume at tests with HEAD unchanged runs the test command', async () => {
    const h = withPlan(harness({}))
    mkdirSync(dir(h), { recursive: true })
    writeFileSync(join(dir(h), 'gate-head.txt'), 'abc123')
    const cp = { ...checkpoint('tests', 2), failing_report_id: TEST_FAILED }
    expect(await carryOut(resumed(cp), h.deps)).toBe('review')
    expect(h.testRuns).toHaveLength(1)
    expect(blocks(h)).toEqual([])
    expect(starts(h)).toEqual(['verify-2'])
  })

  describe('a Verify that finds the test command not passing', () => {
    const verifyAt = (attempt: number, phase?: string) =>
      resumed(checkpoint('verify', attempt, phase))

    it('AC11: a failure sends Build round without a verify phase', async () => {
      const h = withPlan(harness({ testResults: [FAIL], buildHeads: [undefined, 'head-2'] }))
      await carryOut(verifyAt(1), h.deps)
      expect(starts(h)).toEqual(['build-2', 'verify-2'])
      expect(h.checkpoints().filter((c) => c.stage === 'verify' && c.attempt === 1)).toEqual([])
      expect(h.handoffs['build-2']).toContain('exit code: 1')
      expect(h.checkpoints().find((c) => c.stage === 'build')?.failing_report_id).toBe(
        'test_command',
      )
    })

    it('AC12: a timeout blocks at tests, naming no phase', async () => {
      const h = withPlan(harness({ testResults: [KILLED] }))
      expect(await carryOut(verifyAt(1), h.deps)).toBe('released')
      expect(starts(h)).toEqual([])
      expect(blocks(h)).toMatchObject([{ cause: 'step_failed', stage: 'tests' }])
      expect(h.checkpoints().at(-1)).toMatchObject({ stage: 'tests', attempt: 1, phase_id: null })
    })

    it('AC13: a recorded phase whose session is gone ends failed, and is not restarted', async () => {
      const h = withPlan(
        harness({
          acts: { 'verify-1': ['gone'] },
          testResults: [FAIL],
          buildHeads: [undefined, 'head-2'],
        }),
      )
      await carryOut(verifyAt(1, 'ph'), h.deps)
      expect(h.calls).toContain('end verify-1 failed')
      expect(h.restarts).toEqual([])
      expect(starts(h)[0]).toBe('build-2')
      const first = h.checkpoints().find((c) => c.stage === 'build' && c.attempt === 2)
      expect(first?.phase_id).not.toBe('ph')
    })

    it('AC14: on attempt 3 the same ends the phase and blocks', async () => {
      const h = withPlan(harness({ acts: { 'verify-3': ['gone'] }, testResults: [FAIL] }))
      expect(await carryOut(verifyAt(3, 'ph'), h.deps)).toBe('released')
      expect(h.calls).toContain('end verify-3 failed')
      expect(h.restarts).toEqual([])
      expect(blocks(h)).toMatchObject([{ cause: 'step_failed', stage: 'tests' }])
      expect(h.checkpoints().at(-1)).toMatchObject({ stage: 'tests', attempt: 3, phase_id: null })
    })
  })
})
