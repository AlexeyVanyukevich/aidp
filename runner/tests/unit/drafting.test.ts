import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Checkpoint, RunWork, Work } from '../../src/contract.js'
import { draftSpec } from '../../src/drafting.js'
import { INTERRUPTED } from '../../src/run-steps.js'
import { RUN, checkpoint, harness, type Script } from './run-harness.js'

const SPEC_RUN: RunWork = { ...RUN, kind: 'spec', spec: null }
const START: Extract<Work, { kind: 'start' }> = { kind: 'start', run: SPEC_RUN }
const specResume = (message: string | null): Work => ({
  kind: 'resume',
  run: SPEC_RUN,
  checkpoint: checkpoint('spec', 1, 'spec-phase') as Checkpoint,
  message,
  allowed_files: [],
})
const runDirOf = (home: string) => join(home, 'runs', RUN.id)
const draft = (work: Work, h: ReturnType<typeof harness>) =>
  draftSpec(work as Extract<Work, { kind: 'start' | 'resume' }>, h.deps)
const resumed = (h: ReturnType<typeof harness>) => h.calls.find((c) => c.startsWith('resume'))

describe('a spec run resumed with its worktree gone', () => {
  it('AC27: blocks as step_failed, clears the directory and reports the failure', async () => {
    const h = harness({ worktreeGone: true, recreateFails: true })
    expect(await draft(specResume(INTERRUPTED), h)).toBe('released')
    expect(h.of('error').at(-1)?.payload).toMatchObject({ blocks: true, cause: 'step_failed' })
    const worktree = join(h.home, 'worktrees', RUN.id)
    expect(existsSync(worktree)).toBe(false)
    expect(
      h.log().filter((l) => l.caller === 'recreate' && l.path === worktree).length,
    ).toBeGreaterThan(0)
    expect(h.log().find((l) => l.action === 'recreate')).toMatchObject({
      caller: 'draft_resume',
      result: 'failed',
    })
    expect(h.of('tool_call').find((e) => e.tool === 'recreate_worktree')).toMatchObject({
      status: 'error',
      payload: { result: 'failed' },
    })
  })

  it('makes a detached worktree again and goes on into the spec phase', async () => {
    const h = harness({ worktreeGone: true })
    expect(await draft(specResume(INTERRUPTED), h)).toBe('drafted')
    expect(h.of('tool_call').find((e) => e.tool === 'recreate_worktree')).toMatchObject({
      status: 'ok',
      payload: { caller: 'draft_resume', result: 'recreated' },
    })
    expect(h.order).toContain('phase')
  })
})

describe('a spec run resumed at the spec stage', () => {
  it('AC2: fast-forwards the worktree before the spec-writer resumes, after a stop', async () => {
    const h = harness({ moveTo: { head: 'new1', commits: 1, paths: ['src/retry.ts'] } })
    expect(await draft(specResume(INTERRUPTED), h)).toBe('drafted')
    expect(h.order).toEqual(['fetch', 'undo', 'ff', 'phase'])
  })

  it('AC3: blocks as step_failed at spec when the fetch fails, and runs no process', async () => {
    const h = harness({ fails: 'fetch' })
    expect(await draft(specResume('an answer'), h)).toBe('released')
    expect(h.order).not.toContain('phase')
    expect(h.of('error').at(-1)?.payload).toMatchObject({
      blocks: true,
      cause: 'step_failed',
      stage: 'spec',
      command: 'git fetch origin main',
    })
  })

  it('AC5, AC12: a new run records its HEAD in spec-base.txt, never plan-base.txt, and names it', async () => {
    const h = harness({})
    expect(await draft(START, h)).toBe('drafted')
    const dir = runDirOf(h.home)
    expect(readFileSync(join(dir, 'spec-base.txt'), 'utf8')).toBe('abc123')
    expect(existsSync(join(dir, 'plan-base.txt'))).toBe(false)
    expect(h.handoffs['spec-1']).toContain('<base branch="main" commit="abc123"/>')
  })

  it('AC11: keeps the answer across a blocked refresh and delivers it, not the nudge', async () => {
    const script: Script = { fails: 'fetch' }
    const h = harness(script)
    expect(await draft(specResume('1. yes'), h)).toBe('released')
    const pending = join(runDirOf(h.home), 'pending-answer.json')
    expect(JSON.parse(readFileSync(pending, 'utf8'))).toEqual({ kind: 'words', text: '1. yes' })

    delete script.fails
    expect(await draft(specResume(INTERRUPTED), h)).toBe('drafted')
    expect(resumed(h)).toBe('resume spec-1: 1. yes')
    expect(h.of('tool_call').filter((e) => e.tool === 'saved_answer')).toHaveLength(1)
    expect(existsSync(pending)).toBe(false)
  })

  interface NoteRow {
    name: string
    base: string | null
    moveTo?: Script['moveTo']
    note: RegExp[] | null
    written: string
  }
  const NOTE_ROWS: NoteRow[] = [
    {
      name: 'AC6: the base moved',
      base: 'old0',
      moveTo: { head: 'new1', commits: 1, paths: ['src/retry.ts'] },
      note: [
        /old0/,
        /new1, 1 commit later/,
        /src\/retry\.ts/,
        /save the spec again with save_spec if it changes\.\n\n1\. yes$/,
      ],
      written: 'new1',
    },
    { name: 'AC7: the base did not move', base: 'abc123', note: null, written: 'abc123' },
    {
      name: 'AC8: no spec-base.txt yet',
      base: null,
      moveTo: { head: 'new1', commits: 2, paths: ['a.ts'] },
      note: [/abc123/, /new1, 2 commits later/],
      written: 'new1',
    },
  ]
  it.each(NOTE_ROWS)('$name', async ({ base, moveTo, note, written }) => {
    const h = harness({ ...(moveTo === undefined ? {} : { moveTo }) })
    const dir = runDirOf(h.home)
    if (base !== null) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'spec-base.txt'), base)
    }
    expect(await draft(specResume('1. yes'), h)).toBe('drafted')
    const message = resumed(h) ?? ''
    if (note === null) {
      expect(message).toBe('resume spec-1: 1. yes')
    } else {
      expect(message.startsWith('resume spec-1: The base branch moved')).toBe(true)
      for (const part of note) expect(message).toMatch(part)
    }
    expect(readFileSync(join(dir, 'spec-base.txt'), 'utf8')).toBe(written)
  })
})
