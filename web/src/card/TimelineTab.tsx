import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Empty, Field, Select } from '@zellige/react'
import { api } from '../api'
import { Loaded } from '../Loaded'
import type { EventView, RunView, TaskView } from '../types'
import { formatDuration, formatTokens } from './format'
import { stepLabel, timelineModel, type Band } from './timeline'

const tokensOf = (event: EventView) =>
  event.usage.input + event.usage.output + event.usage.cache_read + event.usage.cache_write

function Step({ event }: { event: EventView }) {
  const tokens = tokensOf(event)
  const nested = event.type === 'subagent_start' || event.type === 'subagent_stop'
  return (
    <li className={nested ? 'step step-nested' : 'step'}>
      <details>
        <summary>
          <span>{stepLabel(event)}</span>
          {tokens > 0 && <span className="muted"> · {formatTokens(tokens)} tokens</span>}
          {event.duration_ms !== null && (
            <span className="muted"> · {formatDuration(event.duration_ms)}</span>
          )}
        </summary>
        <div className="step-detail">
          <p className="muted">
            in {event.usage.input} · out {event.usage.output} · cache read {event.usage.cache_read}{' '}
            · cache write {event.usage.cache_write}
          </p>
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      </details>
    </li>
  )
}

function BandView({ band }: { band: Band }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="band">
      <h3 id={id}>
        {band.phase.name} · attempt {band.phase.attempt} · {band.phase.agent} · {band.phase.status}{' '}
        · {formatTokens(band.tokens)} tokens
      </h3>
      {band.phase.summary_md && <p className="summary">{band.phase.summary_md}</p>}
      <ol>
        {band.entries.map((e) =>
          'kind' in e ? (
            <li key={e.id} className="step step-paused">
              Paused for {formatDuration(e.ms)}
            </li>
          ) : (
            <Step key={e.id} event={e} />
          ),
        )}
      </ol>
    </section>
  )
}

function RunTimeline({ runs }: { runs: RunView[] }) {
  const [chosen, setChosen] = useState<string | undefined>()
  const looseId = useId()
  const run = runs.find((r) => r.id === chosen) ?? runs[0]!
  const events = useQuery({ queryKey: ['events', run.id], queryFn: () => api.events(run.id) })
  return (
    <div className="timeline">
      {runs.length > 1 && (
        <Field label="Run">
          <Select value={run.id} onChange={(e) => setChosen(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                Run {r.number} · {r.status}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {run.failure_reason && (
        <p className="failure">
          <strong>Failed:</strong> {run.failure_reason}
        </p>
      )}
      <Loaded query={events} failure="The run’s steps could not be loaded.">
        {(list) => {
          const model = timelineModel(run.phases, list)
          return (
            <>
              {model.bands.map((band) => (
                <BandView key={band.phase.id} band={band} />
              ))}
              {model.loose.length > 0 && (
                <section aria-labelledby={looseId} className="band">
                  <h3 id={looseId}>Runner</h3>
                  <ol>
                    {model.loose.map((e) => (
                      <Step key={e.id} event={e} />
                    ))}
                  </ol>
                </section>
              )}
            </>
          )
        }}
      </Loaded>
    </div>
  )
}

export function TimelineTab({ task }: { task: TaskView }) {
  const runs = useQuery({ queryKey: ['runs', task.id], queryFn: () => api.runs(task.id) })
  return (
    <Loaded query={runs} failure="The runs could not be loaded.">
      {(list) =>
        list.length === 0 ? (
          <Empty title="No run yet">A run starts when the spec is approved.</Empty>
        ) : (
          <RunTimeline runs={list} />
        )
      }
    </Loaded>
  )
}
