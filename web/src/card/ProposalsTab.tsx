import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Empty, Markdown } from '@zellige/react'
import { api, ApiError } from '../api'
import { Loaded } from '../Loaded'
import type { HelpView, ProposalOutcome, ProposalView, TaskView } from '../types'

/** The query key of a task's proposals: under `runs`, which every run event refreshes. */
export const proposalsKey = (taskId: string) => ['runs', taskId, 'proposals'] as const

const runName = (run: ProposalView['run']) =>
  run.kind === 'spec' ? `Draft ${run.number}` : `Run ${run.number}`

export const outcomeText = (outcome: ProposalOutcome | null): string =>
  outcome === null
    ? 'open'
    : outcome === 'file'
      ? 'filed'
      : outcome === 'workaround'
        ? 'filed with workaround'
        : outcome === 'wait'
          ? 'waiting'
          : 'dismissed'

/** The label of a settle button, which is also its accessible name. */
export function variantLabel(variant: ProposalOutcome, project: string): string {
  if (variant === 'file') return `File in ${project}`
  if (variant === 'workaround') return `Use the workaround and file in ${project}`
  if (variant === 'wait') return 'Wait for it'
  return 'Dismiss'
}

/** What the status region says once a proposal is settled. */
export function settledText(proposal: ProposalView): string {
  const key = proposal.filed_task?.key ?? ''
  if (proposal.outcome === 'file') return `Filed ${key}: ${proposal.title}.`
  if (proposal.outcome === 'workaround')
    return `Filed ${key} with the workaround: ${proposal.title}.`
  return `Dismissed: ${proposal.title}.`
}

/** What the problem region says when a settle fails. */
export function settleProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    const reason = error.details?.reason
    if (reason === 'settled')
      return 'This proposal was settled meanwhile; its latest state is shown.'
    if (reason === 'duplicate')
      return `${String(error.details?.key)} (${String(error.details?.state)}) already has this title. Dismiss the proposal, or file the task by hand under another title.`
  }
  return 'That did not work. Try again.'
}

/** The proposals whose ids were not seen before; the first load sees all of them. */
export function arrivals(seen: Set<string> | undefined, list: ProposalView[]): ProposalView[] {
  if (seen === undefined) return []
  return list.filter((proposal) => !seen.has(proposal.id))
}

