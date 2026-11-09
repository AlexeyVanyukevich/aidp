import type { HelpWork, RunKind, RunnerEvent, RunView, Work } from './contract.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = undefined,
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
    if (!response.ok) {
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
      throw new ApiError(
        response.status,
        `${method} ${path} answered ${response.status}: ${text}`,
        body,
      )
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }

  /** `kinds` limits the claim to those run kinds; absent, the board offers `spec` and `delivery`. */
  async claim(runnerId: string, waitMs: number, kinds?: readonly RunKind[]): Promise<Work | null> {
    return (
      await this.call<{ work: Work | null }>(
        'POST',
        '/api/runner/claim',
        this.runnerKey,
        { runner_id: runnerId, wait_ms: waitMs, ...(kinds === undefined ? {} : { kinds }) },
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

  async claimHelp(runnerId: string, waitMs: number): Promise<HelpWork | null> {
    return (
      await this.call<{ help: HelpWork | null }>(
        'POST',
        '/api/runner/helps/claim',
        this.runnerKey,
        { runner_id: runnerId, wait_ms: waitMs },
        waitMs + CLAIM_MARGIN_MS,
      )
    ).help
  }

  /** Which of these help runs have ended, so their leftovers can be removed. */
  async helpsEnded(runIds: string[]): Promise<string[]> {
    return (
      await this.call<{ ended: string[] }>('POST', '/api/runner/helps/ended', this.runnerKey, {
        run_ids: runIds,
      })
    ).ended
  }

  /** A help's own heartbeat; the board names the helps to end. */
  helpHeartbeat(runnerId: string, helpIds: string[]): Promise<{ stop: string[] }> {
    return this.call('POST', '/api/runner/helps/heartbeat', this.runnerKey, {
      runner_id: runnerId,
      help_ids: helpIds,
    })
  }

  async issueHelpToken(helpId: string): Promise<string> {
    return (
      await this.call<{ token: string }>(
        'POST',
        `/api/runner/helps/${helpId}/tokens`,
        this.runnerKey,
      )
    ).token
  }

  /** The process ended without a result. The board ignores it for a help that saved or stopped. */
  async failHelp(helpId: string, reason: string): Promise<void> {
    await this.call<void>('POST', `/api/runner/helps/${helpId}/fail`, this.runnerKey, { reason })
  }

  /** Gives a claimed help back: it is queued again, for any daemon to claim. */
  async releaseHelp(helpId: string, runnerId: string): Promise<void> {
    await this.call<void>('POST', `/api/runner/helps/${helpId}/release`, this.runnerKey, {
      runner_id: runnerId,
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

  /**
   * Whether the board recorded a message in the phase: a session that is gone and held none was
   * killed before it wrote one, and nothing is lost by starting it again (spec §6).
   */
  async phaseHasMessages(runId: string, phaseId: string): Promise<boolean> {
    let after: string | null = null
    do {
      const query: string = after === null ? '' : `&after=${encodeURIComponent(after)}`
      const page: { events: Pick<RunnerEvent, 'type' | 'phase_id'>[]; next: string | null } =
        await this.call('GET', `/api/runs/${runId}/events?limit=1000${query}`, undefined)
      if (page.events.some((e) => e.phase_id === phaseId && e.type === 'message')) return true
      after = page.next
    } while (after !== null)
    return false
  }

  async sendEvents(token: string, events: RunnerEvent[]): Promise<number> {
    return (await this.call<{ accepted: number }>('POST', '/api/runner/events', token, { events }))
      .accepted
  }

  async retire(token: string): Promise<void> {
    await this.call<void>('POST', '/api/runner/tokens/retire', token)
  }
}
