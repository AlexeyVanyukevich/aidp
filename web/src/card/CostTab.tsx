import { useQuery } from '@tanstack/react-query'
import { Badge } from '@zellige/react'
import { api } from '../api'
import { formatUsd } from '../board/columns'
import { Loaded } from '../Loaded'
import type { CostLine, PlanData, TaskView } from '../types'
import { formatPercent, formatTokens } from './format'

function Cells({ line }: { line: CostLine }) {
  return (
    <>
      <td>{formatTokens(line.usage.input)}</td>
      <td>{formatTokens(line.usage.output)}</td>
      <td>{formatTokens(line.usage.cacheRead)}</td>
      <td>{formatTokens(line.usage.cacheWrite)}</td>
      <td>{formatUsd(line.usd)}</td>
    </>
  )
}
const HEAD = (
  <>
    <th scope="col">In</th>
    <th scope="col">Out</th>
    <th scope="col">Cache read</th>
    <th scope="col">Cache write</th>
    <th scope="col">USD</th>
  </>
)

export function CostTab({ task }: { task: TaskView }) {
  const costs = useQuery({ queryKey: ['costs', task.id], queryFn: () => api.costs(task.id) })
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  return (
    <Loaded query={costs} failure="The costs could not be loaded.">
      {(c) => {
        const plan = runs.data?.[0]?.artifacts.filter((a) => a.kind === 'plan').at(-1)?.data as
          PlanData | undefined
        const estimate = plan?.steps.reduce((sum, s) => sum + (s.estimate_usd ?? 0), 0)
        return (
          <div className="cost-tab">
            <p className="total">
              <strong>Total {formatUsd(c.totals.usd)}</strong> · cache hit ratio{' '}
              {formatPercent(c.cacheHitRatio)}
              {estimate !== undefined && estimate > 0 && (
                <> · plan estimate {formatUsd(estimate)}</>
              )}
            </p>
            {c.missingPrices.length > 0 && (
              <p>
                No price for {c.missingPrices.join(', ')}; their tokens count as $0. Add one with{' '}
                <code>./run price:set &lt;model&gt; …</code>
              </p>
            )}
            <table>
              <caption>By phase</caption>
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  {HEAD}
                  <th scope="col">Claude Code says</th>
                </tr>
              </thead>
              <tbody>
                {c.byPhase.map((p) => (
                  <tr key={p.phaseId}>
                    <th scope="row">
                      {p.name} {p.attempt}
                      {/* A message cut off when its process stopped counts as at least what
                          its start said: the counters are a floor. */}
                      {p.cut && <span className="muted"> · at least</span>}
                    </th>
                    <Cells line={p} />
                    <td>
                      {p.reportedUsd === null ? '—' : formatUsd(p.reportedUsd)}
                      {p.interrupted && (
                        <p className="muted">
                          Not compared: a process of this phase was stopped, and Claude Code’s own
                          figure misses part of it.
                        </p>
                      )}
                      {p.flagged && (
                        <>
                          {' '}
                          <Badge tone="warning">off by {formatPercent(p.drift)}</Badge>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>By agent</caption>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {HEAD}
                </tr>
              </thead>
              <tbody>
                {c.byAgent.map((a) => (
                  <tr key={a.agent}>
                    <th scope="row">{a.agent}</th>
                    <Cells line={a} />
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>By model</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  {HEAD}
                </tr>
              </thead>
              <tbody>
                {c.byModel.map((m) => (
                  <tr key={m.model}>
                    <th scope="row">{m.model}</th>
                    <Cells line={m} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }}
    </Loaded>
  )
}
