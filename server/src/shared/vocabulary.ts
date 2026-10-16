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

/** Slice 1's run statuses. Slice 2 adds `paused` and `blocked` with its own migration. */
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const PHASE_NAMES = ['spec', 'plan', 'build', 'verify'] as const
export type PhaseName = (typeof PHASE_NAMES)[number]

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

export const ARTIFACT_KINDS = ['plan', 'verify_report', 'pr'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

/** One acceptance criterion as the spec parser reads it and approval freezes it. */
export interface SpecCriterion {
  id: string
  requirements: string[]
  text: string
}
