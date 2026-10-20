import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoardApi } from '../../src/api.js'
import type { ArtifactView, RunnerEvent, Work } from '../../src/contract.js'
import { runDelivery, type DeliveryDeps } from '../../src/delivery.js'
import { Git, GitError } from '../../src/git.js'
import type { PhaseInput, PhaseResult } from '../../src/phases/phase.js'
import { EventSink } from '../../src/sink.js'

const WORK: Work = {
  kind: 'start',
  run: {
    id: '00000000-0000-4000-8000-000000000001',
    number: 2,
    kind: 'delivery',
    spec_version: 1,
    task: { id: 't', key: 'PAY-1', title: 'Retry', description_md: '', budget_usd: null },
    spec: {
      version: 1,
      body_md: '## Requirements\n1. R1 – x',
      criteria: [{ id: 'AC1', requirements: ['R1'], text: 'x' }],
    },
    project: {
      key: 'PAY',
      repo_path: '/repo',
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
    },
  },
}

type Verdict = 'pass' | 'fail' | 'no-report'
interface Script {
  plan?: 'ok' | 'no-plan' | 'fails'
  commits?: number[]
  verdicts?: Verdict[]
  push?: 'ok' | 'fails'
  cancelIn?: 'build'
}

function harness(script: Script) {
  const sent: RunnerEvent[] = []
  const artifacts: ArtifactView[] = []
  const handoffs: { phase: string; attempt: number; handoff: string }[] = []
  const gitCalls: string[] = []
  let build = 0
  let verify = 0

  const api = {
    issueToken: async () => 'token',
    retire: async () => undefined,
    sendEvents: async (_t: string, events: RunnerEvent[]) => {
      sent.push(...events)
      return events.length
    },
    getRun: async () => ({ id: WORK.run.id, status: 'running', phases: [], artifacts }),
  } as unknown as BoardApi

  const runPhase = async (input: PhaseInput): Promise<PhaseResult> => {
    handoffs.push({ phase: input.phase, attempt: input.attempt, handoff: input.handoff })
    const phaseId = `${input.phase}-${input.attempt}`
    if (input.phase === 'plan') {
      if (script.plan === 'fails')
        return { phaseId, ok: false, summary: '', sessionId: 's', cancelled: false }
      if (script.plan !== 'no-plan') {
        artifacts.push({
          id: 'a',
          kind: 'plan',
          phase_id: phaseId,
          body_md: '1. Backoff',
          uri: null,
          data: {
            summary: 's',
            confidence: 'high',
            steps: [{ title: 'b', requirements: ['R1'], files: ['src/retry.ts'] }],
            checks: [{ criterion: 'AC1', how: 'test' }],
          },
        })
      }
    }
    if (input.phase === 'build') {
      build += 1
      if (script.cancelIn === 'build')
        return { phaseId, ok: false, summary: '', sessionId: 's', cancelled: true }
    }
    if (input.phase === 'verify') {
      const verdict = script.verdicts?.[verify++] ?? 'pass'
      if (verdict !== 'no-report') {
        artifacts.push({
          id: `r${verify}`,
          kind: 'verify_report',
          phase_id: phaseId,
          body_md: `| AC1 | ${verdict} |`,
          uri: null,
          data: { summary: 's', criteria: [{ id: 'AC1', status: verdict, evidence: 'e' }] },
        })
      }
    }
    return {
      phaseId,
      ok: true,
      summary: `${input.phase} ${input.attempt} done`,
      sessionId: 's',
      cancelled: false,
    }
  }

  const git = {
    prepareWorktree: async (_r: string, _b: string, branch: string) => {
      gitCalls.push(`worktree ${branch}`)
    },
    newCommits: async () => script.commits?.[build - 1] ?? 1,
    diff: async () => '+change',
    push: async (_d: string, branch: string) => {
      if (script.push === 'fails') throw new GitError(`git push -u origin ${branch}`, 'rejected')
      gitCalls.push(`push ${branch}`)
    },
    createPr: async () => {
      gitCalls.push('pr')
      return { number: 9, url: 'https://github.com/owner/pay/pull/9' }
    },
    removeWorktree: async () => {
      gitCalls.push('remove')
    },
  } as unknown as Git

  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const deps: DeliveryDeps = {
    api,
    git,
    sink: new EventSink(api, join(home, 'events.ndjson'), () => 'token'),
    setToken: () => undefined,
    runPhase,
    runTests: async () => ({
      exitCode: 0,
      timedOut: false,
      output: 'tests ok',
      truncated: false,
      durationMs: 5,
    }),
    config: {
      boardUrl: 'http://b',
      runnerKey: 'k',
      runnerId: 'r',
      claudeBin: 'claude',
      ghBin: 'gh',
      home,
      testTimeoutMs: 1000,
      claimWaitMs: 1,
      heartbeatMs: 1000,
      pauseGraceMs: 1000,
      stopGraceMs: 1000,
      markerPollMs: 50,
    },
    signal: new AbortController().signal,
  }
  return { deps, sent, handoffs, gitCalls, runEnd: () => sent.find((e) => e.type === 'run_end') }
}

