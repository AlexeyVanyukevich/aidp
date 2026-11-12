import { useId, type ReactNode } from 'react'
import { Button } from '@zellige/react'
import type {
  ApprovalOption,
  HelpMode,
  HelpResult,
  QuestionHelpMode,
  StoppedRunAction,
} from '../types'
import {
  decisionFailure,
  failureText,
  resultHeading,
  type ModeHelp,
  type QuestionHelp,
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
      case 'explain':
        return renderers.explain?.(result)
      case 'review':
        return renderers.review?.(result)
      case 'restate':
        return renderers.restate?.(result)
      case 'recommend':
        return renderers.recommend?.(result)
      case 'check':
        return renderers.check?.(result)
      case 'advise':
        return renderers.advise?.(result)
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
          <section key={mode.id} aria-labelledby={`${id}-${mode.id}`} className="help-result">
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
}: {
  help: QuestionHelp
  options: ApprovalOption[]
  level: 4 | 5
  onAsk: (mode: QuestionHelpMode) => void
  onUse: (result: Suggestion) => void
}) {
  const label = (result: Suggestion) =>
    options.find((option) => option.id === result.option_id)?.label
  const modes: PanelMode[] = [
    {
      id: 'suggest',
      label: 'Suggest an answer',
      state: help.suggest,
      heading: 'Suggested answer',
      failureLine: (reason) => failureText('suggest', reason),
    },
    {
      id: 'explain',
      label: 'Explain simply',
      state: help.explain,
      heading: 'In plain words',
      failureLine: (reason) => failureText('explain', reason),
    },
  ]
  return (
    <div className="help">
      <div className="help-buttons">
        <HelpButtons modes={modes} onAsk={(mode) => onAsk(mode as QuestionHelpMode)} />
      </div>
      <HelpResults
        modes={modes}
        level={level}
        renderers={{
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
  id: 'review' | 'restate' | 'recommend' | 'check',
  label: string,
  state: ModeHelp,
): PanelMode {
  const subject = state.subject ?? null
  return {
    id,
    label,
    state,
    heading: resultHeading(id, subject),
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

/**
 * Renderers for the modes of the card's decisions. The Spec review result holds Use these
 * findings when a handler is given and its verdict is `changes`; no other result holds a
 * focusable control.
 */
export function decisionRenderers(
  checkedVersion: number | null,
  onUseFindings?: (result: ReviewResult) => void,
): Renderers {
  return {
    review: (result) => (
      <>
        {result.verdict === 'nothing_to_change' ? (
          <p>Nothing to change.</p>
        ) : (
          <ul>
            {result.findings.map((finding, index) => (
              <li key={index}>
                <strong>{finding.kind}</strong>
                {finding.where === undefined ? '' : ` (${finding.where})`}: {finding.text}
              </li>
            ))}
          </ul>
        )}
        <Part title="Unsure about">{result.unsure}</Part>
        {onUseFindings !== undefined && result.verdict === 'changes' && (
          <Button type="button" onClick={() => onUseFindings(result)}>
            Use these findings
          </Button>
        )}
      </>
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
