import { Fragment, useId, useState, type ReactNode } from 'react'
import { Badge, Button, Radio, RadioGroup } from '@zellige/react'
import type {
  ApprovalOption,
  HelpMode,
  HelpResult,
  AskedHelpMode,
  NextStep,
  StoppedRunAction,
} from '../types'
import {
  choicesLabel,
  decisionFailure,
  failureText,
  type FindingPick,
  resultHeading,
  suggestHeading,
  type ModeHelp,
  type QuestionHelp,
  type PlanReviewResult,
  type PrReviewResult,
  type ReviewResult,
} from './approvals'

type Suggestion = Extract<HelpResult, { mode: 'suggest' }>

/** One help of a decision or a question: its button, its state, and how its result is headed. */
export interface PanelMode<Id extends HelpMode = HelpMode> {
  id: Id
  /** The button's label, which is its accessible name. */
  label: string
  state: ModeHelp
  /** The heading the result sits under. */
  heading: string
  /** The line shown when the latest help failed, given the reason. */
  failureLine: (reason: string) => string
}

/** A renderer per mode, each given the result narrowed to its mode. */
export type Renderers = {
  [M in HelpResult['mode']]?: (result: Extract<HelpResult, { mode: M }>) => ReactNode
}

/**
 * The buttons of a list of modes, each busy while its help is in flight and still focusable. They
 * are fragments, so a card can place them among its own buttons.
 */
export function HelpButtons({
  modes,
  onAsk,
}: {
  modes: PanelMode[]
  onAsk: (mode: HelpMode) => void
}) {
  return (
    <>
      {modes.map((mode) => (
        <Button
          key={mode.id}
          busy={mode.state.busy}
          onClick={() => {
            if (!mode.state.busy) onAsk(mode.id)
          }}
        >
          {mode.label}
        </Button>
      ))}
    </>
  )
}

/**
 * The results of a list of modes: each failure line, then each result under a heading of `level`.
 * Results are announced by the card's status region, not here.
 */
export function HelpResults({
  modes,
  renderers,
  level,
}: {
  modes: PanelMode[]
  renderers: Renderers
  level: 3 | 4 | 5
}) {
  const id = useId()
  const Heading = `h${level}` as const
  const render = (result: HelpResult): ReactNode => {
    switch (result.mode) {
      case 'suggest':
        return renderers.suggest?.(result)
      case 'suggest_all':
        // Shown under each question as its own suggestion, never as a result of its own.
        return null
      case 'explain':
        return renderers.explain?.(result)
      case 'review':
        return renderers.review?.(result)
      case 'review_plan':
        return renderers.review_plan?.(result)
      case 'restate':
        return renderers.restate?.(result)
      case 'recommend':
        return renderers.recommend?.(result)
      case 'check':
        return renderers.check?.(result)
      case 'advise':
        return renderers.advise?.(result)
      case 'code_review':
        return renderers.code_review?.(result)
    }
    // Every mode returns above; this satisfies `consistent-return`.
    return null
  }
  return (
    <>
      {modes.map(
        (mode) =>
          mode.state.failure !== undefined && (
            <p key={`${mode.id}-failure`} className="help-failure">
              {mode.failureLine(mode.state.failure)}
            </p>
          ),
      )}
      {modes.map((mode) => {
        const result = mode.state.shown
        if (result === undefined || result.mode !== mode.id) return null
        return (
          <section
            key={`${mode.id}-${mode.state.id ?? ''}`}
            aria-labelledby={`${id}-${mode.id}`}
            className="help-result"
          >
            <Heading id={`${id}-${mode.id}`}>{mode.heading}</Heading>
            {render(result)}
          </section>
        )
      })}
    </>
  )
}

/**
 * The two helps of one question: Suggest an answer and Explain simply, each busy while its help
 * runs, and what they produced. Results are announced by the card's status region, not here.
 * `level` is the heading level of the results, below the question's own.
 */
