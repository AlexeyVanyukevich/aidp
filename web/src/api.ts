import type {
  ApprovalAnswer,
  BatchAnswer,
  ApprovalView,
  EventView,
  OpenApproval,
  PrFile,
  ProjectView,
  RunView,
  SpecView,
  TaskCard,
  TaskView,
  CostSummary,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const error = (parsed ?? {}) as {
      error?: string
      message?: string
      details?: Record<string, unknown>
    }
    throw new ApiError(
      response.status,
      error.error ?? (response.status === 502 ? 'bad_gateway' : 'http_error'),
      error.message ?? text,
      error.details,
    )
  }
  return parsed as T
}

export const api = {
  projects: () => request<ProjectView[]>('GET', '/api/projects'),
  createProject: (input: Omit<ProjectView, 'id'>) =>
    request<ProjectView>('POST', '/api/projects', input),
  setSetupCommand: (key: string, setup_command: string | null) =>
    request<ProjectView>('PATCH', `/api/projects/${key}`, { setup_command }),
  board: (key: string) =>
    request<{ project: ProjectView; tasks: TaskCard[] }>('GET', `/api/projects/${key}/tasks`),
  createTask: (key: string, input: { title: string; description_md?: string }) =>
    request<TaskView>('POST', `/api/projects/${key}/tasks`, input),
  task: (id: string) => request<TaskView>('GET', `/api/tasks/${id}`),
  patchTask: (
    id: string,
    patch: { title?: string; description_md?: string; position?: number; state?: 'done' },
  ) => request<TaskView>('PATCH', `/api/tasks/${id}`, patch),
  action: (id: string, action: 'cancel' | 'resume' | 'draft-spec') =>
    request<TaskView>('POST', `/api/tasks/${id}/actions/${action}`),
  /** Re-run a Failed card: keep the accepted plan, or plan again. */
  rerun: (id: string, plan: 'keep' | 'again') =>
    request<TaskView>('POST', `/api/tasks/${id}/actions/rerun`, { plan }),
  redraft: (id: string, note: string) =>
    request<TaskView>('POST', `/api/tasks/${id}/actions/redraft`, { note }),
  specs: (taskId: string) => request<SpecView[]>('GET', `/api/tasks/${taskId}/specs`),
  saveSpec: (taskId: string, body_md: string) =>
    request<SpecView>('POST', `/api/tasks/${taskId}/specs`, { body_md }),
  approve: (specId: string) =>
    request<{ spec: SpecView; run_id: string }>('POST', `/api/specs/${specId}/approve`),
  runs: (taskId: string) => request<RunView[]>('GET', `/api/tasks/${taskId}/runs`),
  approvals: (taskId: string) => request<ApprovalView[]>('GET', `/api/tasks/${taskId}/approvals`),
  openApprovals: () => request<OpenApproval[]>('GET', '/api/approvals?status=open'),
  answer: (approvalId: string, body: ApprovalAnswer | BatchAnswer) =>
    request<ApprovalView>('POST', `/api/approvals/${approvalId}/answer`, body),
  costs: (taskId: string) => request<CostSummary>('GET', `/api/tasks/${taskId}/costs`),
  /** `files` is null when GitHub did not list them. */
  prFiles: (runId: string) =>
    request<{ files: PrFile[] | null }>('GET', `/api/runs/${runId}/files`),
  async events(runId: string): Promise<EventView[]> {
    const all: EventView[] = []
    let after: string | null = null
    do {
      const query: string = after === null ? '' : `&after=${encodeURIComponent(after)}`
      const page: { events: EventView[]; next: string | null } = await request(
        'GET',
        `/api/runs/${runId}/events?limit=1000${query}`,
      )
      all.push(...page.events)
      after = page.next
    } while (after !== null)
    return all
  },
}
