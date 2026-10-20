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

  // The page behind a modal dialog is inert, its live region with it, so the card announces its
  // own changes of state — those its buttons made and those the runner made.
  const seen = useRef<TaskState | undefined>(undefined)
  useEffect(() => {
    if (task.data === undefined) return
    if (seen.current !== undefined && seen.current !== task.data.state)
      setMessage(`${task.data.key} is now in ${LABELS[task.data.state]}.`)
    seen.current = task.data.state
  }, [task.data])
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
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'rerun') => api.action(taskId, action),
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
            setMessage(text)
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
        {(t) => (
          <div className="card-body">
            <p className="state-line" ref={stateLine} tabIndex={-1}>
              {t.key} · {LABELS[t.state]}
            </p>
            <div className="card-actions">
              <Button busy={move.isPending} onClick={() => step('up')}>
                Move up
              </Button>
              <Button busy={move.isPending} onClick={() => step('down')}>
                Move down
              </Button>
              {t.state === 'review' && (
                <Button onClick={() => move.mutate({ state: 'done' }, { onSuccess: leave })}>
                  Mark done
                </Button>
              )}
              {(t.state === 'ready' || t.state === 'running') && (
                <Button variant="danger" onClick={() => act.mutate('cancel')}>
                  Cancel run
                </Button>
              )}
              {t.state === 'failed' && (
                <Button variant="primary" onClick={() => act.mutate('rerun')}>
                  Re-run
                </Button>
              )}
            </div>
            <Notice className="announce">{message}</Notice>
            <Notice tone="danger" className="announce" ref={problemBox} tabIndex={-1}>
              {problem?.text}
            </Notice>
            <Tabs label={`${t.key} sections`} items={items(t)} value={tab} onChange={setTab} />
          </div>
        )}
      </Loaded>
    </Dialog>
  )
}
