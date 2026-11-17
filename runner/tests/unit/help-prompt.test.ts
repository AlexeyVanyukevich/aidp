import { describe, expect, it } from 'vitest'
import { AGENTS } from '../../src/phases/agents.js'
import { helpPrompt } from '../../src/help.js'
import { linkedProjects } from '../../src/phases/handoff.js'
import type { HelpWork } from '../../src/contract.js'

const prompt = AGENTS.helper!.prompt

describe('the helper’s instructions for decisions (AC26)', () => {
  const rows: { name: string; words: string }[] = [
    { name: 'a review reports missing requirements', words: 'review: report what is missing' },
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
  it.each(['suggest_all', 'one answer for every question', 'consistent with', 'answers'])(
    'describes the whole-batch mode: %s',
    (words) => {
      expect(prompt).toContain(words)
    },
  )
  it('says why the run stopped before it recommends', () => {
    expect(prompt.indexOf('why the run stopped')).toBeLessThan(
      prompt.indexOf('then recommend one of'),
    )
  })
})

/** One paragraph of the helper's prompt, from its mode name to the next paragraph. */
const paragraph = (mode: string) => {
  const parts = prompt.split('\n\n')
  const from = parts.findIndex((part) => part.startsWith(`${mode}: `))
  const next = parts.findIndex(
    (part, i) =>
      i > from &&
      /^(review|review_plan|restate|recommend|check|advise|code_review|When the result): ?/.test(
        part,
      ),
  )
  return parts.slice(from, next === -1 ? undefined : next).join('\n\n')
}

describe('the shared review shape in the helper’s instructions', () => {
  const modes = ['review', 'review_plan', 'code_review']
  const shared: { name: string; words: string }[] = [
    { name: 'a blocker', words: 'makes the work do the wrong thing or fail its own criteria' },
    { name: 'a next-gate point', words: 'the next agent can settle without a decision' },
    { name: 'an outside point', words: 'belongs to another task' },
    { name: 'no lighter destination', words: 'never move a finding to a lighter destination' },
    { name: 'evidence', words: '"not checked"' },
    { name: 'a tested fix', words: 'the cases it must not break' },
  ]
  const rows = modes.flatMap((mode) => shared.map((row) => ({ mode, ...row })))
  it.each(rows)('$mode defines $name', ({ mode, words }) => {
    expect(paragraph(mode)).toContain(words)
  })

  const own: { mode: string; name: string; words: string }[] = [
    {
      mode: 'review_plan',
      name: 'a dropped point is a blocker that quotes it',
      words: 'blocker whose text quotes',
    },
    {
      mode: 'review_plan',
      name: 'a settled point is not raised again',
      words: 'Never raise a settled point again',
    },
    { mode: 'review_plan', name: 'it reads previous', words: 'previous.answer' },
    { mode: 'code_review', name: 'it picks a next step', words: 'next_step' },
    { mode: 'code_review', name: 'it reads plan_review_points', words: 'plan_review_points' },
    {
      mode: 'code_review',
      name: 'an unsettled point becomes a blocker or an outside finding',
      words: 'blocker or an outside finding',
    },
    {
      mode: 'code_review',
      name: 'a settled point is not raised',
      words: 'A settled point is not raised',
    },
  ]
  it.each(own)('$mode: $name', ({ mode, words }) => {
    expect(paragraph(mode)).toContain(words)
  })
})

describe('the approval note and edits in the helper’s instructions', () => {
  it('review_plan raises a dropped note point as a blocker and not a kept one', () => {
    const text = paragraph('review_plan')
    expect(text).toContain('approval_note')
    expect(text).toContain('Check each point of a non-null approval_note against the current plan')
    expect(text).toContain('blocker whose text quotes the point')
    expect(text).toContain('A point the plan keeps is not raised')
  })
  it('review no longer asks for an edit, and sends next-gate points to the note', () => {
    const text = paragraph('review')
    expect(text).not.toMatch(/\bedit\b/)
    expect(text).toContain('goes into the owner’s note for the planner')
  })
})

describe('the Re-run note in the phase prompts', () => {
  it.each(['planner', 'builder', 'verifier'])(
    'tells the %s the note is the owner’s word and no criterion',
    (name) => {
      const text = AGENTS[name]!.prompt
      expect(text).toContain('<rerun_note>')
      expect(text).toContain('never overrides the spec')
      expect(text).toContain('withdrawn')
    },
  )
  it('tells the verifier to read it as context only', () => {
    expect(AGENTS.verifier!.prompt).toContain('context only')
    expect(AGENTS.verifier!.prompt).toContain('judges the spec’s criteria alone')
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
  it('names the whole-batch mode and asks for every question', () => {
    const text = helpPrompt({ ...work('question', 'suggest_all') })
    expect(text).toContain('Mode: suggest_all.')
    expect(text).toContain('every question of the batch')
    expect(text).toContain('get_question')
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
  it('gives the linked checkouts the element a phase handoff gives them', () => {
    const second = { ...zlr, key: 'ABC', path: '/wt/ABC' }
    expect(helpPrompt(work, { ...made, linked: [zlr, second] })).toContain(
      linkedProjects([zlr, second]),
    )
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
