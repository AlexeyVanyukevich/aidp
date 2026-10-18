import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Notice, Select, Textarea } from '@zellige/react'
import { api, ApiError } from '../api'
import { isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type { SpecView, TaskView } from '../types'
import { editable, lintMessage, lintSummary, savedMessage, SPEC_TEMPLATE } from './lint'

export function SpecTab({ task, onFrozen }: { task: TaskView; onFrozen: () => void }) {
  const specs = useQuery({ queryKey: ['specs', task.id], queryFn: () => api.specs(task.id) })
  return (
    <Loaded query={specs} failure="The spec could not be loaded.">
      {(list) => <SpecEditor task={task} specs={list} onFrozen={onFrozen} />}
    </Loaded>
  )
}

function SpecEditor({
  task,
  specs,
  onFrozen,
}: {
  task: TaskView
  specs: SpecView[]
  /** Approving freezes the spec and both buttons go; the card moves focus before they do. */
  onFrozen: () => void
}) {
  const client = useQueryClient()
  const lintId = useId()
  const [selected, setSelected] = useState<string | undefined>()
  const [draft, setDraft] = useState<string | undefined>()
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<{ text: string } | undefined>()
  const problemBox = useRef<HTMLDivElement>(null)
  // A new object each time, so the same failure twice still moves focus to the notice.
  useEffect(() => {
    if (problem) problemBox.current?.focus()
  }, [problem])

  const latest = specs[0]
  const shown = specs.find((s) => s.id === selected) ?? latest
  const show = (id: string) => {
    setSelected(id)
    setDraft(undefined)
  }

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['specs', task.id] }),
      client.invalidateQueries({ queryKey: ['task', task.id] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const fail = (action: 'save' | 'approve') => (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? 'This spec changed elsewhere; the latest version is shown.'
        : error instanceof ApiError && error.code === 'validation_error'
          ? action === 'approve'
            ? 'The spec cannot be approved until it lints clean and has no open questions.'
            : 'The spec could not be saved. Check it and try again.'
          : 'That did not work. Try again.',
    })
  const save = useMutation({
    mutationFn: () => api.saveSpec(task.id, draft ?? shown?.body_md ?? SPEC_TEMPLATE),
    onMutate: () => setProblem(undefined),
    onSuccess: (spec) => {
      show(spec.id)
      setMessage(savedMessage(spec))
    },
    onError: fail('save'),
    onSettled: refresh,
  })
  const approve = useMutation({
    mutationFn: (id: string) => api.approve(id),
    onMutate: () => setProblem(undefined),
    onSuccess: onFrozen,
    onError: fail('approve'),
    onSettled: refresh,
  })

  const canEdit = editable(task.state)
  const text = draft ?? shown?.body_md ?? SPEC_TEMPLATE
  const canApprove =
    shown !== undefined &&
    shown.id === latest?.id &&
    shown.status === 'draft' &&
    shown.lint.approvable &&
    draft === undefined

  return (
    <div className="spec-tab">
      {specs.length > 0 && (
        <Field label="Version">
          <Select value={shown?.id} onChange={(e) => show(e.target.value)}>
            {specs.map((s) => (
              <option key={s.id} value={s.id}>
                v{s.version} · {s.status}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field
        label="Spec"
        hint="Markdown. Give each requirement an id such as R1, and each criterion its own id and the requirements it checks: AC1 (R1)."
      >
        <Textarea
          className="spec-text"
          value={text}
          readOnly={!canEdit}
          rows={22}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Field>
      {shown && draft === undefined && (
        <section aria-labelledby={lintId} className="lint">
          <h3 id={lintId}>Lint</h3>
          {shown.lint.approvable ? (
            <p>{lintSummary(shown.lint)}</p>
          ) : (
            <ul>
              {shown.lint.findings.map((f, i) => (
                <li key={i}>{lintMessage(f)}</li>
              ))}
              {shown.lint.open_questions.map((q) => (
                <li key={q}>Open question: {q}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Notice className="announce">{message}</Notice>
      <Notice tone="danger" className="announce" ref={problemBox} tabIndex={-1}>
        {problem?.text}
      </Notice>
      {canEdit ? (
        <div className="actions">
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            Save as v{(latest?.version ?? 0) + 1}
          </Button>
          <Button
            variant="primary"
            busy={approve.isPending}
            disabled={!canApprove}
            onClick={() => shown && approve.mutate(shown.id)}
          >
            Approve
          </Button>
          {!canApprove && (
            <span className="muted">
              Approve needs the latest version saved, linting clean, with no open questions.
            </span>
          )}
        </div>
      ) : (
        shown?.status === 'approved' && (
          <p className="muted">Approved v{shown.version}; frozen for its runs.</p>
        )
      )}
    </div>
  )
}
