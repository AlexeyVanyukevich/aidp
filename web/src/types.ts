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
  setup_command: string | null
}
export interface ProjectLink {
  key: string
  name: string
  note: string
}
/** What the list returns: a project with the projects it links to, ordered by key. */
export interface TestCommand {
  id: string
  name: string
  command: string
  is_default: boolean
}
export interface ProjectWithLinks extends ProjectView {
  links: ProjectLink[]
  /** Every test command, ordered by lower-case name. */
  test_commands: TestCommand[]
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
  /** Whether the latest delivery run opened a pull request. */
  has_pull_request: boolean
  id: string
  key: string
  number: number
  title: string
  description_md: string
  state: TaskState
  position: number
  budget_usd: number | null
  /** The project test command the owner chose; null follows the project's default. */
  test_command_id: string | null
  /** What the latest delivery run that started tests with; null when none has. */
  tested_with: string | null
  project: { key: string; name: string; github_repo: string }
  /** The question the card waits on: open, or expired and blocking it; a batch's count. */
  approval: { id: string; kind: ApprovalKind; status: ApprovalStatus; questions: number } | null
  /** Why a Blocked card is blocked; null in any other state. */
  block: Block | null
  /** Why the latest run, a draft, failed; null otherwise. */
  draft_failure: string | null
  /** On a Failed card: the run whose accepted plan a Re-run can keep; null when there is none. */
  plan_to_keep: { run: number } | null
  /** The task's latest title run: working, a suggestion to decide, or its failure; else null. */
  title_suggestion: TitleSuggestion | null
  /** The task's latest rephrase run; null before any. */
  rephrase: RephraseView | null
}
export interface RephraseView {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** Why the run failed; null otherwise. */
  failure_reason: string | null
  /** The pending suggestion; stale when the description changed since it was written. */
  suggestion: { body_md: string; stale: boolean } | null
}
export type TitleSuggestion =
  | { status: 'working' }
  | { status: 'ready'; title: string; reason: string }
  | { status: 'failed'; reason: string }
export type ApprovalKind =
  'question' | 'out_of_plan' | 'migration' | 'plan' | 'questions' | 'proposal'
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
/** One question of a batch, numbered by the server. */
export interface BatchQuestion {
  id: string
  question: string
  options: ApprovalOption[]
  recommendation: string | null
  context_md: string | null
}
/** A batch is answered whole: one entry per question. */
export interface BatchAnswer {
  answers: (ApprovalAnswer & { question_id: string })[]
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
  /** A batch's questions; null for every other kind. */
  questions: BatchQuestion[] | null
  question_count: number
  status: ApprovalStatus
  answer: ApprovalAnswer | BatchAnswer | null
  created_at: string
  answered_at: string | null
}
export type QuestionHelpMode = 'suggest' | 'explain'
export type HelpMode =
  QuestionHelpMode | 'review' | 'restate' | 'recommend' | 'check' | 'code_review'
export type HelpDecision =
  'question' | 'spec_review' | 'stopped_run' | 'mark_done' | 'proposal' | 'pull_request'
export type HelpStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped'
export type StoppedRunAction = 'resume' | 'cancel' | 'rerun_again' | 'rerun_keep' | 'mark_done'
/** What a helper saved: a suggestion, a plain restatement, or advice on a decision of the card. */
export type HelpResult =
  | { mode: 'suggest'; option_id?: string; text?: string; reasoning: string; unsure: string }
  | { mode: 'explain'; asked: string; matters: string; leads_to: string }
  | {
      mode: 'code_review'
      verdict: 'changes' | 'nothing_to_change'
      findings: {
        kind: 'bug' | 'breaks' | 'duplicate' | 'fit' | 'test'
        where: string
        text: string
        matters: string
      }[]
      unsure: string
      /** The commit the helper read; null when the board has none. */
      commit: string | null
      /** The files the board skipped by name; absent on a review saved before it recorded them. */
      skipped?: { path: string; skip: 'lockfile' | 'generated' }[]
    }
  | {
      mode: 'review'
      verdict: 'changes' | 'nothing_to_change'
      findings: {
        kind: 'missing' | 'contradiction' | 'uncheckable' | 'risk'
        where?: string
        text: string
      }[]
      unsure: string
    }
  | { mode: 'restate'; changes: string; requirements: string; left_out: string }
  | {
      mode: 'recommend'
      why_stopped: string
      action: StoppedRunAction
      reasoning: string
      unsure: string
    }
  | { mode: 'advise'; variant: ProposalOutcome; reasoning: string; unsure: string }
  | {
      mode: 'check'
      checked_against: 'approved_spec' | 'latest_spec' | 'description'
      produced: string
      unfinished: { where?: string; text: string }[]
      unsure: string
    }
/** What a decision help recorded when it was created. */
export interface HelpSubject {
  spec_version?: number
  run_id?: string
  task_state?: TaskState
  block?: string | null
  delivery_run_id?: string | null
  proposal_id?: string
  pr_run_id?: string
}
export interface HelpView {
  id: string
  /** Set exactly for a question help. */
  approval_id: string | null
  decision: HelpDecision
  subject: HelpSubject | null
  /** The question of a batch; null for a single request. */
  question_index: number | null
  /** A proposal's help has the mode `advise`, which only its result type names. */
  mode: HelpMode
  status: HelpStatus
  result: HelpResult | null
  reason: string | null
  created_at: string
}
export interface OpenApproval extends ApprovalView {
  task_id: string
  task_key: string
  project_key: string
}
export interface LintFinding {
  code: string
  id?: string
  section?: string
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
  kind: 'plan' | 'verify_report' | 'pr' | 'title'
  phase_id: string | null
  body_md: string
  uri: string | null
  data: unknown
  /** The number of the run a Re-run copied this plan from. */
  copied_from_run: number | null
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
  /** For a help run, its help's status. */
  help_status?: HelpStatus | null
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
    run: { kind: string; number: number } | null
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
  /** Criteria the owner withdrew at the plan gate; absent from an older board. */
  withdrawn?: { criterion: string; answer: string }[]
}
export interface ReportData {
  summary: string
  criteria: { id: string; status: 'pass' | 'fail' | 'owner' | 'withdrawn'; evidence: string }[]
  /** Set by the server from the accepted plan; absent from an older board. */
  withdrawn?: { criterion: string; answer: string }[]
}
export interface PrFile {
  path: string
  additions: number
  deletions: number
}

/** How the owner settles a proposal. `wait` is never offered in this release. */
export type ProposalOutcome = 'file' | 'workaround' | 'wait' | 'dismiss'

/** One finding an agent proposed, as `GET /api/tasks/:id/proposals` gives it. */
export interface ProposalView {
  id: string
  run: { kind: 'spec' | 'delivery'; number: number }
  phase: string
  number: number
  project: string
  title: string
  description_md: string
  related: boolean
  bearing_md: string | null
  workaround_md: string | null
  offered: ProposalOutcome[]
  outcome: ProposalOutcome | null
  filed_task: { id: string; key: string; title: string } | null
  created_at: string
  settled_at: string | null
}
