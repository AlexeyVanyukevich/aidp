import { useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Button, Field, Markdown, Radio, RadioGroup, Textarea } from '@zellige/react'
import { HelpPanel } from './HelpPanel'
import type { BatchAnswer, BatchQuestion, QuestionHelpMode, HelpView } from '../types'
import {
  answerFieldHint,
  answerFieldLabel,
  batchAnswer,
  optionName,
  fillEveryAnswer,
  hasWholeAnswers,
  questionHelp,
  unanswered,
  applySuggestion,
  type Choices,
} from './approvals'

const MISSING = 'Choose an option or write an answer.'

/**
 * A batch's questions, answered together (slice 3 spec, §11): a radio group per question with
 * options, an answer field for each, and one Send answers. Choosing sends nothing. A send with
 * questions unanswered marks each, and moves focus to the first: its group's first radio, which
 * the error describes, or its field when it has no options.
 */
export function BatchForm({
  questions,
  approvalId,
  helps,
  onAsk,
  onAnnounce,
  sending,
  onSend,
}: {
  questions: BatchQuestion[]
  approvalId: string
  helps: HelpView[]
  onAsk: (mode: QuestionHelpMode, index: number | null) => void
  /** Writes to the card's status region, so a press whose words repeat is still announced. */
  onAnnounce: (text: string) => void
  sending: boolean
  onSend: (body: BatchAnswer) => void
}) {
  const id = useId()
  const [choices, setChoices] = useState<Choices>({})
  const [missing, setMissing] = useState<number[]>([])
  const firstRadios = useRef<(HTMLInputElement | null)[]>([])
  const fields = useRef<(HTMLTextAreaElement | null)[]>([])

  const choose = (questionId: string, change: { option?: string; text?: string }) => {
    setChoices((now) => {
      const was = now[questionId] ?? { text: '' }
      return {
        ...now,
        [questionId]: {
          text: change.text ?? was.text,
          ...((change.option ?? was.option) === undefined
            ? {}
            : { option: change.option ?? was.option }),
        },
      }
    })
    const index = questions.findIndex((question) => question.id === questionId)
    if (missing.includes(index)) setMissing((now) => now.filter((gap) => gap !== index))
  }

  const useEvery = () => {
    const filling = fillEveryAnswer(questions, choices, (question, index) => {
      const shown = questionHelp(helps, approvalId, index, question.id).suggest.shown
      return shown?.mode === 'suggest' ? shown : undefined
    })
    setChoices(filling.choices)
    const filledIndexes = filling.filled.map((id) => questions.findIndex((q) => q.id === id))
    setMissing((now) => now.filter((gap) => !filledIndexes.includes(gap)))
    onAnnounce(filling.message)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const gaps = unanswered(questions, choices)
    // The errors are on the page before focus arrives, so they are read with the control.
    flushSync(() => setMissing(gaps))
    const first = gaps[0]
    if (first === undefined) {
      onSend(batchAnswer(questions, choices))
      return
    }
    const target = questions[first]?.options.length
      ? firstRadios.current[first]
      : fields.current[first]
    target?.focus()
  }

  return (
    <form className="batch" onSubmit={submit} noValidate>
      {questions.map((question, index) => {
        const number = index + 1
        const hasOptions = question.options.length > 0
        const isMissing = missing.includes(index)
        const headingId = `${id}-q${number}`
        return (
          <section key={question.id} aria-labelledby={headingId} className="batch-question">
            <h4 id={headingId}>
              Question {number} of {questions.length}
            </h4>
            {question.context_md !== null && question.context_md !== '' && (
              <div className="context">
                <Markdown source={question.context_md} headingLevel={5} />
              </div>
            )}
            <HelpPanel
              help={questionHelp(helps, approvalId, index, question.id)}
              options={question.options}
              level={5}
              onAsk={(mode) => onAsk(mode, index)}
              onUse={(result) =>
                setChoices((now) => {
                  const next = applySuggestion('question', now[question.id] ?? { text: '' }, result)
                  return { ...now, [question.id]: next }
                })
              }
            />
            {hasOptions ? (
              <RadioGroup
                label={question.question}
                value={choices[question.id]?.option ?? null}
                onChange={(option) => choose(question.id, { option })}
                error={isMissing ? MISSING : undefined}
              >
                {question.options.map((option, optionIndex) => (
                  <Radio
                    key={option.id}
                    value={option.id}
                    {...(option.impact === undefined ? {} : { description: option.impact })}
                    ref={(element) => {
                      if (optionIndex === 0) firstRadios.current[index] = element
                    }}
                  >
                    {optionName(option, question.recommendation)}
                  </Radio>
                ))}
              </RadioGroup>
            ) : (
              <p className="question">{question.question}</p>
            )}
            <Field
              label={answerFieldLabel(number)}
              hint={answerFieldHint(hasOptions)}
              error={isMissing && !hasOptions ? MISSING : undefined}
            >
              <Textarea
                ref={(element) => {
                  fields.current[index] = element
                }}
                rows={3}
                value={choices[question.id]?.text ?? ''}
                onChange={(event) => choose(question.id, { text: event.target.value })}
              />
            </Field>
          </section>
        )
      })}
      {hasWholeAnswers(helps, approvalId) && (
        <Button type="button" onClick={useEvery}>
          Use every answer
        </Button>
      )}
      <Button type="submit" variant="primary" busy={sending}>
        Send answers
      </Button>
    </form>
  )
}
