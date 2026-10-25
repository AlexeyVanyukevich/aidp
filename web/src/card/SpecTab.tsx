import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Notice, Select, Textarea } from '@zellige/react'
import { api, ApiError } from '../api'
import { invalidField, isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type { SpecView, TaskView } from '../types'
import {
  editable,
  lintMessage,
  lintSummary,
  savedMessage,
  SPEC_TEMPLATE,
  specControls,
} from './lint'

const NO_DESCRIPTION = 'Write a description first; the spec-writer drafts from it.'
const NO_NOTE = 'Say what to change.'

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
  /**
   * Approve, Draft spec and Redraft change the card's state and their buttons go; the card
   * moves focus before they do.
   */
  onFrozen: () => void
}) {
  const client = useQueryClient()
  const lintId = useId()
  const controls = specControls(task.state)
  const [selected, setSelected] = useState<string | undefined>()
  const [draft, setDraft] = useState<string | undefined>()
  const [description, setDescription] = useState<string | undefined>()
  const [descriptionMissing, setDescriptionMissing] = useState(false)
  const [note, setNote] = useState('')
  const [noteMissing, setNoteMissing] = useState(false)
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<{ text: string } | undefined>()
  const problemBox = useRef<HTMLDivElement>(null)
  const descriptionField = useRef<HTMLTextAreaElement>(null)
  const noteField = useRef<HTMLTextAreaElement>(null)
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
  const describedAs = description ?? task.description_md

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['specs', task.id] }),
      client.invalidateQueries({ queryKey: ['task', task.id] }),
      client.invalidateQueries({ queryKey: ['board'] }),
    ])
  const fail = (action: 'save' | 'approve' | 'describe' | 'draft') => (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? action === 'describe' || action === 'draft'
          ? 'This card changed meanwhile; its latest state is shown.'
          : 'This spec changed elsewhere; the latest version is shown.'
        : error instanceof ApiError && error.code === 'validation_error' && action !== 'draft'
          ? action === 'approve'
            ? 'The spec cannot be approved until it lints clean and has no open questions.'
            : 'The spec could not be saved. Check it and try again.'
          : action === 'describe'
            ? 'The description was not saved. Try again.'
            : 'That did not work. Try again.',
    })
  /** The field's error is on the page before focus arrives, so it is read with the field. */
  const markMissing = (which: 'description' | 'note') => {
    flushSync(() => (which === 'description' ? setDescriptionMissing : setNoteMissing)(true))
    ;(which === 'description' ? descriptionField : noteField).current?.focus()
  }

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
  const describe = useMutation({
    mutationFn: () => api.patchTask(task.id, { description_md: describedAs }),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setDescription(undefined)
      setMessage('Description saved.')
    },
    onError: fail('describe'),
    onSettled: refresh,
  })
  // An edited description is saved first: the spec-writer drafts from what the owner sees.
  const draftSpec = useMutation({
    mutationFn: async () => {
      if (description !== undefined) await api.patchTask(task.id, { description_md: description })
      return api.action(task.id, 'draft-spec')
    },
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setDescription(undefined)
      onFrozen()
    },
    onError: (error) => {
      if (invalidField(error) === 'description_md') markMissing('description')
      else fail('draft')(error)
    },
    onSettled: refresh,
  })
  const redraft = useMutation({
    mutationFn: () => api.redraft(task.id, note.trim()),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setNote('')
      onFrozen()
    },
    onError: (error) => {
      if (invalidField(error) === 'note') markMissing('note')
      else fail('draft')(error)
    },
    onSettled: refresh,
  })

  const startDraft = () => {
    if (describedAs.trim() === '') markMissing('description')
    else draftSpec.mutate()
  }
  const submitRedraft = (event: FormEvent) => {
    event.preventDefault()
    if (note.trim() === '') markMissing('note')
    else redraft.mutate()
  }

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
      <Field
        label="Description"
        hint="What the task is for. The spec-writer drafts from it."
        error={descriptionMissing ? NO_DESCRIPTION : undefined}
      >
        <Textarea
          ref={descriptionField}
          value={describedAs}
          readOnly={!controls.describe}
          rows={4}
          onChange={(e) => {
            setDescription(e.target.value)
            if (descriptionMissing) setDescriptionMissing(false)
          }}
        />
      </Field>
      {controls.describe && (
        <div className="actions">
          <Button busy={describe.isPending} onClick={() => describe.mutate()}>
            Save description
          </Button>
        </div>
      )}
      {controls.drafting && (
        <p className="muted">
          The spec-writer is drafting. The editor opens again when it finishes.
        </p>
      )}
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
          {controls.draft && (
            <Button busy={draftSpec.isPending} onClick={startDraft}>
              Draft spec
            </Button>
          )}
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
      {controls.redraft && (
        <form className="redraft" onSubmit={submitRedraft}>
          <Field
            label="What to change"
            hint="The spec-writer reads this with the current version."
            error={noteMissing ? NO_NOTE : undefined}
          >
            <Textarea
              ref={noteField}
              rows={3}
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
                if (noteMissing) setNoteMissing(false)
              }}
            />
          </Field>
          <Button type="submit" busy={redraft.isPending}>
            Redraft
          </Button>
        </form>
      )}
    </div>
  )
}
