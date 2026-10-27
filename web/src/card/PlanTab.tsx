import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Empty } from '@zellige/react'
import { api } from '../api'
import { formatUsd } from '../board/columns'
import { Loaded } from '../Loaded'
import type { PlanData, TaskView } from '../types'

export function PlanTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  const stepsId = useId()
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) => {
        const artifact = list[0]?.artifacts.filter((a) => a.kind === 'plan').at(-1)
        if (artifact === undefined)
          return (
            <Empty title="No plan yet">
              The plan appears here once a run’s Plan phase saves one.
            </Empty>
          )
        const plan = artifact.data as PlanData
        return (
          <div className="plan-tab">
            {task.approval?.kind === 'plan' && task.approval.status === 'open' && (
              <p>
                <strong>Waiting for your approval in Approvals.</strong>
              </p>
            )}
            {artifact.copied_from_run !== null && (
              <p className="muted">Kept from run {artifact.copied_from_run}</p>
            )}
            <p>{plan.summary}</p>
            <p className="muted">Confidence: {plan.confidence}</p>
            <section aria-labelledby={stepsId}>
              <h3 id={stepsId}>Steps</h3>
              <ol>
                {plan.steps.map((step, i) => (
                  <li key={i}>
                    <strong>{step.title}</strong> <Badge>{step.requirements.join(', ')}</Badge>
                    <div className="files">
                      {step.files.map((f) => (
                        <code key={f}>{f}</code>
                      ))}
                    </div>
                    {step.estimate_usd !== undefined && (
                      <span className="muted">est. {formatUsd(step.estimate_usd)}</span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
            <table>
              <caption>Checks</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Check</th>
                </tr>
              </thead>
              <tbody>
                {plan.checks.map((c) => (
                  <tr key={c.criterion}>
                    <th scope="row">{c.criterion}</th>
                    <td>{c.how}</td>
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
