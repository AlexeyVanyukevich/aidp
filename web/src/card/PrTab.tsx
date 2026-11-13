import { useId } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge, Empty, Loading } from '@zellige/react'
import { api } from '../api'
import { Loaded } from '../Loaded'
import { isConflict } from '../errors'
import { decisionHelp, NO_HELP } from './approvals'
import { prStatus, decisionsFor } from './blocks'
import { decisionMode, decisionRenderers, HelpButtons, HelpResults } from './HelpPanel'
import { ownerSentence } from './lint'
import { latestDeliveryRun } from './timeline'
import type { ReportData, TaskView } from '../types'

const VERDICT_TONE = {
  pass: 'success',
  fail: 'danger',
  owner: 'warning',
  withdrawn: 'neutral',
} as const

export function PrTab({ task, onProblem }: { task: TaskView; onProblem: (text: string) => void }) {
  const client = useQueryClient()
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  const run = latestDeliveryRun(runs.data ?? [])
  const files = useQuery({
    queryKey: ['pr-files', run?.id],
    queryFn: () => api.prFiles(run!.id),
    enabled: run?.pr_number != null,
  })
  const filesId = useId()
  const offered = decisionsFor(task.state, task.block, 0, task.has_pull_request).includes(
    'pull_request',
  )
  const helps = useQuery({
    queryKey: ['helps', task.id],
    queryFn: () => api.helps(task.id),
    enabled: offered,
  })
  const ask = useMutation({
    mutationFn: () => api.askDecisionHelp(task.id, 'pull_request', 'code_review'),
    onError: (error) =>
      onProblem(
        isConflict(error)
          ? 'This card changed meanwhile; its latest state is shown.'
          : 'That did not work. Try again.',
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ['helps', task.id] }),
  })
  const review = decisionMode(
    'code_review',
    'Review pull request',
    decisionHelp(helps.data ?? [], 'pull_request').code_review ?? NO_HELP,
  )
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) => {
        const latest = latestDeliveryRun(list)
        if (latest === undefined || latest.pr_url === null)
          return task.state === 'done' ? (
            <Empty title="Closed without a pull request." />
          ) : (
            <Empty title="No pull request yet">One opens when every criterion passes.</Empty>
          )
        const report = latest.artifacts.filter((a) => a.kind === 'verify_report').at(-1)?.data as
          ReportData | undefined
        const owned = ownerSentence(
          report?.criteria.filter((c) => c.status === 'owner').map((c) => c.id) ?? [],
        )
        return (
          <div className="pr-tab">
            <p>
              <a href={latest.pr_url} target="_blank" rel="noreferrer">
                Pull request #{latest.pr_number}
                <span className="zl-visually-hidden"> (opens in a new tab)</span>
              </a>{' '}
              on <code>{latest.branch}</code> · {prStatus(task.state, latest.failure_reason)}
            </p>
            {offered && (
              <>
                <div className="help-buttons">
                  <HelpButtons modes={[review]} onAsk={() => ask.mutate()} />
                </div>
                <HelpResults modes={[review]} level={3} renderers={decisionRenderers(null)} />
              </>
            )}
            <section aria-labelledby={filesId}>
              <h3 id={filesId}>Files changed</h3>
              {files.isError || files.data?.files === null ? (
                <p>GitHub did not list the files; they are on the pull request.</p>
              ) : files.data === undefined ? (
                <Loading />
              ) : (
                <ul>
                  {files.data.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> <Badge tone="success">+{f.additions}</Badge>{' '}
                      <Badge tone="danger">−{f.deletions}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {owned !== undefined && <p>{owned}</p>}
            {report?.withdrawn !== undefined && report.withdrawn.length > 0 && (
              <>
                <p>Withdrawn by the owner at the plan gate:</p>
                <ul>
                  {report.withdrawn.map((w) => (
                    <li key={w.criterion}>
                      {w.criterion} — {w.answer}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report && (
              <table>
                <caption>Verify report</caption>
                <thead>
                  <tr>
                    <th scope="col">Criterion</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {report.criteria.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">{c.id}</th>
                      <td>
                        <Badge tone={VERDICT_TONE[c.status]}>{c.status}</Badge>
                      </td>
                      <td>{c.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      }}
    </Loaded>
  )
}
