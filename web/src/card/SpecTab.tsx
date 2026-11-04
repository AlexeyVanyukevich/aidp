import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Markdown, Notice, Select, Textarea } from '@zellige/react'
import { api, ApiError } from '../api'
import { invalidField, isConflict } from '../errors'
import { Loaded } from '../Loaded'
import type { SpecView, TaskView } from '../types'
import {
  DRAFT_LOCK,
  editable,
  hasDraft as isDraft,
  lintMessage,
  lintSummary,
  savedMessage,
  SAVE_HINT,
  SPEC_TEMPLATE,
  specControls,
  VERSION_LOCK,
  viewButtons,
  viewHeading,
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
  const headingId = useId()
  const hintId = useId()
  const lockId = useId()
  const approveId = useId()
  const controls = specControls(task.state)
  const [selected, setSelected] = useState<string | undefined>()
  const [draft, setDraft] = useState<string | undefined>()
  const [editing, setEditing] = useState(false)
  // Where focus goes once the control is on the page; kept until it is.
  const pending = useRef<'edit' | 'write' | 'text' | undefined>(undefined)
  const setFocus = (target: 'edit' | 'write' | 'text') => {
    pending.current = target
  }
  /** A ref that takes focus when its control appears, if that is where focus was sent. */
  const focusOn = (target: 'edit' | 'write' | 'text') => (element: HTMLElement | null) => {
    if (element && pending.current === target) {
      pending.current = undefined
      element.focus()
    }
  }
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
    mutationFn: () => api.saveSpec(task.id, text),
    onMutate: () => setProblem(undefined),
    onSuccess: (spec) => {
      show(spec.id)
      setEditing(false)
      setFocus('edit')
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
  const baseline = shown?.body_md ?? SPEC_TEMPLATE
  const text = draft ?? baseline
  const changed = isDraft(draft, baseline)
  const open = editing && canEdit
  const buttons = viewButtons(task.state, shown !== undefined, changed)
  const canApprove =
    shown !== undefined &&
    shown.id === latest?.id &&
    shown.status === 'draft' &&
    shown.lint.approvable &&
    !changed
  /** Back to the formatted view; Preview keeps the draft, Discard drops it. */
  const leaveEditor = (keep: boolean) => {
    if (!keep) setDraft(undefined)
    setEditing(false)
    setFocus(shown !== undefined || (keep && changed) ? 'edit' : 'write')
  }
  const openEditor = () => {
    setEditing(true)
    setFocus('text')
  }

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
          The spec-writer is drafting. The spec can be edited again when it finishes.
        </p>
      )}
      {specs.length > 0 && (
        <Field label="Version" hint={changed ? VERSION_LOCK : undefined}>
          <Select value={shown?.id} disabled={changed} onChange={(e) => show(e.target.value)}>
            {specs.map((s) => (
              <option key={s.id} value={s.id}>
                v{s.version} · {s.status}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {open ? (
        <Field
          label="Spec"
          hint="Markdown. Give each requirement an id such as R1, and each criterion its own id and the requirements it checks: AC1 (R1)."
        >
          <Textarea
            ref={focusOn('text')}
            className="spec-text"
            value={text}
            rows={22}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
      ) : (
        <section aria-labelledby={headingId} className="spec-view">
          <h3 id={headingId}>
            {shown === undefined && !changed ? 'Spec' : viewHeading(shown, changed)}
          </h3>
          {shown === undefined && !changed ? (
            <p>No spec yet.</p>
          ) : (
            <Markdown source={text} headingLevel={4} />
          )}
        </section>
      )}
      {!open && changed && <p className="muted">Unsaved changes. Lint runs when you save.</p>}
      {!open && shown && !changed && task.state === 'spec_review' && (
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
      {open ? (
        <div className="actions">
          <Button
            busy={save.isPending}
            disabled={!changed}
            aria-describedby={changed ? undefined : hintId}
            onClick={() => save.mutate()}
          >
            Save as v{(latest?.version ?? 0) + 1}
          </Button>
          {!changed && (
            <span id={hintId} className="muted">
              {SAVE_HINT}
            </span>
          )}
          <Button onClick={() => leaveEditor(true)}>Preview</Button>
          <Button onClick={() => leaveEditor(false)}>Discard changes</Button>
        </div>
      ) : canEdit ? (
        <div className="actions">
          {buttons.edit && (
            <Button ref={focusOn('edit')} onClick={openEditor}>
              Edit
            </Button>
          )}
          {buttons.writeSpec && (
            <Button ref={focusOn('write')} onClick={openEditor}>
              Write spec
            </Button>
          )}
          {buttons.approve && (
            <Button
              variant="primary"
              busy={approve.isPending}
              disabled={!canApprove}
              aria-describedby={canApprove ? undefined : approveId}
              onClick={() => shown && approve.mutate(shown.id)}
            >
              Approve
            </Button>
          )}
          {buttons.draftSpec && (
            <Button
              busy={draftSpec.isPending}
              disabled={changed}
              aria-describedby={changed ? lockId : undefined}
              onClick={startDraft}
            >
              Draft spec
            </Button>
          )}
          {buttons.draftSpec && changed && (
            <span id={lockId} className="muted">
              {DRAFT_LOCK}
            </span>
          )}
          {buttons.approve && !canApprove && (
            <span id={approveId} className="muted">
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
          <div className="actions">
            <Button
              type="submit"
              busy={redraft.isPending}
              disabled={changed}
              aria-describedby={changed ? lockId : undefined}
            >
              Redraft
            </Button>
            {changed && (
              <span id={lockId} className="muted">
                {DRAFT_LOCK}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
