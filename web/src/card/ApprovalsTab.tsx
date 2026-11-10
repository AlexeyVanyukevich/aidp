import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { flushSync } from 'react-dom'
import { Button, Empty, Field, Markdown, Radio, RadioGroup, Textarea } from '@zellige/react'
import { api } from '../api'
import { invalidField, isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type {
  ApprovalAnswer,
  ApprovalView,
  BatchAnswer,
  QuestionHelpMode,
  HelpView,
  TaskView,
} from '../types'
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
  questionHelp,
  singleAnswer,
  applySuggestion,
  type Choice,
} from './approvals'
import { BatchForm } from './BatchForm'
import { HelpPanel } from './HelpPanel'

const NOTHING = 'Write an answer, or choose one of the options.'
const NO_WORDS_WITH_PLAN =
  'Approving the plan carries no words. Clear them, or leave the plan unchosen to ask for changes.'

/**
 * A single request's one form: its options as a radio group named by the question, the words
 * field, and one Send answer. Choosing sends nothing; a send with neither marks the words field
 * and focuses it. Use this answer fills the form and sends nothing.
 */
function SingleForm({
  approval,
  helps,
  sending,
  refused,
  onAsk,
  onSend,
  onEdit,
}: {
  approval: ApprovalView
  helps: HelpView[]
  sending: boolean
  /**
   * The board refused the words: the owner's last send, and why the field is invalid. Shown
   * until the next send or edit, which the parent clears through `onSend` and `onEdit`.
   */
  refused: { message: string } | undefined
  onAsk: (mode: QuestionHelpMode) => void
  onSend: (body: ApprovalAnswer) => void
  onEdit: () => void
}) {
  const [choice, setChoice] = useState<Choice>({ text: '' })
  const [problem, setProblem] = useState<string | undefined>()
  const field = useRef<HTMLTextAreaElement>(null)
  const questionId = useId()
  const hasOptions = approval.options.length > 0

  useEffect(() => {
    if (refused !== undefined) field.current?.focus()
  }, [refused])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const body = singleAnswer(choice)
    if (body === null) {
      flushSync(() => setProblem(hasOptions ? NOTHING : 'Write an answer.'))
      field.current?.focus()
      return
    }
    setProblem(undefined)
    onSend(body)
  }

  return (
    <form onSubmit={submit} className="answer" noValidate>
      <HelpPanel
        help={questionHelp(helps, approval.id, null)}
        options={approval.options}
        level={4}
        onAsk={onAsk}
        onUse={(result) => setChoice((now) => applySuggestion(now, result))}
      />
      {hasOptions ? (
        <RadioGroup
          label={approval.question}
          value={choice.option ?? null}
          onChange={(option) => setChoice((now) => ({ ...now, option }))}
        >
          {approval.options.map((option) => (
            <Radio
              key={option.id}
              value={option.id}
              {...(option.impact === undefined ? {} : { description: option.impact })}
            >
              {optionName(option, approval.recommendation)}
            </Radio>
          ))}
        </RadioGroup>
      ) : (
        <p id={questionId} className="question">
          {approval.question}
        </p>
      )}
      <Field
        label={fieldLabel(approval.kind)}
        hint="Sent to the agent as you write it."
        error={problem ?? refused?.message}
      >
        <Textarea
          ref={field}
          rows={4}
          value={choice.text}
          onChange={(event) => {
            setChoice((now) => ({ ...now, text: event.target.value }))
            if (problem !== undefined) setProblem(undefined)
            if (refused !== undefined) onEdit()
          }}
        />
      </Field>
      <Button type="submit" busy={sending}>
        Send answer
      </Button>
    </form>
  )
}

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
  const helps = useQuery({
    queryKey: ['helps', task.id],
    queryFn: () => api.helps(task.id),
  })
  const [sending, setSending] = useState<string | undefined>()
  const [refused, setRefused] = useState<{ message: string } | undefined>()
  const headingId = useId()
  const filesId = useId()
  const answeredId = useId()

  const answer = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ApprovalAnswer | BatchAnswer }) =>
      api.answer(id, body),
    onSuccess: () => {
      onAnswered(`${task.key} answered. The run continues.`)
    },
    onError: (error) => {
      if (invalidField(error) === 'text') setRefused({ message: NO_WORDS_WITH_PLAN })
      else if (isConflict(error))
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
  const ask = useMutation({
    mutationFn: ({
      id,
      mode,
      index,
    }: {
      id: string
      mode: QuestionHelpMode
      index: number | null
    }) => api.askHelp(id, mode, index),
    onError: (error) =>
      onProblem(
        isConflict(error)
          ? 'This question was answered or withdrawn meanwhile; its latest state is shown.'
          : 'The help was not asked. Try again.',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })
  const askFor = (approval: ApprovalView) => (mode: QuestionHelpMode, index: number | null) =>
    ask.mutate({ id: approval.id, mode, index })

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
                  <div className="context">
                    <Markdown source={current.context_md} headingLevel={4} />
                  </div>
                )}
                <BatchForm
                  questions={current.questions ?? []}
                  approvalId={current.id}
                  helps={helps.data ?? []}
                  onAsk={askFor(current)}
                  sending={sending === 'batch'}
                  onSend={(body) => send(current, body, 'batch')}
                />
              </section>
            )}
            {current !== undefined && current.kind !== 'questions' && (
              <section aria-labelledby={headingId} className="approval">
                <h3 id={headingId}>{headingFor(current.status)}</h3>
                {migrationPath(current) !== undefined ? (
                  <>
                    <p id={filesId}>The migration it asks to write:</p>
                    <p>
                      <code>{migrationPath(current)}</code>
                    </p>
                    {/* Plain text, never markup: a migration is code the owner reads as written. */}
                    <section
                      className="code"
                      aria-label={codeLabel(migrationPath(current) ?? '')}
                      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the block scrolls, so it must be reachable by keyboard (WCAG 2.1.1)
                      tabIndex={0}
                    >
                      <pre>{current.context_md ?? ''}</pre>
                    </section>
                  </>
                ) : (
                  <>
                    {current.context_md !== null && current.context_md !== '' && (
                      <div className="context">
                        <Markdown source={current.context_md} headingLevel={4} />
                      </div>
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
                <SingleForm
                  key={current.id}
                  approval={current}
                  helps={helps.data ?? []}
                  sending={sending === 'single'}
                  refused={refused}
                  onAsk={(mode) => askFor(current)(mode, null)}
                  onSend={(body) => {
                    setRefused(undefined)
                    send(current, body, 'single')
                  }}
                  onEdit={() => setRefused(undefined)}
                />
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
