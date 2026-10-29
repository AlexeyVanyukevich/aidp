import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Empty, Loading } from '@zellige/react'
import { api } from '../api'
import { Loaded } from '../Loaded'
import { prStatus } from './blocks'
import { ownerSentence } from './lint'
import type { ReportData, TaskView } from '../types'

const VERDICT_TONE = { pass: 'success', fail: 'danger', owner: 'warning' } as const

export function PrTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  const run = runs.data?.[0]
  const files = useQuery({
    queryKey: ['pr-files', run?.id],
    queryFn: () => api.prFiles(run!.id),
    enabled: run?.pr_number != null,
  })
  const filesId = useId()
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) => {
        const latest = list[0]
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
