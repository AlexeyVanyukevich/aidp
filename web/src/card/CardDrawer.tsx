import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, Notice, Tabs } from '@zellige/react'
import { api } from '../api'
import { columns, LABELS, stepPatch } from '../board/columns'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import { useDocumentTitle } from '../page'
import type { TaskState, TaskView } from '../types'
import { ApprovalsTab } from './ApprovalsTab'
import { actionsFor, blockText, initialTab, stateAnnouncement } from './blocks'
import { CostTab } from './CostTab'
import { PlanTab } from './PlanTab'
import { PrTab } from './PrTab'
import { SpecTab } from './SpecTab'
import { TimelineTab } from './TimelineTab'
import './card.css'

type Patch = { position: number } | { state: 'done' }

export function CardDrawer() {
  const { key = '', taskId = '' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId) })
  const board = useQuery({ queryKey: ['board', key], queryFn: () => api.board(key) })
  const [tab, setTab] = useState('spec')
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<{ text: string } | undefined>()
  const stateLine = useRef<HTMLParagraphElement>(null)
  const problemBox = useRef<HTMLDivElement>(null)
  useDocumentTitle(task.data ? `${task.data.key} ${task.data.title}` : undefined)

  // A card waiting on a question opens on it, once, when it first loads.
  const opened = useRef(false)
  useEffect(() => {
    if (task.data === undefined || opened.current) return
    opened.current = true
    setTab(initialTab(task.data))
  }, [task.data])

  // The page behind a modal dialog is inert, its live region with it, so the card announces its
  // own changes of state — those its buttons made and those the runner made. What a button said
  // (`lead`) comes first, so the state change does not replace it.
  const seen = useRef<TaskState | undefined>(undefined)
  const lead = useRef('')
  const announce = (text: string) => {
    lead.current = text
    setMessage(text)
  }
  useEffect(() => {
    if (task.data === undefined) return
    const { key: taskKey, state, draft_failure: draftFailure } = task.data
    const from = seen.current
    seen.current = state
    if (from === undefined || from === state) return
    const say = (latestVersion: number | null) => {
      const text = stateAnnouncement({ key: taskKey, from, to: state, latestVersion, draftFailure })
      setMessage(`${lead.current === '' ? '' : `${lead.current} `}${text}`)
      lead.current = ''
    }
    // A finished draft names its version; the specs are read afresh, since the notice that
    // moved the card may arrive before the one that refreshes them.
    if (from === 'spec_draft' && state === 'spec_review' && draftFailure === null)
      client
        .fetchQuery({ queryKey: ['specs', taskId], queryFn: () => api.specs(taskId), staleTime: 0 })
        .then(
          (specs) => say(specs[0]?.version ?? null),
          () => say(null),
        )
    else say(null)
  }, [task.data, client, taskId])
  useEffect(() => {
    if (problem) problemBox.current?.focus()
  }, [problem])

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['task', taskId] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const fail = (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? 'This card changed meanwhile; its latest state is shown.'
        : 'That did not work. Try again.',
    })
  // A button that changes the state removes itself; focus moves first to the state line, which
  // names the new state once it arrives.
  const leave = () => stateLine.current?.focus()
  const move = useMutation({
    mutationFn: (body: Patch) => api.patchTask(taskId, body),
    onMutate: () => setProblem(undefined),
    onError: fail,
    onSettled: refresh,
  })
  const rerun = useMutation({
    mutationFn: (plan: 'keep' | 'again') => api.rerun(taskId, plan),
    onMutate: () => setProblem(undefined),
    onSuccess: leave,
    onError: fail,
    onSettled: refresh,
  })
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'resume') => api.action(taskId, action),
    onMutate: () => setProblem(undefined),
    onSuccess: leave,
    onError: fail,
    onSettled: refresh,
  })

  const step = (direction: 'up' | 'down') => {
    const card = board.data?.tasks.find((c) => c.id === taskId)
    if (board.data === undefined || card === undefined) return
    const where = LABELS[card.state]
    const body = stepPatch(card, columns(board.data.tasks)[card.state], direction)
    if (body === null)
      setMessage(
        `${card.key} is already at the ${direction === 'up' ? 'top' : 'bottom'} of ${where}.`,
      )
    else
      move.mutate(body, {
        onSuccess: () => setMessage(`${card.key} moved ${direction} in ${where}.`),
      })
  }

  const items = (t: TaskView) => [
    { id: 'spec', label: 'Spec', panel: <SpecTab task={t} onFrozen={leave} /> },
    { id: 'plan', label: 'Plan', panel: <PlanTab task={t} /> },
    { id: 'timeline', label: 'Timeline', panel: <TimelineTab task={t} /> },
    {
      id: 'approvals',
      label: 'Approvals',
      panel: (
        <ApprovalsTab
          task={t}
          onAnswered={(text) => {
            leave()
            announce(text)
          }}
          onProblem={(text) => setProblem({ text })}
        />
      ),
    },
    { id: 'cost', label: 'Cost', panel: <CostTab task={t} /> },
    { id: 'pr', label: 'PR', panel: <PrTab task={t} /> },
  ]

  return (
    <Dialog
      open
      onClose={() => navigate(`/p/${key}`)}
      title={task.data?.title ?? 'Card'}
      placement="side"
      className="card-dialog"
    >
      <Loaded query={task} failure="This card could not be loaded.">
        {(t) => {
          const offered = actionsFor(t.state, t.block, t.plan_to_keep)
          return (
            <div className="card-body">
              <p className="state-line" ref={stateLine} tabIndex={-1}>
                {t.key} · {LABELS[t.state]}
              </p>
              {t.state === 'blocked' && t.block !== null && (
                <div className="block-reason">
                  <p>{blockText(t.block)}</p>
                  {t.block.output !== undefined && t.block.output !== '' && (
                    <details>
                      <summary>Command output</summary>
                      <pre>{t.block.output}</pre>
                    </details>
                  )}
                </div>
              )}
              {t.draft_failure !== null && (
                <p className="block-reason">The last draft did not finish: {t.draft_failure}.</p>
              )}
              <div className="card-actions">
                <Button busy={move.isPending} onClick={() => step('up')}>
                  Move up
                </Button>
                <Button busy={move.isPending} onClick={() => step('down')}>
                  Move down
                </Button>
                {offered.markDone && (
                  <Button onClick={() => move.mutate({ state: 'done' }, { onSuccess: leave })}>
                    Mark done
                  </Button>
                )}
                {offered.resume && (
                  <Button
                    variant="primary"
                    busy={act.isPending}
                    onClick={() =>
                      act.mutate('resume', { onSuccess: () => announce(`${t.key} resumed.`) })
                    }
                  >
                    Resume
                  </Button>
                )}
                {offered.cancel && (
                  <Button variant="danger" onClick={() => act.mutate('cancel')}>
                    Cancel run
                  </Button>
                )}
                {offered.rerunKeep && t.plan_to_keep !== null && (
                  <Button
                    variant="primary"
                    busy={rerun.isPending}
                    onClick={() =>
                      rerun.mutate('keep', {
                        onSuccess: () =>
                          announce(
                            `${t.key} re-run with the plan from run ${t.plan_to_keep?.run ?? ''}.`,
                          ),
                      })
                    }
                  >
                    Re-run with this plan
                  </Button>
                )}
                {offered.rerun && (
                  <Button
                    {...(offered.rerunKeep ? {} : { variant: 'primary' as const })}
                    busy={rerun.isPending}
                    onClick={() =>
                      rerun.mutate('again', {
                        onSuccess: () => announce(`${t.key} re-run; the planner plans again.`),
                      })
                    }
                  >
                    Re-run and plan again
                  </Button>
                )}
              </div>
              <Notice className="announce">{message}</Notice>
              <Notice tone="danger" className="announce" ref={problemBox} tabIndex={-1}>
                {problem?.text}
              </Notice>
              <Tabs label={`${t.key} sections`} items={items(t)} value={tab} onChange={setTab} />
            </div>
          )
        }}
      </Loaded>
    </Dialog>
  )
}
