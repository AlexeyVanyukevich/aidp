/**
 * The runner's copy of the server's wire shapes. The scenario tests run the runner against the
 * real server; they are what catches the two drifting apart. Change both in one commit.
 */
export type PhaseName = 'spec' | 'plan' | 'build' | 'verify'
export type EventType =
  | 'phase_start'
  | 'phase_end'
  | 'message'
  | 'tool_call'
  | 'subagent_start'
  | 'subagent_stop'
  | 'approval_requested'
  | 'approval_answered'
  | 'checkpoint'
  | 'error'
  | 'run_end'

export interface Usage {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface RunnerEvent {
  id: string
  run_id: string
  phase_id: string | null
  ts: string
  type: EventType
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: Usage
  payload: Record<string, unknown>
}

export interface SpecCriterion {
  id: string
  requirements: string[]
  text: string
}

/** A delivery run's stages, and a spec run's `prepare` then `spec`. */
export type Stage = 'prepare' | 'spec' | 'plan' | 'build' | 'tests' | 'verify' | 'push' | 'pr'

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
  session: {
    id: string
    baseline: Record<string, SessionTotals>
    reported: Record<string, number>
    /** A process of the phase was stopped: kept here so the next runner reports it (§7). */
    interrupted?: boolean
  } | null
  head: string | null
  plan_artifact_id: string | null
  failing_report_id: string | null
}

export interface LinkedProject {
  key: string
  name: string
  note: string
  repo_path: string
  github_repo: string
  base_branch: string
}

export interface RunWork {
  id: string
  number: number
  kind: 'spec' | 'delivery'
  /** A delivery run's approved version; a spec run's version it redrafts, or null. */
  spec_version: number | null
  /** What the owner asked a redraft to change. */
  note: string | null
  task: {
    id: string
    key: string
    title: string
    description_md: string
    budget_usd: number | null
  }
  /** The spec at `spec_version`: null for a first draft. */
  spec: { version: number; body_md: string; criteria: SpecCriterion[] } | null
  project: {
    key: string
    repo_path: string
    github_repo: string
    base_branch: string
    /**
     * A delivery run's value is the run's fixed text, set at its first claim, not the
     * project's; a spec run's is the task's chosen command, else the project's default.
     */
    test_command: string
    setup_command: string | null
  }
  /** The projects this one links to, read-only, ordered by key; absent from an older board. */
  links?: LinkedProject[]
  /** Earlier plans for a planner starting again; absent from an older board. */
  previous_plans?: { run: number; accepted: boolean; body_md: string }[]
  /** The owner's words at earlier plan gates on this spec version; absent from an older board. */
  plan_answers?: { run: number; approved: boolean; text: string }[]
  /** The plan a Re-run copied into this run: no planner starts. Absent from an older board. */
  kept_plan?: { artifact_id: string; from_run: number } | null
}

export type Work =
  | { kind: 'start'; run: RunWork }
  | {
      kind: 'resume'
      run: RunWork
      checkpoint: Checkpoint
      message: string | null
      allowed_files: string[]
      /** Migrations the owner approved for this run; absent from an older board. */
      approved_migrations?: string[]
    }
  | { kind: 'cleanup'; run: { id: string; repo_path: string; worktree_path: string | null } }

export type StartWork = Extract<Work, { kind: 'start' }>

export interface PlanData {
  summary: string
  confidence: 'high' | 'medium' | 'low'
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}

export interface ReportData {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail' | 'owner'; evidence: string }[]
}

export interface ArtifactView {
  id: string
  kind: 'plan' | 'verify_report' | 'pr'
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
  copied_from_run?: number | null
}

export interface RunView {
  id: string
  status: string
  phases: {
    id: string
    name: PhaseName
    attempt: number
    status: string
    summary_md: string | null
  }[]
  artifacts: ArtifactView[]
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
