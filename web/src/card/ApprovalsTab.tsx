import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { flushSync } from 'react-dom'
import { Button, Empty, Field, Markdown, Radio, RadioGroup, Textarea } from '@zellige/react'
import { api } from '../api'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type {
  ApprovalAnswer,
  ApprovalView,
  BatchAnswer,
  AskedHelpMode,
  ApprovalKind,
  HelpMode,
  HelpView,
  ProposalView,
  SpecView,
  TaskView,
} from '../types'
import {
  actionProblem,
  answerSummary,
  batchAnswerLines,
  batchHeading,
  currentApproval,
  codeLabel,
  decisionHelp,
  NO_HELP,
  REVIEW_STEP_LABEL,
  specGateAnswer,
  specRefusal,
  specStepLock,
  specStepPress,
  specStepPresent,
  specFindings,
  wordsField,
  type SpecSend,
  headingFor,
  migrationPath,
  optionName,
  questionHelp,
  singleAnswer,
  answerRefusal,
  applySuggestion,
  suggestionMessage,
  fillNoteFromReview,
  type FindingPick,
  type PlanReviewResult,
  type ReviewResult,
  preSendProblem,
  type Choice,
} from './approvals'
import { BatchForm } from './BatchForm'
import { decisionMode, decisionRenderers, HelpButtons, HelpPanel, HelpResults } from './HelpPanel'
import { lintMessage, lintSummary } from './lint'
import { proposalsKey } from './ProposalsTab'

const AGENT_OF_PHASE: Record<string, string> = {
  spec: 'spec-writer',
  plan: 'planner',
  build: 'builder',
  verify: 'verifier',
}

/** The agent that made the open proposal of this title; a generic word when it is not found. */
function proposerOf(list: ProposalView[] | undefined, title: string): string {
  const found = list?.find((p) => p.title === title && p.outcome === null)
  return (found === undefined ? undefined : AGENT_OF_PHASE[found.phase]) ?? 'The agent'
}

const NOTHING = 'Write an answer, or choose one of the options.'
const APPROVE_REASON = 'Approve needs the latest version linting clean, with no open questions.'
const WAIT_FOR_REPHRASE = 'Wait for the rephrase to finish, or cancel it.'

/** What a form hands the controls it hosts: its choice, and the ways to change or send it. */
interface FormApi {
  choice: Choice
  /** Puts the choice in the form, clears the field's error, focuses the words, caret at the end. */
  put: (next: Choice) => void
  /** Sends the form as Send answer does, with the choice first put in it when given. */
  submit: (next?: Choice) => void
  /** Puts the choice in the form and marks the words field with the reason nothing is sent. */
  reject: (next: Choice, message: string) => void
  /** Edits the choice and clears the field's error. */
  edit: (change: (now: Choice) => Choice) => void
}

interface FormOption {
  id: string
  name: string
  description?: string | undefined
  /** Why the option cannot be chosen, and the id of the text that says so. */
  disabled?: { reason: string; id: string } | undefined
}

/** The state of a gate's form, kept by the gate so the controls it hosts can reach it. */
function useGateForm({
  refused,
  onEdit,
  onSubmit,
}: {
  refused: { message: string } | undefined
  onEdit: () => void
  /** Sends the choice, or returns why nothing was sent. */
  onSubmit: (choice: Choice) => string | undefined
}) {
  const [choice, setChoice] = useState<Choice>({ text: '' })
  const [problem, setProblem] = useState<string | undefined>()
  const field = useRef<HTMLTextAreaElement>(null)
  const group = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (refused !== undefined) field.current?.focus()
  }, [refused])

  const clear = () => {
    setProblem(undefined)
    if (refused !== undefined) onEdit()
  }
  const reject = (next: Choice, message: string) => {
    flushSync(() => {
      setChoice(next)
      setProblem(message)
    })
    if (refused !== undefined) onEdit()
    field.current?.focus()
  }
  const submit = (next?: Choice) => {
    const sent = next ?? choice
    if (next !== undefined) flushSync(() => setChoice(next))
    const early = onSubmit(sent)
    if (early !== undefined) reject(sent, early)
    else setProblem(undefined)
  }
  const api: FormApi = {
    choice,
    put: (next) => {
      flushSync(() => {
        setChoice(next)
        setProblem(undefined)
      })
      if (refused !== undefined) onEdit()
      field.current?.focus()
      field.current?.setSelectionRange(next.text.length, next.text.length)
    },
    submit,
    reject,
    edit: (change) => {
      setChoice(change)
      clear()
    },
  }
  return { api, choice, setChoice, problem, setProblem, field, group, clear, submit }
}
type GateFormState = ReturnType<typeof useGateForm>

