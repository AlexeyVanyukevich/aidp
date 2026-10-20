import { join } from 'node:path'
import { BoardApi } from './api.js'
import { loadRunnerConfig, type RunnerConfig } from './config.js'
import { carryOut, cleanUp, type Outcome, type Phases } from './delivery.js'
import { realExec } from './exec.js'
import { Git } from './git.js'
import { continuePhase, endPhase, restartPhase, startPhase } from './phases/phase.js'
import { EventSink } from './sink.js'
import { runTestCommand } from './test-command.js'

const BACKOFF_MS = 5_000

const PHASES: Phases = {
  start: startPhase,
  resume: continuePhase,
  restart: restartPhase,
  end: endPhase,
}

export class Daemon {
  private readonly api: BoardApi
  private readonly git: Git

  constructor(
    private readonly config: RunnerConfig,
    private readonly overrides: Partial<{
      api: BoardApi
      git: Git
      phases: Phases
      runTests: typeof runTestCommand
    }> = {},
  ) {
    this.api = overrides.api ?? new BoardApi(config.boardUrl, config.runnerKey)
    this.git = overrides.git ?? new Git(realExec, config.ghBin)
  }

  /**
   * Claims one piece of work and carries it out. `false` when there was nothing to claim. A run
   * that pauses or blocks is released: the daemon goes back to claiming, and the run comes back
   * as a resume (slice 2 spec, §6).
   */
  async runOnce(shutdown?: AbortSignal): Promise<Outcome | 'cleaned' | false> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs)
    if (work === null) return false
    if (work.kind === 'cleanup') {
      await cleanUp(work, { git: this.git })
      return 'cleaned'
    }
    const runId = work.run.id
    const controller = new AbortController()
    let pauseAsked = false
    const heartbeat = setInterval(() => {
      this.api
        .heartbeat(this.config.runnerId, [runId])
        .then(({ cancel, pause }) => {
          if (cancel.includes(runId)) controller.abort()
          if (pause.includes(runId)) pauseAsked = true
        })
        .catch(() => undefined)
    }, this.config.heartbeatMs)
    let token = ''
    try {
      return await carryOut(work, {
        api: this.api,
        git: this.git,
        sink: new EventSink(
          this.api,
          join(this.config.home, 'runs', runId, 'events.ndjson'),
          () => token,
        ),
        setToken: (next: string) => {
          token = next
        },
        phases: this.overrides.phases ?? PHASES,
        runTests: this.overrides.runTests ?? runTestCommand,
        config: this.config,
        signal: controller.signal,
        ...(shutdown === undefined ? {} : { shutdown }),
        pauseRequested: () => pauseAsked,
      })
    } finally {
      clearInterval(heartbeat)
    }
  }

  /** Until `stop`: a stop mid-run blocks that run, which Resume continues (spec §8). */
  async loop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      try {
        await this.runOnce(stop)
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
