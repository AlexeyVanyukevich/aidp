export type TaskState =
  | 'backlog'
  | 'spec_draft'
  | 'spec_review'
  | 'ready'
  | 'running'
  | 'needs_approval'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed'

export interface ProjectView {
  id: string
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  test_command: string
}
export interface TaskCard {
  id: string
  key: string
  title: string
  state: TaskState
  position: number
  phase: string | null
  attempt: number | null
  models: string[]
  cost_usd: number
  cost_complete: boolean
  pr_url: string | null
  question_waiting: boolean
}
export interface TaskView {
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  project: { key: string; name: string; github_repo: string }
  /** The question the card waits on: open, or expired and blocking it; a batch's count. */
  approval: { id: string; kind: ApprovalKind; status: ApprovalStatus; questions: number } | null
  /** Why a Blocked card is blocked; null in any other state. */
  block: Block | null
  /** Why the latest run, a draft, failed; null otherwise. */
  draft_failure: string | null
}
export type ApprovalKind = 'question' | 'out_of_plan' | 'plan' | 'questions'
export type ApprovalStatus = 'open' | 'answered' | 'expired' | 'withdrawn'
export type Stage = 'prepare' | 'spec' | 'plan' | 'build' | 'tests' | 'verify' | 'push' | 'pr'
export interface Block {
  cause: 'runner_lost' | 'step_failed' | 'runner_stopped' | 'approval_expired'
  stage: Stage | null
  command?: string
  output?: string
}
export interface ApprovalOption {
  id: string
  label: string
  impact?: string
}
export interface ApprovalAnswer {
  option_id?: string
  text?: string
}
export interface ApprovalView {
  id: string
  run_id: string
  phase_id: string | null
  kind: ApprovalKind
  question: string
  options: ApprovalOption[]
  recommendation: string | null
  context_md: string | null
  files: string[] | null
  status: ApprovalStatus
  answer: ApprovalAnswer | null
  created_at: string
  answered_at: string | null
}
export interface OpenApproval extends ApprovalView {
  task_id: string
  task_key: string
  project_key: string
}
export interface LintFinding {
  code: string
  id?: string
  text?: string
}
export interface SpecView {
  id: string
  version: number
  body_md: string
  status: 'draft' | 'approved' | 'superseded'
  approved_at: string | null
  lint: {
    requirements: string[]
    criteria: { id: string; requirements: string[]; text: string }[]
    open_questions: string[]
    findings: LintFinding[]
    approvable: boolean
  }
}
export interface PhaseView {
  id: string
  name: string
  attempt: number
  agent: string
  model: string
  status: string
  summary_md: string | null
  started_at: string
  ended_at: string | null
  interrupted: boolean
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
  number: number
  kind: string
  status: string
  /** A spec run's first draft has none. */
  spec_version: number | null
  current_phase: string | null
  branch: string | null
  pr_number: number | null
  pr_url: string | null
  failure_reason: string | null
  fix_loops: number
  created_at: string
  started_at: string | null
  ended_at: string | null
  phases: PhaseView[]
  artifacts: ArtifactView[]
}
export interface Usage {
  input: number
  output: number
  cache_read: number
  cache_write: number
}
export interface EventView {
  id: string
  phase_id: string | null
  ts: string
  type: string
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  usage: Usage
  payload: Record<string, unknown>
}
export interface CostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface CostLine {
  usage: CostUsage
  usd: number
}
export interface CostSummary {
  totals: CostLine
  byPhase: (CostLine & {
    phaseId: string
    name: string
    attempt: number
    reportedUsd: number | null
    drift: number | null
    flagged: boolean
    interrupted: boolean
    cut: boolean
  })[]
  byAgent: (CostLine & { agent: string })[]
  byModel: (CostLine & { model: string })[]
  cacheHitRatio: number | null
  missingPrices: string[]
}
export interface PlanData {
  summary: string
  confidence: string
  steps: { title: string; requirements: string[]; files: string[]; estimate_usd?: number }[]
  checks: { criterion: string; how: string }[]
}
export interface ReportData {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail'; evidence: string }[]
}
export interface PrFile {
  path: string
  additions: number
  deletions: number
}