export function HelpPanel({
  help,
  options,
  level,
  onAsk,
  onUse,
  planReview,
}: {
  help: QuestionHelp
  options: ApprovalOption[]
  level: 4 | 5
  onAsk: (mode: AskedHelpMode) => void
  onUse: (result: Suggestion) => void
  /** A plan request's Review plan: asking it, and Use these findings on its result. */
  planReview?: {
    onAsk: () => void
    onUseFindings: (result: ReviewResult | PlanReviewResult, picks: FindingPick[]) => void
  }
}) {
  const label = (result: Suggestion) =>
    options.find((option) => option.id === result.option_id)?.label
  const modes: PanelMode[] = [
    {
      id: 'suggest',
      label: 'Suggest an answer',
      state: help.suggest,
      heading: suggestHeading(help.suggest.source ?? 'own'),
      failureLine: (reason) => failureText('suggest', reason),
    },
    {
      id: 'explain',
      label: 'Explain simply',
      state: help.explain,
      heading: 'In plain words',
      failureLine: (reason) => failureText('explain', reason),
    },
    ...(planReview === undefined
      ? []
      : [
          {
            id: 'review_plan' as const,
            label: 'Review plan',
            state: help.review_plan,
            heading: 'Plan review',
            failureLine: (reason: string) => `No plan review: ${reason}`,
          },
        ]),
  ]
  return (
    <div className="help">
      <div className="help-buttons">
        <HelpButtons
          modes={modes}
          onAsk={(mode) => {
            if (mode === 'review_plan') planReview?.onAsk()
            else onAsk(mode as AskedHelpMode)
          }}
        />
      </div>
      <HelpResults
        modes={modes}
        level={level}
        renderers={{
          ...(planReview === undefined
            ? {}
            : {
                review_plan: decisionRenderers(null, planReview.onUseFindings, level).review_plan,
              }),
          suggest: (suggestion) => (
            <>
              {suggestion.option_id !== undefined && (
                <p>
                  <strong>Option:</strong> {label(suggestion) ?? suggestion.option_id}
                </p>
              )}
              {suggestion.text !== undefined && (
                <p>
                  <strong>Words:</strong> {suggestion.text}
                </p>
              )}
              <p>
                <strong>Why:</strong> {suggestion.reasoning}
              </p>
              <p>
                <strong>Unsure about:</strong> {suggestion.unsure}
              </p>
              <Button onClick={() => onUse(suggestion)}>Use this answer</Button>
            </>
          ),
          explain: (explanation) => (
            <>
              <p>
                <strong>What is asked:</strong> {explanation.asked}
              </p>
              <p>
                <strong>Why it matters:</strong> {explanation.matters}
              </p>
              <p>
                <strong>What each answer leads to:</strong> {explanation.leads_to}
              </p>
            </>
          ),
        }}
      />
    </div>
  )
}

/** The mode of a decision help: its label, state and the words of its heading and failure. */
export function decisionMode(
  id: 'review' | 'review_plan' | 'restate' | 'recommend' | 'check' | 'code_review',
  label: string,
  state: ModeHelp,
): PanelMode {
  const subject = state.subject ?? null
  return {
    id,
    label,
    state,
    heading: resultHeading(id, subject, state.shown),
    failureLine: (reason) => decisionFailure(id, subject, reason),
  }
}

/** The label of the card's own button for each action a stopped run offers. */
export const ACTION_LABEL: Record<StoppedRunAction, string> = {
  resume: 'Resume',
  cancel: 'Cancel run',
  rerun_again: 'Re-run and plan again',
  rerun_keep: 'Re-run with this plan',
  mark_done: 'Mark done',
}

const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <p>
    <strong>{title}:</strong> {children}
  </p>
)

const pickValue = (pick: FindingPick) => (typeof pick === 'number' ? `choice-${pick}` : pick)
const pickOf = (value: string): FindingPick =>
  value === 'out' || value === 'written' ? value : Number(value.slice('choice-'.length))

