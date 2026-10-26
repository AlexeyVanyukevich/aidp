import { useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Empty, Field, Textarea } from '@zellige/react'
import { api } from '../api'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type { ApprovalAnswer, ApprovalView, BatchAnswer, TaskView } from '../types'
import {
  answerSummary,
  batchAnswerLines,
  batchHeading,
  currentApproval,
  fieldLabel,
  codeLabel,
  headingFor,
  migrationPath,
  optionName,
} from './approvals'
import { BatchForm } from './BatchForm'

/**
 * The card's questions (slice 2 spec, §11): the one it waits on, answered by an option or in
 * words, and those answered before. Answering removes the controls that did it, so the card
 * moves focus to its state line first, through `onAnswered`.
 */
export function ApprovalsTab({
  task,
  onAnswered,
  onProblem,
}: {
  task: TaskView
  onAnswered: (message: string) => void
  onProblem: (text: string) => void
}) {
  const client = useQueryClient()
  const approvals = useQuery({
    queryKey: ['approvals', task.id],
    queryFn: () => api.approvals(task.id),
  })
  const [text, setText] = useState('')
  const [missing, setMissing] = useState(false)
  const [sending, setSending] = useState<string | undefined>()
  const field = useRef<HTMLTextAreaElement>(null)
  const headingId = useId()
  const questionId = useId()
  const filesId = useId()
  const answeredId = useId()
  const impactId = useId()

  const answer = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ApprovalAnswer | BatchAnswer }) =>
      api.answer(id, body),
    onSuccess: () => {
      setText('')
      onAnswered(`${task.key} answered. The run continues.`)
    },
    onError: (error) => {
      if (isConflict(error))
        onProblem('This question was answered or withdrawn meanwhile; its latest state is shown.')
      else onProblem('The answer was not sent. Try again.')
    },
    onSettled: () => {
      setSending(undefined)
      return Promise.all([
        client.invalidateQueries({ queryKey: ['approvals', task.id] }),
        client.invalidateQueries({ queryKey: ['task', task.id] }),
        client.invalidateQueries({ queryKey: ['board'] }),
      ])
    },
  })

  const send = (approval: ApprovalView, body: ApprovalAnswer | BatchAnswer, which: string) => {
    setSending(which)
    answer.mutate({ id: approval.id, body })
  }
  const submit = (approval: ApprovalView) => (event: FormEvent) => {
    event.preventDefault()
    const empty = text.trim() === ''
    setMissing(empty)
    if (empty) field.current?.focus()
    else send(approval, { text: text.trim() }, 'text')
  }

  return (
    <Loaded query={approvals} failure="The questions could not be loaded.">
      {(list) => {
        const current = currentApproval(list, task.state)
        const answered = list.filter((a) => a.status === 'answered' || a.status === 'withdrawn')
        if (current === undefined && answered.length === 0)
          return (
            <Empty title="No questions yet">
              A question the run asks, or a plan it is not sure of, waits here for your answer.
            </Empty>
          )
        return (
          <div className="approvals-tab">
            {current !== undefined && current.kind === 'questions' && (
              <section aria-labelledby={headingId} className="approval">
                <h3 id={headingId}>{batchHeading(current.status)}</h3>
                <p className="question">{current.question}</p>
                {current.context_md !== null && current.context_md !== '' && (
                  <div className="context">{current.context_md}</div>
                )}
                <BatchForm
                  questions={current.questions ?? []}
                  sending={sending === 'batch'}
                  onSend={(body) => send(current, body, 'batch')}
                />
              </section>
            )}
            {current !== undefined && current.kind !== 'questions' && (
              <section aria-labelledby={headingId} className="approval">
                <h3 id={headingId}>{headingFor(current.status)}</h3>
                <p id={questionId} className="question">
                  {current.question}
                </p>
                {migrationPath(current) !== undefined ? (
                  <>
                    <p id={filesId}>The migration it asks to write:</p>
                    <p>
                      <code>{migrationPath(current)}</code>
                    </p>
                    {/* Plain text, never markup: a migration is code the owner reads as written. */}
                    <pre
                      className="code"
                      tabIndex={0}
                      role="region"
                      aria-label={codeLabel(migrationPath(current) ?? '')}
                    >
                      {current.context_md ?? ''}
                    </pre>
                  </>
                ) : (
                  <>
                    {current.context_md !== null && current.context_md !== '' && (
                      <div className="context">{current.context_md}</div>
                    )}
                    {current.files !== null && current.files.length > 0 && (
                      <>
                        <p id={filesId}>The files it asks to change:</p>
                        <ul aria-labelledby={filesId} className="files">
                          {current.files.map((file) => (
                            <li key={file}>
                              <code>{file}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
                {current.options.length > 0 && (
                  // The platform's group, named by the question it answers.
                  <fieldset aria-labelledby={questionId} className="options">
                    {current.options.map((option) => (
                      <div key={option.id} className="option">
                        <Button
                          variant={option.id === current.recommendation ? 'primary' : 'neutral'}
                          busy={sending === option.id}
                          aria-describedby={
                            option.impact === undefined ? undefined : `${impactId}-${option.id}`
                          }
                          onClick={() => send(current, { option_id: option.id }, option.id)}
                        >
                          {optionName(option, current.recommendation)}
                        </Button>
                        {option.impact !== undefined && (
                          <p id={`${impactId}-${option.id}`} className="impact">
                            {option.impact}
                          </p>
                        )}
                      </div>
                    ))}
                  </fieldset>
                )}
                <form onSubmit={submit(current)} className="answer">
                  <Field
                    label={fieldLabel(current.kind)}
                    hint="Sent to the agent as you write it."
                    error={missing ? 'Write an answer, or choose one of the options.' : undefined}
                  >
                    <Textarea
                      ref={field}
                      rows={4}
                      value={text}
                      onChange={(event) => {
                        setText(event.target.value)
                        if (missing) setMissing(false)
                      }}
                    />
                  </Field>
                  <Button type="submit" busy={sending === 'text'}>
                    Send answer
                  </Button>
                </form>
              </section>
            )}
            {answered.length > 0 && (
              <section aria-labelledby={answeredId}>
                <h3 id={answeredId}>Answered</h3>
                <ul className="answered">
                  {answered.map((approval) => (
                    <li key={approval.id}>
                      <span className="question">{approval.question}</span>{' '}
                      {approval.kind === 'questions' && approval.status === 'answered' ? (
                        <ul>
                          {batchAnswerLines(approval).map((line) => (
                            <li key={line.question}>
                              <span className="question">{line.question}</span>{' '}
                              <span className="answer-given">{line.answer}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="answer-given">{answerSummary(approval)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )
      }}
    </Loaded>
  )
}
