import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Markdown, Notice, Select, Textarea } from '@zellige/react'
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
const NO_TITLE = 'Enter a title.'
const NO_DESCRIPTION_TO_REPHRASE = 'Write a description first; the rephraser works from it.'
const NO_SUGGESTION = 'Write the text to accept, or discard the suggestion.'
const WAIT_FOR_REPHRASE = 'Wait for the rephrase to finish, or cancel it.'

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
  const waitId = useId()
  const suggestionHeadingId = useId()
  const controls = specControls(task.state)
  const [selected, setSelected] = useState<string | undefined>()
  const [draft, setDraft] = useState<string | undefined>()
  const [editing, setEditing] = useState(false)
  // Where focus goes once the control is on the page; kept until it is.
  type Target = 'edit' | 'write' | 'text' | 'stop' | 'rephrase' | 'cancelRephrase'
  const pending = useRef<Target | undefined>(undefined)
  const setFocus = (target: Target) => {
    pending.current = target
  }
  /** A ref that takes focus when its control appears, if that is where focus was sent. */
  const focusOn = (target: Target) => (element: HTMLElement | null) => {
    if (element && pending.current === target) {
      pending.current = undefined
      element.focus()
    }
  }
  // The Title field: the owner's own text, the suggestion as edited, and where focus goes.
  const [title, setTitle] = useState<string | undefined>()
  const [titleMissing, setTitleMissing] = useState(false)
  const [edited, setEdited] = useState<{ of: string; text: string } | undefined>()
  const [suggestedMissing, setSuggestedMissing] = useState(false)
  const titleField = useRef<HTMLInputElement>(null)
  const suggestedField = useRef<HTMLInputElement>(null)
  const rephraseButton = useRef<HTMLButtonElement>(null)
  const [description, setDescription] = useState<string | undefined>()
  // The Description field's error text: which button found it blank.
  const [descriptionMissing, setDescriptionMissing] = useState<string | undefined>()
  const [suggestedDescription, setSuggestedDescription] = useState<
    { of: string; text: string } | undefined
  >()
  const [suggestionMissing, setSuggestionMissing] = useState(false)
  const suggestionField = useRef<HTMLTextAreaElement>(null)
  const rephraseDescriptionButton = useRef<HTMLButtonElement>(null)
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

  const suggestion = task.title_suggestion
  const suggestionStatus = suggestion?.status ?? 'none'
  // A suggestion that arrives while the card is open, and a run that fails, are announced; the
  // state is adjusted while rendering, as React advises for a change in what arrived.
  const [lastStatus, setLastStatus] = useState(suggestionStatus)
  if (lastStatus !== suggestionStatus) {
    setLastStatus(suggestionStatus)
    if (lastStatus === 'working' && suggestion?.status === 'ready')
      setMessage(`A title is suggested: ${suggestion.title}.`)
    if (lastStatus === 'working' && suggestion?.status === 'failed')
      setMessage(`The title suggestion did not finish: ${suggestion.reason}.`)
  }
  // Stop took focus with it when it went, and so does a run that finishes: back to Rephrase.
  const wasWorking = useRef(false)
  useEffect(() => {
    if (wasWorking.current && suggestionStatus !== 'working') {
      if (document.activeElement === document.body || document.activeElement === null)
        rephraseButton.current?.focus()
    }
    wasWorking.current = suggestionStatus === 'working'
  }, [suggestionStatus])

  // The description rephrase: in flight, a suggestion to decide, or a failure to show.
  const rephrasing = task.rephrase?.status === 'queued' || task.rephrase?.status === 'running'
  const pendingSuggestion = task.rephrase?.suggestion ?? null
  const suggestionKey = pendingSuggestion?.body_md ?? null
  const [lastSuggestion, setLastSuggestion] = useState(suggestionKey)
  if (lastSuggestion !== suggestionKey) {
    setLastSuggestion(suggestionKey)
    if (lastSuggestion === null && suggestionKey !== null)
      setMessage('A suggested description is ready.')
  }
  // Cancel took focus with it when it went, and so does a run that finishes: back to Rephrase.
  const wasRephrasing = useRef(false)
  useEffect(() => {
    if (wasRephrasing.current && !rephrasing) {
      if (document.activeElement === document.body || document.activeElement === null)
        rephraseDescriptionButton.current?.focus()
    }
    wasRephrasing.current = rephrasing
  }, [rephrasing])

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
  const markMissing = (which: 'description' | 'note', text = NO_DESCRIPTION) => {
    flushSync(() => (which === 'description' ? setDescriptionMissing(text) : setNoteMissing(true)))
    ;(which === 'description' ? descriptionField : noteField).current?.focus()
  }

  const titleOf = title ?? task.title
  const missingTitle = (which: 'title' | 'suggested') => {
    flushSync(() => (which === 'title' ? setTitleMissing : setSuggestedMissing)(true))
    ;(which === 'title' ? titleField : suggestedField).current?.focus()
  }
  const failTitle = (error: unknown) =>
    setProblem({
      text: isConflict(error)
        ? 'This card changed meanwhile; its latest state is shown.'
        : 'That did not work. Try again.',
    })
  const saveTitle = useMutation({
    mutationFn: () => api.patchTask(task.id, { title: titleOf.trim() }),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setTitle(undefined)
      setMessage('Title saved.')
    },
    onError: failTitle,
    onSettled: refresh,
  })
  // A title the owner has edited is saved first: the agent reads the owner's text.
  const rephrase = useMutation({
    mutationFn: async () => {
      if (title !== undefined) await api.patchTask(task.id, { title: title.trim() })
      return api.action(task.id, 'rephrase-title')
    },
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setTitle(undefined)
      setFocus('stop')
      setMessage('Suggesting a title.')
    },
    onError: failTitle,
    onSettled: refresh,
  })
  const stop = useMutation({
    mutationFn: () => api.action(task.id, 'stop-title'),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setFocus('rephrase')
      setMessage('Suggestion stopped.')
    },
    onError: failTitle,
    onSettled: refresh,
  })
  const accept = useMutation({
    mutationFn: (text: string) => api.acceptTitle(task.id, text.trim()),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setTitle(undefined)
      setEdited(undefined)
      setMessage('Title saved.')
    },
    onError: failTitle,
    onSettled: refresh,
  })
  const discard = useMutation({
    mutationFn: () => api.action(task.id, 'discard-title'),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setEdited(undefined)
      setMessage('Suggestion discarded.')
    },
    onError: failTitle,
    onSettled: refresh,
  })
  const suggested =
    suggestion?.status === 'ready'
      ? edited?.of === `${suggestion.title}\n${suggestion.reason}`
        ? edited.text
        : suggestion.title
      : ''
  const pressSaveTitle = () => {
    if (titleOf.trim() === '') missingTitle('title')
    else saveTitle.mutate()
  }
  const pressRephrase = () => {
    if (titleOf.trim() === '') missingTitle('title')
    else rephrase.mutate()
  }
  // Focus moves to the Title field while the buttons that will go are still on the page.
  const pressAccept = () => {
    if (suggested.trim() === '') missingTitle('suggested')
    else {
      titleField.current?.focus()
      accept.mutate(suggested)
    }
  }
  const pressDiscard = () => {
    titleField.current?.focus()
    discard.mutate()
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
  // An edited description is saved first: the rephraser reads what the owner sees.
  const rephraseDescription = useMutation({
    mutationFn: async () => {
      if (description !== undefined) await api.patchTask(task.id, { description_md: description })
      return api.action(task.id, 'rephrase')
    },
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setDescription(undefined)
      setFocus('cancelRephrase')
      setMessage('The rephraser is reading the code.')
    },
    onError: (error) => {
      if (invalidField(error) === 'description_md')
        markMissing('description', NO_DESCRIPTION_TO_REPHRASE)
      else fail('draft')(error)
    },
    onSettled: refresh,
  })
  const cancelRephrase = useMutation({
    mutationFn: () => api.action(task.id, 'cancel-rephrase'),
    onMutate: () => setProblem(undefined),
    onSuccess: () => setMessage('Rephrase cancelled.'),
    onError: fail('draft'),
    onSettled: refresh,
  })
  const acceptSuggestion = useMutation({
    mutationFn: (text: string) => api.acceptSuggestion(task.id, text),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setDescription(undefined)
      setSuggestedDescription(undefined)
      setMessage('Description replaced with the suggestion.')
    },
    onError: fail('draft'),
    onSettled: refresh,
  })
  const discardSuggestion = useMutation({
    mutationFn: () => api.discardSuggestion(task.id),
    onMutate: () => setProblem(undefined),
    onSuccess: () => {
      setSuggestedDescription(undefined)
      setMessage('Suggestion discarded.')
    },
    onError: fail('draft'),
    onSettled: refresh,
  })
  const suggestedText =
    pendingSuggestion === null
      ? ''
      : suggestedDescription?.of === pendingSuggestion.body_md
        ? suggestedDescription.text
        : pendingSuggestion.body_md
  const pressRephraseDescription = () => {
    if (describedAs.trim() === '') markMissing('description', NO_DESCRIPTION_TO_REPHRASE)
    else rephraseDescription.mutate()
  }
  // Focus moves to the Description field while the controls that will go are still on the page.
  const pressCancelRephrase = () => {
    descriptionField.current?.focus()
    cancelRephrase.mutate()
  }
  const pressAcceptSuggestion = () => {
    if (suggestedText.trim() === '') {
      flushSync(() => setSuggestionMissing(true))
      suggestionField.current?.focus()
    } else {
      descriptionField.current?.focus()
      acceptSuggestion.mutate(suggestedText)
    }
  }
  const pressDiscardSuggestion = () => {
    descriptionField.current?.focus()
    discardSuggestion.mutate()
  }
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
      <Field label="Title" error={titleMissing ? NO_TITLE : undefined}>
        <Input
          ref={titleField}
          value={titleOf}
          readOnly={!controls.describe}
          onChange={(e) => {
            setTitle(e.target.value)
            if (titleMissing) setTitleMissing(false)
          }}
        />
      </Field>
      {controls.describe && (
        <div className="actions">
          <Button busy={saveTitle.isPending} onClick={pressSaveTitle}>
            Save title
          </Button>
          {suggestion?.status === 'working' ? (
            <>
              <span>Suggesting a title…</span>
              <Button ref={focusOn('stop')} busy={stop.isPending} onClick={() => stop.mutate()}>
                Stop
              </Button>
            </>
          ) : (
            <Button
              ref={(element) => {
                rephraseButton.current = element
                focusOn('rephrase')(element)
              }}
              busy={rephrase.isPending}
              onClick={pressRephrase}
            >
              Rephrase title
            </Button>
          )}
        </div>
      )}
      {controls.describe && suggestion?.status === 'failed' && (
        <p>The title suggestion did not finish: {suggestion.reason}.</p>
      )}
      {controls.describe && suggestion?.status === 'ready' && (
        <>
          <Field
            label="Suggested title"
            hint={suggestion.reason}
            error={suggestedMissing ? NO_TITLE : undefined}
          >
            <Input
              ref={suggestedField}
              value={suggested}
              onChange={(e) => {
                setEdited({
                  of: `${suggestion.title}\n${suggestion.reason}`,
                  text: e.target.value,
                })
                if (suggestedMissing) setSuggestedMissing(false)
              }}
            />
          </Field>
          <div className="actions">
            <Button variant="primary" busy={accept.isPending} onClick={pressAccept}>
              Accept title
            </Button>
            <Button busy={discard.isPending} onClick={pressDiscard}>
              Discard
            </Button>
          </div>
        </>
      )}
      <div className="description-pair">
        <div>
          <Field
            label="Description"
            hint="What the task is for. The spec-writer drafts from it."
            error={descriptionMissing}
          >
            <Textarea
              ref={descriptionField}
              value={describedAs}
              readOnly={!controls.describe}
              rows={4}
              onChange={(e) => {
                setDescription(e.target.value)
                if (descriptionMissing) setDescriptionMissing(undefined)
              }}
            />
          </Field>
          {controls.describe && task.rephrase?.status === 'failed' && (
            <p>The last rephrase did not finish: {task.rephrase.failure_reason}.</p>
          )}
        </div>
        {controls.describe && pendingSuggestion !== null && (
          <section aria-labelledby={suggestionHeadingId} className="suggestion">
            <h3 id={suggestionHeadingId}>Suggested description</h3>
            {pendingSuggestion.stale && <p>Written from an earlier version of your description.</p>}
            <Field label="Suggestion text" error={suggestionMissing ? NO_SUGGESTION : undefined}>
              <Textarea
                ref={suggestionField}
                value={suggestedText}
                rows={4}
                onChange={(e) => {
                  setSuggestedDescription({ of: pendingSuggestion.body_md, text: e.target.value })
                  if (suggestionMissing) setSuggestionMissing(false)
                }}
              />
            </Field>
            <div className="actions">
              <Button
                variant="primary"
                busy={acceptSuggestion.isPending}
                onClick={pressAcceptSuggestion}
              >
                Accept suggestion
              </Button>
              <Button busy={discardSuggestion.isPending} onClick={pressDiscardSuggestion}>
                Discard suggestion
              </Button>
            </div>
          </section>
        )}
      </div>
      {controls.describe && (
        <div className="actions">
          <Button busy={describe.isPending} onClick={() => describe.mutate()}>
            Save description
          </Button>
          {rephrasing ? (
            <>
              <span>The rephraser is reading the code.</span>
              <Button
                ref={focusOn('cancelRephrase')}
                busy={cancelRephrase.isPending}
                onClick={pressCancelRephrase}
              >
                Cancel rephrase
              </Button>
              <span id={waitId} className="muted">
                {WAIT_FOR_REPHRASE}
              </span>
            </>
          ) : (
            <Button
              ref={rephraseDescriptionButton}
              busy={rephraseDescription.isPending}
              onClick={pressRephraseDescription}
            >
              Rephrase description
            </Button>
          )}
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
              disabled={!canApprove || rephrasing}
              aria-describedby={rephrasing ? waitId : canApprove ? undefined : approveId}
              onClick={() => shown && approve.mutate(shown.id)}
            >
              Approve
            </Button>
          )}
          {buttons.draftSpec && (
            <Button
              busy={draftSpec.isPending}
              disabled={changed || rephrasing}
              aria-describedby={rephrasing ? waitId : changed ? lockId : undefined}
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
          {buttons.approve && !canApprove && !rephrasing && (
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
              disabled={changed || rephrasing}
              aria-describedby={rephrasing ? waitId : changed ? lockId : undefined}
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
