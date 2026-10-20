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

export type Stage = 'prepare' | 'plan' | 'build' | 'tests' | 'verify' | 'push' | 'pr'

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
  } | null
  head: string | null
  plan_artifact_id: string | null
  failing_report_id: string | null
}

export interface RunWork {
  id: string
  number: number
  kind: 'spec' | 'delivery'
  spec_version: number
  task: {
    id: string
    key: string
    title: string
    description_md: string
    budget_usd: number | null
  }
  spec: { version: number; body_md: string; criteria: SpecCriterion[] }
  project: {
    key: string
    repo_path: string
    github_repo: string
    base_branch: string
    test_command: string
  }
}

export type Work =
  | { kind: 'start'; run: RunWork }
  | {
      kind: 'resume'
      run: RunWork
      checkpoint: Checkpoint
      message: string | null
      allowed_files: string[]
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
  criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[]
}

export interface ArtifactView {
  id: string
  kind: 'plan' | 'verify_report' | 'pr'
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
}

export interface RunView {
  id: string
  status: string
  phases: { id: string; name: PhaseName; attempt: number; status: string }[]
  artifacts: ArtifactView[]
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
