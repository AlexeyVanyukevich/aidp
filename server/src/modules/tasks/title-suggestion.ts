import type { RunStatus } from '../../shared/vocabulary.js'

/** What the card shows of the task's latest title run (R10). */
export type TitleSuggestion =
  | { status: 'working' }
  | { status: 'ready'; title: string; reason: string }
  | { status: 'failed'; reason: string }

/** A title run as the reader needs it: the run, and the suggestion its artifact holds. */
export interface TitleRunFacts {
  status: RunStatus
  failure_reason: string | null
  suggestion: { title: string; reason: string; decision: string | null } | null
}

/** Pure: no suggestion is shown for a cancelled run, or one the owner has decided. */
export function readTitleSuggestion(run: TitleRunFacts | undefined): TitleSuggestion | null {
  if (run === undefined) return null
  switch (run.status) {
    case 'queued':
    case 'running':
    case 'paused':
    case 'blocked':
      return { status: 'working' }
    case 'succeeded':
      return run.suggestion !== null && run.suggestion.decision === null
        ? { status: 'ready', title: run.suggestion.title, reason: run.suggestion.reason }
        : null
    case 'failed':
      return { status: 'failed', reason: run.failure_reason ?? 'the title run failed' }
    case 'cancelled':
      return null
  }
}
