export const TASK_STATES = [
  'backlog',
  'spec_draft',
  'spec_review',
  'ready',
  'running',
  'needs_approval',
  'review',
  'done',
  'blocked',
  'failed',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export const RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** A run's kind: a spec run drafts, a delivery run delivers, a title run suggests a title. */
export const RUN_KINDS = ['spec', 'delivery', 'title'] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'discarded', 'replaced'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

/** `help` is a read-only helper's session beside a paused run; it is never a run's current phase. */
export const PHASE_NAMES = ['spec', 'plan', 'build', 'verify', 'title', 'help', 'rephrase'] as const
export type PhaseName = (typeof PHASE_NAMES)[number]

/** A paused phase waits for an answer or a Resume; the same session carries on after it. */
export const PHASE_STATUSES = ['running', 'paused', 'succeeded', 'failed'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

export const HELP_MODES = ['suggest', 'explain'] as const
export type HelpMode = (typeof HELP_MODES)[number]

export const HELP_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'stopped'] as const
export type HelpStatus = (typeof HELP_STATUSES)[number]

/** What a helper saved: a suggestion, or a plain restatement in three parts. */
export type HelpResult =
  | {
      mode: 'suggest'
      option_id?: string
      text?: string
      reasoning: string
      unsure: string
    }
  | {
      mode: 'explain'
      asked: string
      matters: string
      leads_to: string
    }

export const APPROVAL_STATUSES = ['open', 'answered', 'expired', 'withdrawn'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** `questions` is a batch: several questions, asked together and answered whole (slice 3). */
export const APPROVAL_KINDS = ['question', 'out_of_plan', 'migration', 'plan', 'questions'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

/** Why a run is Blocked. The first and last are the server's sweeper's; the others the runner's. */
export const BLOCK_CAUSES = [
  'runner_lost',
  'step_failed',
  'runner_stopped',
  'approval_expired',
] as const
export type BlockCause = (typeof BLOCK_CAUSES)[number]

/**
 * A run's stages: a delivery run's, in order, a spec run's `prepare` then `spec`, and a rephrase
 * run's `prepare` then `rephrase`. A checkpoint names the one it resumes from.
 */
export const STAGES = [
  'prepare',
  'spec',
  'rephrase',
  'plan',
  'build',
  'tests',
  'verify',
  'push',
  'pr',
] as const
export type Stage = (typeof STAGES)[number]

export const PENDING_WORK = ['resume', 'cleanup'] as const
export type PendingWork = (typeof PENDING_WORK)[number]

/** One model's usage in a session as Claude Code reported it, with its own cost. */
export interface SessionTotals {
  input: number
  output: number
  cache_read: number
  cache_write: number
  usd: number
}

/** Where a run stands, as the runner last reported it: what a resume starts from. */
export interface Checkpoint {
  stage: Stage
  attempt: number
  phase_id: string | null
  /** The phase's Claude Code session, its last reported totals, and the cost credited so far. */
  session: {
    id: string
    baseline: Record<string, SessionTotals>
    reported: Record<string, number>
    /** A process of the phase was stopped: kept so the next runner reports it (spec §7). */
    interrupted?: boolean
  } | null
  head: string | null
  plan_artifact_id: string | null
  failing_report_id: string | null
}

export interface Block {
  cause: BlockCause
  stage: Stage | null
  command?: string
  output?: string
}

export const EVENT_TYPES = [
  'phase_start',
  'phase_end',
  'message',
  'tool_call',
  'subagent_start',
  'subagent_stop',
  'approval_requested',
  'approval_answered',
  'checkpoint',
  'error',
  'run_end',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const ARTIFACT_KINDS = ['plan', 'verify_report', 'pr', 'title'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** One acceptance criterion as the spec parser reads it and approval freezes it. */
export interface SpecCriterion {
  id: string
  requirements: string[]
  text: string
  /** Only the owner can check it. Absent in a criterion stored before the marker existed. */
  owner?: boolean
}