/**
 * The one form of a gate, a single request's or the spec's: the helps and their results first
 * (its children), then the options as a radio group named by the question, Clear choice, the
 * words field and Send answer. Choosing sends nothing; a send with neither marks the words field
 * and focuses it.
 */
function GateForm({
  gate,
  form,
  question,
  options,
  sending,
  sendLock,
  refused,
  onEdit,
  children,
}: {
  gate: 'spec' | ApprovalKind
  form: GateFormState
  /** The radio group's name, or the sentence shown when there is nothing to choose. */
  question: string
  options: FormOption[]
  sending: boolean
  /** Why Send answer is disabled, and the id of the text that says so. */
  sendLock?: { reason: string; id: string } | undefined
  /**
   * The board refused the words: the owner's last send, and why the field is invalid. Shown
   * until the next send or edit, which the gate clears through `onSubmit` and `onEdit`.
   */
  refused: { message: string } | undefined
  onEdit: () => void
  children: ReactNode
}) {
  const { choice, setChoice, problem, setProblem, field, group, clear, submit } = form
  const questionId = useId()
  const words = wordsField(gate, choice.option)

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        submit()
      }}
      className="answer"
      noValidate
    >
      {children}
      {options.length > 0 ? (
        <>
          <RadioGroup
            ref={group}
            label={question}
            value={choice.option ?? null}
            onChange={(option) => setChoice((now) => ({ ...now, option }))}
          >
            {options.map((option) => (
              <Radio
                key={option.id}
                value={option.id}
                {...(option.description === undefined ? {} : { description: option.description })}
                {...(option.disabled === undefined
                  ? {}
                  : { disabled: true, 'aria-describedby': option.disabled.id })}
              >
                {option.name}
              </Radio>
            ))}
          </RadioGroup>
          {options.map(
            (option) =>
              option.disabled !== undefined && (
                <span key={option.disabled.id} id={option.disabled.id} className="muted">
                  {option.disabled.reason}
                </span>
              ),
          )}
          {choice.option !== undefined && (
            <Button
              variant="neutral"
              onClick={() => {
                flushSync(() => {
                  setChoice((now) => ({ text: now.text }))
                  setProblem(undefined)
                })
                if (refused !== undefined) onEdit()
                group.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus()
              }}
            >
              Clear choice
            </Button>
          )}
        </>
      ) : (
        <p id={questionId} className="question">
          {question}
        </p>
      )}
      <Field label={words.label} hint={words.hint} error={problem ?? refused?.message}>
        <Textarea
          ref={field}
          rows={4}
          value={choice.text}
          onChange={(event) => {
            setChoice((now) => ({ ...now, text: event.target.value }))
            clear()
          }}
        />
      </Field>
      <Button
        type="submit"
        busy={sending}
        disabled={sendLock !== undefined}
        aria-describedby={sendLock?.id}
      >
        Send answer
      </Button>
      {sendLock !== undefined && (
        <span id={sendLock.id} className="muted">
          {sendLock.reason}
        </span>
      )}
    </form>
  )
}

/**
 * A single request's form: the question helps, and Review plan at the plan gate. Use this answer
 * and Use these findings fill the form and send nothing.
 */
