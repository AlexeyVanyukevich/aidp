import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type {
  ApprovalKind,
  ApprovalStatus,
  ArtifactKind,
  RunKind,
  Block,
  Checkpoint,
  EventType,
  HelpDecision,
  HelpMode,
  HelpResult,
  HelpStatus,
  HelpSubject,
  PendingWork,
  PhaseName,
  PhaseStatus,
  ProposalOutcome,
  RunStatus,
  SpecCriterion,
  SuggestionStatus,
  TaskState,
} from '../shared/vocabulary.js'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
/** `numeric` comes back from pg as a string; it is parsed where it is read. */
type Numeric = ColumnType<string, number | string, number | string>

export interface ProjectsTable {
  id: Generated<string>
  key: string
  name: string
  repo_path: string
  github_repo: string
  base_branch: string
  setup_command: string | null
  next_task_number: Generated<number>
  created_at: Generated<Date>
}

export interface ProjectTestCommandsTable {
  id: Generated<string>
  project_id: string
  name: string
  command: string
  is_default: Generated<boolean>
  created_at: Generated<Date>
}

export interface TasksTable {
  id: Generated<string>
  project_id: string
  number: number
  title: string
  description_md: Generated<string>
  state: TaskState
  position: number
  budget_usd: ColumnType<string | null, number | null | undefined, number | null>
  /** The project test command the owner chose; null follows the project's default. */
  test_command_id: ColumnType<string | null, string | null | undefined, string | null>
  created_at: Generated<Date>
  updated_at: Timestamp
}

export interface SpecsTable {
  id: Generated<string>
  task_id: string
  version: number
  body_md: string
  criteria: JSONColumnType<SpecCriterion[] | null, string | null, string | null>
  status: 'draft' | 'approved' | 'superseded'
  approved_at: NullableTimestamp
  /** The spec run that wrote this version; null for one saved by hand. */
  run_id: ColumnType<string | null, string | null | undefined, string | null>
  created_at: Generated<Date>
}

export interface RunsTable {
  id: Generated<string>
  task_id: string
  kind: RunKind
  /** Its number among the task's runs of the same kind: "Draft 2", "Run 1". */
  number: number
  /** The approved version a delivery run delivers; the version a spec run redrafts, or null. */
  spec_version: number | null
  /** What the owner asked a redraft to change. */
  note: ColumnType<string | null, string | null | undefined, string | null>
  /** The text tests run with, fixed at the first claim of a delivery run. */
  test_command: ColumnType<string | null, string | null | undefined, string | null>
  status: RunStatus
  current_phase: PhaseName | null
  branch: string | null
  worktree_path: string | null
  pr_number: number | null
  pr_url: string | null
  fix_loops: Generated<number>
  failure_reason: string | null
  runner_id: string | null
  cancel_requested: Generated<boolean>
  created_at: Generated<Date>
  started_at: NullableTimestamp
  ended_at: NullableTimestamp
  last_heartbeat_at: NullableTimestamp
  /** The latest the runner reported; what a resume starts from. */
  checkpoint: JSONColumnType<Checkpoint | null, string | null | undefined, string | null>
  block: JSONColumnType<Block | null, string | null | undefined, string | null>
  pending: ColumnType<PendingWork | null, PendingWork | null | undefined, PendingWork | null>
  resume_message: ColumnType<string | null, string | null | undefined, string | null>
  /** Set while work for this run waits to be claimed; the oldest is claimed first. */
  queued_at: NullableTimestamp
  /** A rephrase run's: the description as it stood when queued. */
  base_md: ColumnType<string | null, string | null | undefined, string | null>
  /** A rephrase run's latest saved suggestion. */
  suggestion_md: ColumnType<string | null, string | null | undefined, string | null>
  suggestion_status: ColumnType<
    SuggestionStatus | null,
    SuggestionStatus | null | undefined,
    SuggestionStatus | null
  >
  suggestion_decided_at: NullableTimestamp
}

export interface RunTokensTable {
  id: Generated<string>
  run_id: string
  token_hash: string
  expires_at: Timestamp
  created_at: Generated<Date>
  /** Set on a helper's token: it reaches the helper's tools and nothing else. */
  help_id: ColumnType<string | null, string | null | undefined, string | null>
}

