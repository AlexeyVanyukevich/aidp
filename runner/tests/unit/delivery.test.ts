import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { LOG_FILE } from '../../src/worktree-log.js'
import type { PhaseRecord, StepResult } from '../../src/phases/phase.js'
import {
  BRANCH,
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
      approved_migrations: [M],
    } as Extract<Work, { kind: 'resume' }>
    await carryOut(work, h.deps)
    const dir = join(h.home, 'runs', RUN.id)
    expect(JSON.parse(readFileSync(join(dir, 'approved-migrations.json'), 'utf8'))).toEqual([M])
    expect(JSON.parse(readFileSync(join(dir, 'allowed-files.json'), 'utf8'))).toContain(M)
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
      const refresh = h.order.filter((o) => o !== 'phase')
      expect(refresh.slice(0, 4)).toEqual(['fetch', 'undo', 'ff', 'setup'])
      expect(h.order.filter((o) => o === 'fetch')).toHaveLength(1)
      expect(h.order.filter((o) => o === 'ff')).toHaveLength(1)
      expect(h.order.filter((o) => o === 'setup')).toHaveLength(1)
      expect(h.order.indexOf('phase')).toBeGreaterThan(h.order.indexOf('setup'))
      expect(h.calls.some((c) => c.startsWith('resume plan'))).toBe(planner)
      if (!planner) expect(h.calls.slice(0, 2)).toEqual(['end plan-1 ok', 'start build-1'])
    },
  )

  it.each<[string, Checkpoint, RunWork]>([
    ['Build', checkpoint('build', 1, 'build-phase'), WITH_SETUP],
    ['tests', checkpoint('tests', 1), WITH_SETUP],
    ['Verify', checkpoint('verify', 1, 'verify-phase'), WITH_SETUP],
    [
      'a kept plan',
      checkpoint('plan', 1),
      { ...WITH_SETUP, kept_plan: { artifact_id: 'plan-1', from_run: 1 } },
    ],
  ])('AC3: a resume in %s does no refresh', async (_n, cp, run) => {
    const h = withPlan(harness({ setupCommand: SETUP, moveTo: MOVE }))
    await carryOut(claim(INTERRUPTED, run, cp), h.deps)
    expect(h.order.filter((o) => ['fetch', 'undo', 'ff', 'setup'].includes(o))).toEqual([])
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