function SingleForm({
  approval,
  helps,
  sending,
  refused,
  onAsk,
  onReviewPlan,
  onAnnounce,
  onSend,
  onEdit,
  onFile,
  ownProject,
}: {
  approval: ApprovalView
  helps: HelpView[]
  sending: boolean
  refused: { message: string } | undefined
  onAsk: (mode: AskedHelpMode) => void
  onReviewPlan: () => void
  onAnnounce: (message: string) => void
  onSend: (body: ApprovalAnswer) => void
  onEdit: () => void
  /** File on an outside finding of the plan review; resolves true once it is filed. */
  onFile: (helpId: string, index: number) => Promise<boolean>
  ownProject: string
}) {
  const hasOptions = approval.options.length > 0
  const state = useGateForm({
    refused,
    onEdit,
    onSubmit: (choice) => {
      const early = preSendProblem(approval.kind, choice)
      if (early !== undefined) return early
      const body = singleAnswer(choice)
      if (body === null) return hasOptions ? NOTHING : 'Write an answer.'
      onSend(body)
      return undefined
    },
  })
  const form = state.api
  return (
    <GateForm
      form={state}
      gate={approval.kind}
      question={approval.question}
      options={approval.options.map((option) => ({
        id: option.id,
        name: optionName(option, approval.recommendation),
        description: option.impact,
      }))}
      sending={sending}
      refused={refused}
      onEdit={onEdit}
    >
      <HelpPanel
        help={questionHelp(helps, approval.id, null)}
        options={approval.options}
        level={4}
        onAsk={onAsk}
        {...(approval.kind === 'plan'
          ? {
              planReview: {
                onAsk: onReviewPlan,
                onUseFindings: (result: ReviewResult | PlanReviewResult, picks: FindingPick[]) => {
                  const next = fillNoteFromReview(form.choice.text, result, picks)
                  form.put({ text: next })
                  onAnnounce(
                    next === form.choice.text
                      ? 'Every finding is left out; the words are unchanged.'
                      : 'Findings put in the words.',
                  )
                },
                actions: { ownProject, onFile },
              },
            }
          : {})}
        requestKind={approval.kind}
        onUse={(result) => {
          const message = suggestionMessage(approval.kind, form.choice, result)
          form.edit((now) => applySuggestion(approval.kind, now, result))
          if (message !== undefined) onAnnounce(message)
        }}
      />
    </GateForm>
  )
}

/**
 * The spec gate: the latest version formatted, its Lint, and the one form that approves it or
 * sends it back. It is a view of the card's Spec review state, not an approval record.
 */