export interface ProposalsTable {
  id: Generated<string>
  run_id: string
  phase_id: string
  task_id: string
  project_id: string
  number: number
  title: string
  description_md: string
  related: boolean
  bearing_md: string | null
  workaround_md: string | null
  approval_id: string | null
  outcome: ColumnType<
    ProposalOutcome | null,
    ProposalOutcome | null | undefined,
    ProposalOutcome | null
  >
  filed_task_id: ColumnType<string | null, string | null | undefined, string | null>
  created_at: Generated<Date>
  settled_at: NullableTimestamp
}

export interface HelpsTable {
  id: Generated<string>
  run_id: string
  /** Set exactly for a question help. */
  approval_id: string | null
  /** What the help advises on: a waiting question or one of the card's decisions. */
  decision: HelpDecision
  /** What the help is about, recorded when it was created; null for a question help. */
  subject: JSONColumnType<HelpSubject | null, string | null, string | null>
  /** Set when a succeeded help's subject no longer stands. */
  retired_at: NullableTimestamp
  /** The question of a batch; null for a single request. */
  question_index: number | null
  mode: HelpMode
  status: HelpStatus
  result: JSONColumnType<HelpResult | null, string | null, string | null>
  reason: string | null
  phase_id: string | null
  runner_id: string | null
  created_at: Generated<Date>
  started_at: NullableTimestamp
  ended_at: NullableTimestamp
  last_heartbeat_at: NullableTimestamp
}

export interface PhasesTable {
  /** Generated by the runner, so a replayed `phase_start` is recognised. */
  id: string
  run_id: string
  name: PhaseName
  attempt: number
  agent: string
  model: string
  status: PhaseStatus
  session_id: string | null
  summary_md: string | null
  /** Claude Code's own cost per model for this phase: `{ "<model>": <usd> }`. */
  reported_cost: JSONColumnType<Record<string, number> | null, string | null, string | null>
  started_at: Timestamp
  ended_at: NullableTimestamp
  /** A process of this phase was stopped by a signal or lost: its cost is not compared. */
  interrupted: Generated<boolean>
}

export interface EventsTable {
  /** Generated by the runner or the hook: a replay of the same event is a no-op. */
  id: string
  run_id: string
  phase_id: string | null
  ts: Timestamp
  type: EventType
  agent: string | null
  model: string | null
  tool: string | null
  target: string | null
  status: string | null
  duration_ms: number | null
  input: number
  output: number
  cache_read: number
  cache_write: number
  payload: JSONColumnType<Record<string, unknown>, string, string>
  received_at: Generated<Date>
}

export interface ApprovalRequestsTable {
  id: Generated<string>
  run_id: string
  phase_id: string | null
  kind: ApprovalKind
  question: string
  options: JSONColumnType<unknown[], string, string>
  recommendation: string | null
  context_md: string | null
  status: ApprovalStatus
  answer: ColumnType<unknown, string | null, string | null>
  checkpoint: ColumnType<unknown, string | null, string | null>
  /** The files an `out_of_plan` request asks to change. */
  files: JSONColumnType<string[] | null, string | null | undefined, string | null>
  /** A batch's questions, numbered `q1` … `qn`; null for every other kind. */
  questions: JSONColumnType<unknown[] | null, string | null | undefined, string | null>
  created_at: Generated<Date>
  answered_at: NullableTimestamp
}

export interface ArtifactsTable {
  id: Generated<string>
  run_id: string
  phase_id: string | null
  kind: ArtifactKind
  body_md: string
  uri: string | null
  data: ColumnType<unknown, string | null, string | null>
  /** The number of the run this plan was copied from by a Re-run that keeps the plan. */
  copied_from_run: number | null
  created_at: Generated<Date>
}

export interface PricesTable {
  model: string
  effective_from: ColumnType<Date, string, string>
  input: Numeric
  output: Numeric
  cache_read: Numeric
  cache_write: Numeric
}

export interface ProjectLinksTable {
  project_id: string
  linked_project_id: string
  note: string
  created_at: Generated<Date>
}

export interface Database {
  projects: ProjectsTable
  project_links: ProjectLinksTable
  project_test_commands: ProjectTestCommandsTable
  tasks: TasksTable
  specs: SpecsTable
  runs: RunsTable
  run_tokens: RunTokensTable
  helps: HelpsTable
  proposals: ProposalsTable
  phases: PhasesTable
  events: EventsTable
  approval_requests: ApprovalRequestsTable
  artifacts: ArtifactsTable
  prices: PricesTable
}