type Gate = 'spec' | 'plan' | 'pull_request'
type AnyReview = ReviewResult | PlanReviewResult | PrReviewResult
type AnyFinding = AnyReview['findings'][number]

/** The label of each next step a pull request review may give. */
export const NEXT_STEP_LABEL: Record<NextStep, string> = {
  merge: 'Merge',
  merge_and_file: 'Merge, then file the findings outside the task',
  fix_by_hand: 'Fix by hand on the branch',
  rerun_keep: 'Close the pull request, then Re-run with this plan',
  rerun_again: 'Close the pull request, then Re-run and plan again',
}

/** The heading of the next-gate group: it depends on the gate and on whether a blocker stands. */
export function nextGateHeading(gate: Gate, hasBlocker: boolean): string {
  if (gate === 'spec')
    return hasBlocker ? 'Goes into the note with the blockers' : 'Goes into the approval note'
  return hasBlocker ? 'Goes into the words with the blockers' : 'Waits for the pull request gate'
}

/**
 * A review result at any gate, in one shape: Ready or Changes needed, then Blockers, the next-gate
 * group and Outside the task, each under its own heading one level below the result's, then
 * Unsure about. When a handler is given and a blocker stands, a radio group per blocker and
 * next-gate finding and Use these findings. The picks live here, so a different result, which
 * remounts this, starts from "Use as written" again.
 */
function ReviewView({
  result,
  gate,
  level,
  onUseFindings,
  onUseInNote,
}: {
  result: AnyReview
  gate: Gate
  level: 3 | 4 | 5
  onUseFindings:
    ((result: ReviewResult | PlanReviewResult, picks: FindingPick[]) => void) | undefined
  /** The spec gate's, for a result with no blocker: the next-gate findings go to the approval note. */
  onUseInNote?: ((result: ReviewResult, picks: FindingPick[]) => void) | undefined
}) {
  const [picks, setPicks] = useState<FindingPick[]>(() => result.findings.map(() => 'written'))
  const toNote =
    onUseInNote !== undefined &&
    result.mode === 'review' &&
    result.blockers === 0 &&
    result.findings.some((finding) => finding.destination === 'next_gate')
  const picking =
    toNote || (onUseFindings !== undefined && result.blockers > 0 && result.mode !== 'code_review')
  const Heading = `h${level + 1}` as 'h4' | 'h5' | 'h6'
  const entries = result.findings.map((finding, index) => ({ finding, index }))
  const inGroup = (destination: AnyFinding['destination']) =>
    entries.filter(({ finding }) => finding.destination === destination)

  const item = ({ finding, index }: { finding: AnyFinding; index: number }) => {
    const choices = finding.choices ?? []
    const where = 'where' in finding && finding.where !== undefined ? ` (${finding.where})` : ''
    const controls = picking && finding.destination !== 'outside'
    return (
      <li key={index}>
        {finding.destination === 'outside' && finding.title !== undefined && (
          <strong>{finding.title}: </strong>
        )}
        {result.mode === 'code_review' ? (
          <Badge tone="neutral">{finding.kind}</Badge>
        ) : (
          <strong>{finding.kind}</strong>
        )}
        {where}: {finding.text}
        {'matters' in finding && (
          <>
            {' '}
            <strong>Why it matters:</strong> {finding.matters}
          </>
        )}{' '}
        <strong>Evidence:</strong> {finding.evidence}
        {!controls && choices.length > 0 && (
          <> Choices: {choicesLabel(choices, finding.recommended)}</>
        )}
        {controls && (
          <RadioGroup
            label={`What to do with finding ${index + 1}`}
            value={pickValue(picks[index] ?? 'written')}
            onChange={(value) =>
              setPicks((now) => now.map((pick, i) => (i === index ? pickOf(value) : pick)))
            }
          >
            <Radio value="written">Use as written</Radio>
            {choices.map((choice, at) => (
              <Radio key={at} value={pickValue(at)}>
                {at === finding.recommended ? `${choice} (recommended)` : choice}
              </Radio>
            ))}
            <Radio value="out">Leave out</Radio>
          </RadioGroup>
        )}
      </li>
    )
  }
  const group = (heading: string, list: typeof entries) =>
    list.length === 0 ? null : (
      <>
        <Heading>{heading}</Heading>
        <ul>{list.map(item)}</ul>
      </>
    )
  return (
    <>
      <p>
        {result.blockers === 0
          ? 'Ready'
          : `Changes needed: ${result.blockers} ${result.blockers === 1 ? 'blocker' : 'blockers'}`}
      </p>
      {group('Blockers', inGroup('blocker'))}
      {group(nextGateHeading(gate, result.blockers > 0), inGroup('next_gate'))}
      {group('Outside the task', inGroup('outside'))}
      {result.mode === 'code_review' && (result.skipped ?? []).length > 0 && (
        <Part title="Not reviewed">
          {(result.skipped ?? []).map((file, index) => (
            <Fragment key={file.path}>
              {index > 0 && ', '}
              <code>{file.path}</code> ({file.skip})
            </Fragment>
          ))}
        </Part>
      )}
      <Part title="Unsure about">{result.unsure}</Part>
      {result.mode === 'code_review' && (
        <>
          <Part title="Next step">{NEXT_STEP_LABEL[result.next_step] ?? result.next_step}</Part>
          <Part title="Why">{result.reasoning}</Part>
        </>
      )}
      {picking && (
        <Button
          type="button"
          onClick={() =>
            onUseInNote !== undefined && toNote && result.mode === 'review'
              ? onUseInNote(result, picks)
              : onUseFindings?.(result, picks)
          }
        >
          Use these findings
        </Button>
      )}
    </>
  )
}

