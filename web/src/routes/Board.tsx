import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Outlet, useLocation, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Notice } from '@zellige/react'
import { api } from '../api'
import { columns, dropPatch, LABELS, MAIN_COLUMNS, SIDE_COLUMNS } from '../board/columns'
import { cardDomId, TaskCardView } from '../board/TaskCardView'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import { usePage } from '../page'
import type { TaskCard, TaskState } from '../types'
import '../board/board.css'

const allowDrop = (event: DragEvent) => event.preventDefault()

export function Board() {
  const { key = '' } = useParams()
  const client = useQueryClient()
  const location = useLocation()
  const board = useQuery({ queryKey: ['board', key], queryFn: () => api.board(key) })
  const name = board.data ? `${board.data.project.key} · ${board.data.project.name}` : key
  const heading = usePage(board.data ? name : undefined, `board:${key}`)
  const [dragged, setDragged] = useState<TaskCard | undefined>()
  const [message, setMessage] = useState('')
  const [title, setTitle] = useState('')
  const [titleMissing, setTitleMissing] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)

  // Closing a card returns focus to its link. The dialog leaves focus on the page instead when
  // the link it came from was replaced — the card changed columns while open — or the card was
  // opened from its address; then the card's current link takes it. This runs after the
  // dialog's own cleanup, so it sees where that left focus.
  const openCard = useRef<string | undefined>(undefined)
  useEffect(() => {
    const open = /^\/p\/[^/]+\/([^/]+)$/.exec(location.pathname)?.[1]
    const lost = document.activeElement === null || document.activeElement === document.body
    if (open === undefined && openCard.current !== undefined && lost)
      document.getElementById(cardDomId(openCard.current))?.focus()
    openCard.current = open
  }, [location.pathname])

  const refresh = () => client.invalidateQueries({ queryKey: ['board', key] })
  const move = useMutation({
    mutationFn: ({
      card,
      body,
    }: {
      card: TaskCard
      body: { position: number } | { state: 'done' }
    }) => api.patchTask(card.id, body),
    onSuccess: (_task, { card, body }) =>
      setMessage('state' in body ? `${card.key} moved to Done.` : `${card.key} moved.`),
    onError: (error) =>
      setMessage(
        isConflict(error)
          ? 'That card moved meanwhile; the board is up to date again.'
          : 'The board could not save that move. Try again.',
      ),
    onSettled: refresh,
  })
  const create = useMutation({
    mutationFn: () => api.createTask(key, { title: title.trim() }),
    // The refetch is not awaited: Add task must be free again by the time the add is announced,
    // or the next Enter — through a busy button's cancelled click — is silently dropped.
    onSuccess: (task) => {
      setTitle('')
      setMessage(`${task.key} added to Backlog.`)
      void refresh()
    },
    onError: () => setMessage('The task could not be added. Try again.'),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const missing = title.trim() === ''
    setTitleMissing(missing)
    if (missing) titleInput.current?.focus()
    else create.mutate()
  }

  return (
    <main className="board-page">
      <div className="board-head">
        <h1 ref={heading} tabIndex={-1}>
          {name}
        </h1>
        <form onSubmit={submit} className="new-task">
          <Field label="New task title" error={titleMissing ? 'Enter a title.' : undefined}>
            <Input ref={titleInput} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Button type="submit" busy={create.isPending}>
            Add task
          </Button>
        </form>
      </div>
      <Notice className="announce">{message}</Notice>
      <Loaded query={board} failure="This board could not be loaded.">
        {(data) => {
          const grouped = columns(data.tasks)
          const drop = (target: TaskState, before?: TaskCard) => (event: DragEvent) => {
            event.preventDefault()
            event.stopPropagation()
            if (dragged === undefined) return
            const body = dropPatch(dragged, target, before, grouped[target])
            setDragged(undefined)
            if (body === null)
              setMessage(
                'Only a card in Review can be dragged, to Done. Other moves are buttons on the card.',
              )
            else move.mutate({ card: dragged, body })
          }
          const column = (state: TaskState) => (
            <section key={state} aria-label={LABELS[state]} className="column">
              <h2>
                {LABELS[state]}{' '}
                <span className="count">
                  {grouped[state].length}
                  <span className="zl-visually-hidden">
                    {grouped[state].length === 1 ? ' card' : ' cards'}
                  </span>
                </span>
              </h2>
              {/* A container with no role takes the column's drops: dropping is for the mouse,
                  and Move up, Move down and Mark done make the same moves. A drop on a card
                  lands before it, through the card's own link. */}
              <div className="drop-zone" onDragOver={allowDrop} onDrop={drop(state)}>
                <ol className="cards">
                  {grouped[state].map((card) => (
                    <li key={card.id}>
                      <TaskCardView
                        card={card}
                        projectKey={key}
                        onDragStart={() => setDragged(card)}
                        onDragOver={allowDrop}
                        onDrop={drop(state, card)}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          )
          return (
            <>
              <div className="columns">{MAIN_COLUMNS.map(column)}</div>
              <details className="side" open={SIDE_COLUMNS.some((s) => grouped[s].length > 0)}>
                <summary>Blocked and failed</summary>
                <div className="columns">{SIDE_COLUMNS.map(column)}</div>
              </details>
            </>
          )
        }}
      </Loaded>
      <Outlet />
    </main>
  )
}
