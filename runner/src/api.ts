import type { RunnerEvent, RunView, Work } from './contract.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class BoardApi {
  constructor(
    private readonly baseUrl: string,
    private readonly runnerKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    credential: string | undefined,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok)
      throw new ApiError(
        response.status,
        `${method} ${path} answered ${response.status}: ${await response.text()}`,
      )
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  async claim(runnerId: string, waitMs: number): Promise<Work | null> {
    return (
      await this.call<{ work: Work | null }>('POST', '/api/runner/claim', this.runnerKey, {
        runner_id: runnerId,
        wait_ms: waitMs,
      })
    ).work
  }

  async heartbeat(runnerId: string, runIds: string[]): Promise<string[]> {
    return (
      await this.call<{ cancel: string[] }>('POST', '/api/runner/heartbeat', this.runnerKey, {
        runner_id: runnerId,
        run_ids: runIds,
      })
    ).cancel
  }

  async issueToken(runId: string): Promise<string> {
    return (
      await this.call<{ token: string }>('POST', `/api/runner/runs/${runId}/tokens`, this.runnerKey)
    ).token
  }

  getRun(runId: string): Promise<RunView> {
    return this.call<RunView>('GET', `/api/runs/${runId}`, undefined)
  }

  async sendEvents(token: string, events: RunnerEvent[]): Promise<number> {
    return (await this.call<{ accepted: number }>('POST', '/api/runner/events', token, { events }))
      .accepted
  }

  async retire(token: string): Promise<void> {
    await this.call<void>('POST', '/api/runner/tokens/retire', token)
  }
}
