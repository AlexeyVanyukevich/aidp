import { join } from 'node:path'
import { BoardApi } from './api.js'
import { loadRunnerConfig, type RunnerConfig } from './config.js'
import { runDelivery } from './delivery.js'
import { realExec } from './exec.js'
import { Git } from './git.js'
import { runPhase } from './phases/phase.js'
import { EventSink } from './sink.js'
import { runTestCommand } from './test-command.js'

const BACKOFF_MS = 5_000

export class Daemon {
  private readonly api: BoardApi
  private readonly git: Git

  constructor(
    private readonly config: RunnerConfig,
    private readonly overrides: Partial<{
      api: BoardApi
      git: Git
      runPhase: typeof runPhase
      runTests: typeof runTestCommand
    }> = {},
  ) {
    this.api = overrides.api ?? new BoardApi(config.boardUrl, config.runnerKey)
    this.git = overrides.git ?? new Git(realExec, config.ghBin)
  }

  /** Claims one run and carries it out. `false` when there was nothing to claim. */
  async runOnce(): Promise<boolean> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs)
    if (work === null) return false
    // Resumes and cleanups are carried out once delivery runs in stages (slice 2, Task 20).
    if (work.kind !== 'start') throw new Error(`this runner cannot yet carry out ${work.kind} work`)
    const controller = new AbortController()
    const heartbeat = setInterval(() => {
      this.api
        .heartbeat(this.config.runnerId, [work.run.id])
        .then((cancel) => {
          if (cancel.includes(work.run.id)) controller.abort()
        })
        .catch(() => undefined)
    }, this.config.heartbeatMs)
    let token = ''
    try {
      await runDelivery(work, {
        api: this.api,
        git: this.git,
        sink: new EventSink(
          this.api,
          join(this.config.home, 'runs', work.run.id, 'events.ndjson'),
          () => token,
        ),
        setToken: (next) => {
          token = next
        },
        runPhase: this.overrides.runPhase ?? runPhase,
        runTests: this.overrides.runTests ?? runTestCommand,
        config: this.config,
        signal: controller.signal,
      })
    } finally {
      clearInterval(heartbeat)
    }
    return true
  }

  async loop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      try {
        await this.runOnce()
      } catch (error) {
        console.error(
          `board-cli: ${error instanceof Error ? error.message : String(error)}; retrying in ${BACKOFF_MS / 1000}s`,
        )
        await new Promise((done) => setTimeout(done, BACKOFF_MS))
      }
    }
  }
}

export async function main(): Promise<void> {
  const config = loadRunnerConfig(process.env)
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
  console.log(`board-cli: runner ${config.runnerId} claiming from ${config.boardUrl}`)
  await new Daemon(config).loop(stop.signal)
}
