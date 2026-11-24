import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Button, Field, Radio, RadioGroup, Textarea } from '@zellige/react'
import { defaultRerunPicks, fillRerunNote, type PrReviewResult, type RerunPick } from './approvals'

/** The error a blank field gets, tied to the field and read out. */
export const SEND_BACK_BLANK = 'Say what to change.'

/** The hint under the field: where the builder works, and what runs again. */
export const sendBackHint = (branch: string): string =>
  `A builder makes these on ${branch}; Verify runs again before the card returns to Review.`

/**
 * Send back with changes: the owner's words for a builder on the same branch. Use the pull
 * request review puts chosen findings in the field, as on a Failed card. A blank press sends
 * nothing: the field is marked invalid, described by the error, and focused.
 */
export function SendBack({
  branch,
  review,
  busy,
  onSend,
}: {
  branch: string
  review: { result: PrReviewResult; createdAt: string } | undefined
  busy: boolean
  /** Sends the trimmed note; a blank one never reaches it. */
  onSend: (note: string) => void
}) {
  const headingId = useId()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [picks, setPicks] = useState<RerunPick[] | undefined>(undefined)
  const field = useRef<HTMLTextAreaElement | null>(null)

  const send = () => {
    if (busy) return
    const words = note.trim()
    if (words === '') {
      flushSync(() => setError(SEND_BACK_BLANK))
      field.current?.focus()
      return
    }
    onSend(words)
  }

  return (
    <section aria-labelledby={headingId} className="send-back">
      <h3 id={headingId}>Send back with changes</h3>
      <Field label="Changes to make" hint={sendBackHint(branch)} error={error}>
        <Textarea
          ref={field}
          rows={4}
          required
          value={note}
          onChange={(event) => {
            setNote(event.target.value)
            setError(undefined)
          }}
        />
      </Field>
      {review !== undefined && picks === undefined && (
        <Button type="button" onClick={() => setPicks(defaultRerunPicks(review.result))}>
          Use the pull request review
        </Button>
      )}
      {review !== undefined && picks !== undefined && (
        <>
          <ul>
            {review.result.findings.map((finding, index) => (
              <li key={index}>
                <strong>{finding.kind}</strong> ({finding.where}): {finding.text}{' '}
                <strong>Evidence:</strong> {finding.evidence}
                <RadioGroup
                  label={`What to do with finding ${index + 1}`}
                  value={picks[index] ?? 'out'}
                  onChange={(pick) =>
                    setPicks(picks.map((now, i) => (i === index ? (pick as RerunPick) : now)))
                  }
                >
                  <Radio value="in">Put in the note</Radio>
                  <Radio value="out">Leave out</Radio>
                </RadioGroup>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            onClick={() => {
              const next = fillRerunNote(note, review.result, review.createdAt, picks)
              flushSync(() => {
                setNote(next)
                setError(undefined)
                setPicks(undefined)
              })
              field.current?.focus()
              field.current?.setSelectionRange(next.length, next.length)
            }}
          >
            Fill note
          </Button>
        </>
      )}
      <Button type="button" variant="primary" busy={busy} onClick={send}>
        Send back
      </Button>
    </section>
  )
}