function SpecGate({
  task,
  latest,
  helps,
  onProblem,
  onAnnounce,
  onDecided,
  onEditOnSpec,
}: {
  task: TaskView
  latest: SpecView
  helps: HelpView[]
  onProblem: (text: string) => void
  onAnnounce: (message: string) => void
  /** The card moves focus to its state line before the form goes. */
  onDecided: () => void
  onEditOnSpec: () => void
}) {
  const client = useQueryClient()
  const headingId = useId()
  const reasonId = useId()
  const waitId = useId()
  const [refused, setRefused] = useState<{ message: string } | undefined>()
  const approvable = latest.lint.approvable
  const rephrasing = task.rephrase?.status === 'queued' || task.rephrase?.status === 'running'

  const reviewHelp = decisionHelp(helps, 'spec_review')
  const modes = [
    decisionMode('review', 'Review spec', reviewHelp.review ?? NO_HELP),
    decisionMode('restate', 'Explain simply', reviewHelp.restate ?? NO_HELP),
  ]
  const state = useGateForm({
    refused,
    onEdit: () => setRefused(undefined),
    onSubmit: (choice) => {
      const what = specGateAnswer(choice)
      if (!what.send) return what.message
      send.mutate(what)
      return undefined
    },
  })
  const form = state.api
  const useFindings = (result: ReviewResult | PlanReviewResult, picks: FindingPick[]) => {
    if (result.mode !== 'review') return
    const used = specFindings(form.choice, result, picks, approvable)
    form.put(used.choice)
    onAnnounce(used.message)
  }
  const hasResults = modes.some(
    (mode) => mode.state.shown !== undefined || mode.state.failure !== undefined,
  )

  const reviewMode = modes[0]!
  const resultVersion =
    (reviewMode.state.subject as { spec_version?: number } | null)?.spec_version ?? null

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['specs', task.id] }),
      client.invalidateQueries({ queryKey: ['task', task.id] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const ask = useMutation({
    mutationFn: (mode: HelpMode) => api.askDecisionHelp(task.id, 'spec_review', mode),
    onError: (error) =>
      onProblem(
        isConflict(error)
          ? 'This card changed meanwhile; its latest state is shown.'
          : 'That did not work. Try again.',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })
  const send = useMutation({
    mutationFn: async (what: Extract<SpecSend, { send: true }>) => {
      if (what.action === 'approve') await api.approve(latest.id, what.note)
      else await api.redraft(task.id, what.note)
    },
    onMutate: () => setRefused(undefined),
    onSuccess: onDecided,
    onError: (error, what) => {
      const refusal = specRefusal(what.action, error)
      if ('field' in refusal) {
        setRefused({ message: refusal.field })
        onAnnounce(refusal.field)
      } else onProblem(refusal.problem)
    },
    onSettled: refresh,
  })
  /** File on an outside finding: the status region says so, a refusal is the card's notice. */
  const fileFinding = async (helpId: string, index: number): Promise<boolean> => {
    try {
      const filed = await api.fileFinding(task.id, helpId, index)
      await client.invalidateQueries({ queryKey: ['helps', task.id] })
      onAnnounce(`Filed ${filed.key}: ${filed.title}.`)
      return true
    } catch (error) {
      onProblem(actionProblem(error))
      await client.invalidateQueries({ queryKey: ['helps', task.id] })
      return false
    }
  }

  return (
    <section aria-labelledby={headingId} className="approval spec-gate">
      <h3 id={headingId}>Spec review</h3>
      <h4>Spec v{latest.version}</h4>
      <Markdown source={latest.body_md} headingLevel={5} />
      <h4>Lint</h4>
      {latest.lint.approvable ? (
        <p>{lintSummary(latest.lint)}</p>
      ) : (
        <ul>
          {latest.lint.findings.map((finding, index) => (
            <li key={index}>{lintMessage(finding)}</li>
          ))}
          {latest.lint.open_questions.map((question) => (
            <li key={question}>Open question: {question}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <Button onClick={onEditOnSpec}>Edit on the Spec tab</Button>
      </div>
      <GateForm
        form={state}
        gate="spec"
        question={`Approve spec v${latest.version}, or say what to change`}
        options={[
          {
            id: 'approve',
            name: 'Approve spec',
            disabled: approvable ? undefined : { reason: APPROVE_REASON, id: reasonId },
          },
        ]}
        sending={send.isPending}
        sendLock={rephrasing ? { reason: WAIT_FOR_REPHRASE, id: waitId } : undefined}
        refused={refused}
        onEdit={() => setRefused(undefined)}
      >
        <>
          <div className="actions">
            <HelpButtons modes={modes} onAsk={(mode) => ask.mutate(mode)} />
          </div>
          {hasResults && (
            <HelpResults
              level={4}
              modes={modes}
              renderers={decisionRenderers(null, useFindings, 4, useFindings, {
                ownProject: task.key.replace(/-\d+$/, ''),
                onFile: fileFinding,
                step: (result, helpId) => {
                  if (result.mode !== 'review' || result.next_step === undefined) return undefined
                  const step = result.next_step
                  if (helpId === undefined || !specStepPresent(resultVersion, latest.version))
                    return undefined
                  const lock = specStepLock(step, { canApprove: approvable, rephrasing })
                  return {
                    label: REVIEW_STEP_LABEL[step],
                    disabled: lock !== null,
                    busy: send.isPending,
                    describedBy:
                      lock === 'rephrasing'
                        ? waitId
                        : lock === 'unapprovable'
                          ? reasonId
                          : undefined,
                    onPress: (picks) => {
                      const press = specStepPress(step, result, picks, form.choice)
                      if (press.send.send) form.submit(press.choice)
                      else form.reject(press.choice, press.send.message)
                    },
                  }
                },
              })}
            />
          )}
        </>
      </GateForm>
    </section>
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
  onAnnounce,
  onSpecDecided,
  onEditOnSpec,
}: {
  task: TaskView
  onAnswered: (message: string) => void
  onProblem: (text: string) => void
  /** Writes to the card's status region, announcing a message equal to the last one again. */
  onAnnounce: (message: string) => void
  /** A spec decision was sent: focus goes to the state line before the form goes. */
  onSpecDecided: () => void
  /** Edit on the Spec tab: the Spec tab opens with its editor. */
  onEditOnSpec: () => void
}) {
  const client = useQueryClient()
  const inSpecReview = task.state === 'spec_review'
  const specs = useQuery({
    queryKey: ['specs', task.id],
    queryFn: () => api.specs(task.id),
    enabled: inSpecReview,
  })
  const approvals = useQuery({
    queryKey: ['approvals', task.id],
    queryFn: () => api.approvals(task.id),
  })
  const helps = useQuery({
    queryKey: ['helps', task.id],
    queryFn: () => api.helps(task.id),
  })
  const proposals = useQuery({
    queryKey: proposalsKey(task.id),
    queryFn: () => api.proposals(task.id),
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
      const refusal = answerRefusal(error)
      if (refusal !== undefined) setRefused({ message: refusal })
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
    mutationFn: ({ id, mode, index }: { id: string; mode: AskedHelpMode; index: number | null }) =>
      api.askHelp(id, mode, index),
    onError: (error) =>
      onProblem(
        isConflict(error)
          ? 'This question was answered or withdrawn meanwhile; its latest state is shown.'
          : 'The help was not asked. Try again.',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })
  /** File on an outside finding of Review plan: the status region says so, a refusal is a notice. */
  const fileFinding = async (helpId: string, index: number): Promise<boolean> => {
    try {
      const filed = await api.fileFinding(task.id, helpId, index)
      await client.invalidateQueries({ queryKey: ['helps', task.id] })
      onAnnounce(`Filed ${filed.key}: ${filed.title}.`)
      return true
    } catch (error) {
      onProblem(actionProblem(error))
      await client.invalidateQueries({ queryKey: ['helps', task.id] })
      return false
    }
  }
  const planReview = useMutation({
    mutationFn: (id: string) => api.reviewPlan(id),
    onError: (error) =>
      onProblem(
        isConflict(error)
          ? 'This question was answered or withdrawn meanwhile; its latest state is shown.'
          : 'The plan review was not asked. Try again.',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })
  const askFor = (approval: ApprovalView) => (mode: AskedHelpMode, index: number | null) =>
    ask.mutate({ id: approval.id, mode, index })

  return (
    <Loaded query={approvals} failure="The questions could not be loaded.">
      {(list) => {
        const current = currentApproval(list, task.state)
        if (current?.kind === 'proposal')
          return (
            <p>
              {proposerOf(proposals.data, current.question)} proposed a task: {current.question}.
              Settle it on the Proposals tab.
            </p>
          )
        const answered = list.filter((a) => a.status === 'answered' || a.status === 'withdrawn')
        const latest = inSpecReview ? specs.data?.[0] : undefined
        // The empty state waits for the spec, so it does not flash before the gate shows.
        if (current === undefined && answered.length === 0 && inSpecReview && specs.isPending)
          return null
        if (current === undefined && answered.length === 0 && latest === undefined)
          return (
            <Empty title="No questions yet">
              A question the run asks, or a plan it is not sure of, waits here for your answer.
            </Empty>
          )
        return (
          <div className="approvals-tab">
            {latest !== undefined && (
              <SpecGate
                task={task}
                latest={latest}
                helps={helps.data ?? []}
                onProblem={onProblem}
                onAnnounce={onAnnounce}
                onDecided={onSpecDecided}
                onEditOnSpec={onEditOnSpec}
              />
            )}
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
                  onAnnounce={onAnnounce}
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
                  onReviewPlan={() => planReview.mutate(current.id)}
                  onAnnounce={onAnnounce}
                  onSend={(body) => {
                    setRefused(undefined)
                    send(current, body, 'single')
                  }}
                  onEdit={() => setRefused(undefined)}
                  onFile={fileFinding}
                  ownProject={task.key.replace(/-\d+$/, '')}
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
