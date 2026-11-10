import { useId, type ReactNode } from 'react'
import { Button } from '@zellige/react'
import type { ApprovalOption, HelpMode, HelpResult, QuestionHelpMode } from '../types'
import { failureText, type ModeHelp, type QuestionHelp } from './approvals'

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
    }
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