/**
 * Renderers for the modes of the card's decisions. The Spec review and Review plan results hold a
 * radio group per finding and Use these findings when a handler is given and a blocker stands; no
 * other result holds a focusable control. `level` is the heading level of the result.
 */
export function decisionRenderers(
  checkedVersion: number | null,
  onUseFindings?: (result: ReviewResult | PlanReviewResult, picks: FindingPick[]) => void,
  level: 3 | 4 | 5 = 3,
  onUseInNote?: (result: ReviewResult, picks: FindingPick[]) => void,
): Renderers {
  return {
    review: (result) => (
      <ReviewView
        result={result}
        gate="spec"
        level={level}
        onUseFindings={onUseFindings}
        onUseInNote={onUseInNote}
      />
    ),
    review_plan: (result) => (
      <ReviewView result={result} gate="plan" level={level} onUseFindings={onUseFindings} />
    ),
    code_review: (result) => (
      <ReviewView result={result} gate="pull_request" level={level} onUseFindings={undefined} />
    ),
    restate: (result) => (
      <>
        <Part title="What changes">{result.changes}</Part>
        <Part title="What it requires">{result.requirements}</Part>
        <Part title="What it leaves out">{result.left_out}</Part>
      </>
    ),
    recommend: (result) => (
      <>
        <Part title="Why it stopped">{result.why_stopped}</Part>
        <Part title="Suggested action">{ACTION_LABEL[result.action] ?? result.action}</Part>
        <Part title="Why">{result.reasoning}</Part>
        <Part title="Unsure about">{result.unsure}</Part>
      </>
    ),
    check: (result) => (
      <>
        <Part title="Checked against">
          {result.checked_against === 'description'
            ? 'the description'
            : `the ${result.checked_against === 'approved_spec' ? 'approved' : 'latest'} spec v${checkedVersion ?? '?'}`}
        </Part>
        <Part title="What the runs produced">{result.produced}</Part>
        {result.unfinished.length === 0 ? (
          <p>Nothing unfinished found.</p>
        ) : (
          <ul>
            {result.unfinished.map((item, index) => (
              <li key={index}>
                {item.where === undefined ? '' : `${item.where}: `}
                {item.text}
              </li>
            ))}
          </ul>
        )}
        <Part title="Unsure about">{result.unsure}</Part>
      </>
    ),
  }
}
