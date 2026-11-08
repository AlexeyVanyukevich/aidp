import { useId } from 'react'
import { Button } from '@zellige/react'
import type { ApprovalOption, HelpMode, HelpResult } from '../types'
import { failureText, type ModeHelp, type QuestionHelp } from './approvals'

type Suggestion = Extract<HelpResult, { mode: 'suggest' }>

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
  onAsk: (mode: HelpMode) => void
  onUse: (result: Suggestion) => void
}) {
  const id = useId()
  const Heading = `h${level}` as const
  const ask = (mode: HelpMode, state: ModeHelp) => () => {
    if (!state.busy) onAsk(mode)
  }
  const suggestion = help.suggest.shown?.mode === 'suggest' ? help.suggest.shown : undefined
  const explanation = help.explain.shown?.mode === 'explain' ? help.explain.shown : undefined
  const label = (result: Suggestion) =>
    options.find((option) => option.id === result.option_id)?.label

  return (
    <div className="help">
      <div className="help-buttons">
        <Button busy={help.suggest.busy} onClick={ask('suggest', help.suggest)}>
          Suggest an answer
        </Button>
        <Button busy={help.explain.busy} onClick={ask('explain', help.explain)}>
          Explain simply
        </Button>
      </div>
      {help.suggest.failure !== undefined && (
        <p className="help-failure">{failureText('suggest', help.suggest.failure)}</p>
      )}
      {help.explain.failure !== undefined && (
        <p className="help-failure">{failureText('explain', help.explain.failure)}</p>
      )}
      {suggestion !== undefined && (
        <section aria-labelledby={`${id}-suggest`} className="help-result">
          <Heading id={`${id}-suggest`}>Suggested answer</Heading>
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
        </section>
      )}
      {explanation !== undefined && (
        <section aria-labelledby={`${id}-explain`} className="help-result">
          <Heading id={`${id}-explain`}>In plain words</Heading>
          <p>
            <strong>What is asked:</strong> {explanation.asked}
          </p>
          <p>
            <strong>Why it matters:</strong> {explanation.matters}
          </p>
          <p>
            <strong>What each answer leads to:</strong> {explanation.leads_to}
          </p>
        </section>
      )}
    </div>
  )
}