describe('runDelivery', () => {
  it('plans, builds, verifies, and opens the pull request', async () => {
    const h = harness({})
    expect(await runDelivery(WORK, h.deps)).toBe('review')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'verify-1',
    ])
    expect(h.gitCalls).toEqual(['worktree board/PAY-1-r2', 'push board/PAY-1-r2', 'pr', 'remove'])
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'review', pr_number: 9, branch: 'board/PAY-1-r2' },
    })
    expect(h.sent.find((e) => e.tool === 'test_command')).toMatchObject({
      type: 'tool_call',
      agent: 'runner',
      status: 'ok',
      target: 'npm test',
    })
  })

  it('hands a failing report to the next build, and gives up after the third', async () => {
    const h = harness({ verdicts: ['fail', 'fail', 'fail'] })
    expect(await runDelivery(WORK, h.deps)).toBe('failed')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'verify-1',
      'build-2',
      'verify-2',
      'build-3',
      'verify-3',
    ])
    expect(h.handoffs[3]?.handoff).toContain('<verify_report>')
    expect(h.runEnd()).toMatchObject({
      payload: { outcome: 'failed', reason: 'verify failed three times' },
    })
  })

  it('passes on the second attempt', async () => {
    const h = harness({ verdicts: ['fail', 'pass'] })
    expect(await runDelivery(WORK, h.deps)).toBe('review')
  })

  it('counts a build with no commit as a failed verify, without running Verify', async () => {
    const h = harness({ commits: [0, 1] })
    expect(await runDelivery(WORK, h.deps)).toBe('review')
    expect(h.handoffs.map((x) => `${x.phase}-${x.attempt}`)).toEqual([
      'plan-1',
      'build-1',
      'build-2',
      'verify-2',
    ])
    expect(h.handoffs[2]?.handoff).toContain('made no commit')
  })

  it.each([
    ['a planner that saved no plan', { plan: 'no-plan' as const }, 'the planner saved no plan'],
    ['a plan phase that failed', { plan: 'fails' as const }, 'the plan phase failed'],
    [
      'a verifier that saved no report',
      { verdicts: ['no-report' as const] },
      'the verifier saved no report',
    ],
    [
      'a push that git refused',
      { push: 'fails' as const },
      'git push -u origin board/PAY-1-r2 failed: rejected',
    ],
  ])('fails the run on %s, saying why', async (_name, script, reason) => {
    const h = harness(script)
    expect(await runDelivery(WORK, h.deps)).toBe('failed')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'failed', reason } })
    expect(h.gitCalls.at(-1)).toBe('remove')
  })

  it('ends a cancelled run as cancelled', async () => {
    const h = harness({ cancelIn: 'build' })
    expect(await runDelivery(WORK, h.deps)).toBe('cancelled')
    expect(h.runEnd()).toMatchObject({ payload: { outcome: 'cancelled' } })
  })
})
