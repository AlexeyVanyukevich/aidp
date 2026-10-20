import type { RunnerEvent, RunView, Work } from './contract.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Every request but a claim, whose own wait comes first. */
const REQUEST_TIMEOUT_MS = 30_000
const CLAIM_MARGIN_MS = 10_000

export class BoardApi {
  constructor(
    private readonly baseUrl: string,
    private readonly runnerKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * A request the board never answers — a connection left dead by a sleep — fails after
   * `timeoutMs` as a `TypeError`, as an unreachable board does, so callers retry it alike.
   */
  private async call<T>(
    method: string,
    path: string,
    credential: string | undefined,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      if (controller.signal.aborted)
        throw new TypeError(`${method} ${path}: the board did not answer within ${timeoutMs} ms`)
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        `${method} ${path} answered ${response.status}: ${await response.text()}`,
      )
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  async claim(runnerId: string, waitMs: number): Promise<Work | null> {
    return (
      await this.call<{ work: Work | null }>(
        'POST',
        '/api/runner/claim',
        this.runnerKey,
        { runner_id: runnerId, wait_ms: waitMs },
        waitMs + CLAIM_MARGIN_MS,
      )
    ).work
  }

  /** The runs to stop, and the runs the board paused (spec §6, §8). */
  heartbeat(runnerId: string, runIds: string[]): Promise<{ cancel: string[]; pause: string[] }> {
    return this.call('POST', '/api/runner/heartbeat', this.runnerKey, {
      runner_id: runnerId,
      run_ids: runIds,
    })
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
