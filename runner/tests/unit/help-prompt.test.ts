import { describe, expect, it } from 'vitest'
import { AGENTS } from '../../src/phases/agents.js'
import { helpPrompt } from '../../src/help.js'
import type { HelpWork } from '../../src/contract.js'

const prompt = AGENTS.helper!.prompt

describe('the helper’s instructions for decisions (AC26)', () => {
  const rows: { name: string; words: string }[] = [
    { name: 'a review reports missing requirements', words: 'review: report what is missing' },
    { name: 'a review may find nothing to change', words: 'nothing_to_change' },
    { name: 'a restatement judges nothing', words: 'judge nothing' },
    {
      name: 'a recommendation first says why the run stopped',
      words: 'first say in plain words why the run stopped',
    },
    {
      name: 'it never recommends resume when not resumable',
      words: 'Never recommend resume when resumable is false',
    },
    { name: 'mark_done names Check what is unfinished', words: 'Check what is unfinished' },
    {
      name: 'a check says plainly when nothing was produced',
      words: 'saying plainly when nothing was produced',
    },
    { name: 'it reads a decision with get_decision', words: 'Read it with get_decision' },
    { name: 'the question words stay', words: 'Do not change what is asked' },
  ]
  it.each(rows)('$name', ({ words }) => {
    expect(prompt).toContain(words)
  })
  it('says why the run stopped before it recommends', () => {
    expect(prompt.indexOf('why the run stopped')).toBeLessThan(
      prompt.indexOf('then recommend one of'),
    )
  })
})

describe('the first message', () => {
  const work = (decision: NonNullable<HelpWork['decision']>, mode: HelpWork['mode']): HelpWork => ({
    id: 'h',
    mode,
    decision,
    approval_id: null,
    question_index: null,
    phase_id: 'p',
    attempt: 1,
    run: {
      id: 'r',
      number: 1,
      worktree_path: null,
      task: { id: 't', key: 'PAY-1', title: 'T', budget_usd: null },
    },
  })
  it('names the decision, the mode and the checkout', () => {
    const text = helpPrompt(work('mark_done', 'check'), {
      worktree: '/w',
      runDir: '/r',
      ref: 'origin/main',
      source: 'base',
      fallback: false,
      madeWorktree: true,
      commit: 'c'.repeat(40),
      linked: [],
    })
    expect(text).toContain('Decision: mark_done. Mode: check.')
    expect(text).toContain('<checkout ref="origin/main" source="base"/>')
  })
  it('names a proposal’s decision and mode', () => {
    const text = helpPrompt(
      { ...work('proposal', 'advise') },
      {
        worktree: '/w',
        runDir: '/r',
        ref: 'origin/main',
        source: 'base',
        fallback: false,
        madeWorktree: true,
        commit: 'c'.repeat(40),
        linked: [],
      },
    )
    expect(text).toContain('Decision: proposal. Mode: advise.')
    expect(text).toContain('source="base"')
  })
  it('keeps the question words', () => {
    expect(helpPrompt({ ...work('question', 'suggest') })).toContain(
      'Suggest an answer to the open question',
    )
  })
})

describe('the first message with linked checkouts and a diff', () => {
  const work: HelpWork = {
    id: 'h',
    mode: 'code_review',
    decision: 'pull_request',
    approval_id: null,
    question_index: null,
    phase_id: 'p',
    attempt: 1,
    run: {
      id: 'r',
      number: 1,
      worktree_path: null,
      task: { id: 't', key: 'PAY-1', title: 'T', budget_usd: null },
    },
  }
  const made = {
    worktree: '/w',
    runDir: '/r',
    ref: 'origin/feat',
    source: 'pull_request' as const,
    fallback: false,
    madeWorktree: true,
    commit: 'c'.repeat(40),
    linked: [] as import('../../src/linked.js').LinkedCheckout[],
  }
  const zlr = {
    key: 'ZLR',
    name: 'Zellige React',
    note: 'the <kit>',
    repo_path: '/owner/zlr',
    github_repo: 'owner/zlr',
    base_branch: 'main',
    path: '/wt/ZLR',
  }
  it('lists the linked checkouts and says they are read only (AC16)', () => {
    const text = helpPrompt(work, { ...made, linked: [zlr] })
    expect(text).toContain(
      '<project key="ZLR" name="Zellige React" github_repo="owner/zlr" base_branch="main" path="/wt/ZLR">the &lt;kit&gt;</project>',
    )
    expect(text).toContain('<linked_projects>')
    expect(text).toContain('The linked checkouts may be read and never changed.')
  })
  it('writes neither with no links, nor for a question help (AC16)', () => {
    const none = helpPrompt(work, made)
    expect(none).not.toContain('<linked_projects>')
    expect(none).not.toContain('never changed')
    const question = helpPrompt({ ...work, decision: 'question', mode: 'suggest' })
    expect(question).not.toContain('<linked_projects>')
  })
  it('carries the diff and the changed files with their marks (AC9)', () => {
    const text = helpPrompt(work, {
      ...made,
      diff: {
        path: '/r/pr.diff',
        bytes: 120,
        lines: 12,
        files: [
          { path: 'a.ts', first_line: 1, lines: 7 },
          { path: 'package-lock.json', first_line: 8, lines: 5, skip: 'lockfile' },
        ],
      },
    })
    expect(text).toContain('<diff path="/r/pr.diff" bytes="120" lines="12"/>')
    expect(text).toContain('<file path="a.ts" first_line="1" lines="7"/>')
    expect(text).toContain(
      '<file path="package-lock.json" first_line="8" lines="5" skip="lockfile"/>',
    )
  })
})