/** The help of one proposal: busy while in flight, its latest result, and a failure. */
export function proposalHelp(helps: HelpView[], proposalId: string) {
  const mine = helps
    .filter((help) => help.decision === 'proposal' && help.subject?.proposal_id === proposalId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const latest = mine[0]
  const done = mine.find((help) => help.status === 'succeeded')
  return {
    busy: latest?.status === 'queued' || latest?.status === 'running',
    result: done?.result?.mode === 'advise' ? done.result : undefined,
    failure: latest?.status === 'failed' ? (latest.reason ?? 'the helper failed') : undefined,
  }
}

/** What the status region says of a proposal's help that ended; null for a stopped one. */
export function proposalHelpAnnouncement(help: HelpView, title: string): string | null {
  if (help.status === 'failed')
    return `No suggested settlement for "${title}": ${help.reason ?? 'the helper failed'}.`
  if (help.status === 'succeeded') return `Suggested settlement ready for "${title}".`
  return null
}

function ProposalCard({
  proposal,
  helps,
  busyVariant,
  headingRef,
  onSettle,
  onAsk,
}: {
  proposal: ProposalView
  helps: HelpView[]
  busyVariant: ProposalOutcome | undefined
  headingRef: (node: HTMLHeadingElement | null) => void
  onSettle: (variant: ProposalOutcome) => void
  onAsk: () => void
}) {
  const id = useId()
  const help = proposalHelp(helps, proposal.id)
  const open = proposal.outcome === null
  const suggested = help.result?.variant
  return (
    <article aria-labelledby={`${id}-title`} className="zl-card proposal">
      <h4 id={`${id}-title`} ref={headingRef} tabIndex={-1}>
        {proposal.title}
      </h4>
      <p className="proposal-line">
        <Badge>{proposal.related ? 'related' : 'unrelated'}</Badge>{' '}
        <Badge tone={open ? 'warning' : proposal.outcome === 'dismiss' ? 'neutral' : 'success'}>
          {outcomeText(proposal.outcome)}
        </Badge>{' '}
        <span>
          To {proposal.project} · proposed in {proposal.phase}
        </span>
      </p>
      {proposal.filed_task !== null && (
        <p>
          <Link to={`/p/${proposal.filed_task.key.replace(/-\d+$/, '')}/${proposal.filed_task.id}`}>
            {proposal.filed_task.key}
          </Link>
        </p>
      )}
      {proposal.bearing_md !== null && proposal.bearing_md.trim() !== '' && (
        <div>
          <p>
            <strong>
              {proposal.related ? 'How it bears on this task:' : 'Why it came up here:'}
            </strong>
          </p>
          <Markdown source={proposal.bearing_md} headingLevel={5} />
        </div>
      )}
      <details>
        <summary>Description</summary>
        <Markdown source={proposal.description_md} headingLevel={5} />
      </details>
      {proposal.workaround_md !== null && (
        <details>
          <summary>Proposed workaround</summary>
          <Markdown source={proposal.workaround_md} headingLevel={5} />
        </details>
      )}
      {open && (
        <div className="card-actions">
          {proposal.offered.map((variant) => (
            <Button
              key={variant}
              {...(variant === 'file' ? { variant: 'primary' as const } : {})}
              busy={busyVariant === variant}
              aria-describedby={`${id}-title`}
              onClick={() => {
                if (busyVariant === undefined) onSettle(variant)
              }}
            >
              {variantLabel(variant, proposal.project)}
            </Button>
          ))}
          <Button
            busy={help.busy}
            aria-describedby={`${id}-title`}
            onClick={() => {
              if (!help.busy) onAsk()
            }}
          >
            Suggest how to settle
          </Button>
        </div>
      )}
      {open && help.failure !== undefined && (
        <p className="help-failure">
          No suggested settlement for &ldquo;{proposal.title}&rdquo;: {help.failure}
        </p>
      )}
      {open && help.result !== undefined && suggested !== undefined && (
        <section className="help-result" aria-labelledby={`${id}-help`}>
          <h5 id={`${id}-help`}>Suggested settlement</h5>
          <p>
            <strong>Suggested:</strong> {variantLabel(suggested, proposal.project)}
          </p>
          <p>
            <strong>Why:</strong> {help.result.reasoning}
          </p>
          <p>
            <strong>Unsure about:</strong> {help.result.unsure}
          </p>
        </section>
      )}
    </article>
  )
}

/**
 * The card's proposals, newest run first. Settling removes the buttons that did it, so focus
 * moves to the proposal's heading, and the card's status region says what happened.
 */
export function ProposalsTab({
  task,
  onSettled,
  onProblem,
}: {
  task: TaskView
  onSettled: (message: string) => void
  onProblem: (text: string) => void
}) {
  const client = useQueryClient()
  const proposals = useQuery({
    queryKey: proposalsKey(task.id),
    queryFn: () => api.proposals(task.id),
  })
  const helps = useQuery({ queryKey: ['helps', task.id], queryFn: () => api.helps(task.id) })
  const [settling, setSettling] = useState<{ id: string; variant: ProposalOutcome } | undefined>()
  const headings = useRef(new Map<string, HTMLHeadingElement>())
  const focusAfter = useRef<string | undefined>(undefined)

  useEffect(() => {
    const id = focusAfter.current
    if (id === undefined) return
    const settled = proposals.data?.find((p) => p.id === id)
    if (settled === undefined || settled.outcome === null) return
    headings.current.get(id)?.focus()
    focusAfter.current = undefined
  }, [proposals.data])

  const settle = useMutation({
    mutationFn: ({ id, variant }: { id: string; variant: ProposalOutcome }) =>
      api.settleProposal(task.id, id, variant),
    onMutate: (vars) => setSettling(vars),
    onSuccess: (proposal) => {
      client.setQueryData<ProposalView[]>(proposalsKey(task.id), (list) =>
        list?.map((p) => (p.id === proposal.id ? proposal : p)),
      )
      focusAfter.current = proposal.id
      onSettled(settledText(proposal))
    },
    onError: (error) => onProblem(settleProblem(error)),
    onSettled: () => {
      setSettling(undefined)
      return Promise.all([
        client.invalidateQueries({ queryKey: proposalsKey(task.id) }),
        client.invalidateQueries({ queryKey: ['task', task.id] }),
        client.invalidateQueries({ queryKey: ['board'] }),
        client.invalidateQueries({ queryKey: ['helps', task.id] }),
      ])
    },
  })
  const ask = useMutation({
    mutationFn: (id: string) => api.askProposalHelp(task.id, id),
    onError: () => onProblem('The help was not asked. Try again.'),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })

  return (
    <Loaded query={proposals} failure="The proposals could not be loaded.">
      {(list) => {
        if (list.length === 0)
          return (
            <Empty title="No proposals">
              The agents of this task’s runs have proposed no tasks.
            </Empty>
          )
        const runs: { name: string; items: ProposalView[] }[] = []
        for (const proposal of list) {
          const name = runName(proposal.run)
          const last = runs.at(-1)
          if (last?.name === name) last.items.push(proposal)
          else runs.push({ name, items: [proposal] })
        }
        return (
          <div className="proposals-tab">
            {runs.map((run) => (
              <section key={run.name}>
                <h3>{run.name}</h3>
                {run.items.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    helps={helps.data ?? []}
                    busyVariant={settling?.id === proposal.id ? settling.variant : undefined}
                    headingRef={(node) => {
                      if (node === null) headings.current.delete(proposal.id)
                      else headings.current.set(proposal.id, node)
                    }}
                    onSettle={(variant) => settle.mutate({ id: proposal.id, variant })}
                    onAsk={() => ask.mutate(proposal.id)}
                  />
                ))}
              </section>
            ))}
          </div>
        )
      }}
    </Loaded>
  )
}
