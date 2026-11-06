import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { loadRunnerConfig, type RunnerConfig } from './config.js'
import type { Work } from './contract.js'
import { carryOut, cleanUp, type Outcome, type Phases } from './delivery.js'
import { draftSpec } from './drafting.js'
import { realExec } from './exec.js'
import { runnerCode } from './fingerprint.js'
import { Git } from './git.js'
import { continuePhase, endPhase, restartPhase, startPhase } from './phases/phase.js'
import { EventSink } from './sink.js'
import { runTestCommand } from './test-command.js'

const BACKOFF_MS = 5_000
/** The exit status that tells the wrapper to start the daemon again. */
export const RESTART_STATUS = 75
const SETTLE_MS = 2_000
/** A claim older than this is the sweeper's: the run is blocked as `runner_lost`. */
const HANDOFF_FRESH_MS = 60_000

const PHASES: Phases = {
  start: startPhase,
  resume: continuePhase,
  restart: restartPhase,
  end: endPhase,
}

export class Daemon {
  private readonly api: BoardApi
  private readonly git: Git
  private readonly fingerprint: () => string
  private readonly startCode: string
  private readonly handoffPath: string
  /** Set once the daemon has asked to exit: nothing more is claimed. */
  private exiting = false

  constructor(
    private readonly config: RunnerConfig,
    private readonly overrides: Partial<{
      api: BoardApi
      git: Git
      phases: Phases
      runTests: typeof runTestCommand
      clock: () => Date
      fingerprint: () => string
      exit: (status: number) => void
      /** The wait between the two reads of the moved-code check. */
      settle: () => Promise<void>
      handoffPath: string
    }> = {},
  ) {
    this.fingerprint = overrides.fingerprint ?? runnerCode
    this.startCode = this.fingerprint()
    this.handoffPath = overrides.handoffPath ?? join(config.home, 'handoff.json')
    this.api = overrides.api ?? new BoardApi(config.boardUrl, config.runnerKey)
    this.git = overrides.git ?? new Git(realExec, config.ghBin)
  }

  /**
   * Claims one piece of work and carries it out. `false` when there was nothing to claim. A run
   * that pauses or blocks is released: the daemon goes back to claiming, and the run comes back
   * as a resume (slice 2 spec, §6).
   */
  async runOnce(
    shutdown?: AbortSignal,
  ): Promise<Outcome | 'drafted' | 'cleaned' | 'handed' | false> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs)
    if (work === null) return false
    if (work.kind === 'cleanup') {
      // Never handed on: it runs no hook, so the old code carries it out.
      await cleanUp(work, {
        git: this.git,
        config: this.config,
        ...(this.overrides.clock === undefined ? {} : { clock: this.overrides.clock }),
      })
      return 'cleaned'
    }
    if (await this.movedCode()) {
      this.handOff(work)
      return 'handed'
    }
    return this.carryWork(work, shutdown)
  }

  /**
   * Whether the runner's code has moved since this daemon started. One read equal to the start
   * fingerprint ends the check; a read that differs is read again after a wait, and counts only
   * if the second read agrees (a pull or an edit still in progress does not).
   */
  async movedCode(): Promise<boolean> {
    const first = this.fingerprint()
    if (first === this.startCode) return false
    await (
      this.overrides.settle ?? (() => new Promise<void>((done) => setTimeout(done, SETTLE_MS)))
    )()
    return this.fingerprint() === first
  }

  private exit(status: number): void {
    this.exiting = true
    ;(this.overrides.exit ?? ((code: number) => process.exit(code)))(status)
  }

  private now(): Date {
    return (this.overrides.clock ?? (() => new Date()))()
  }

  /** Leaves a claimed start or resume to the daemon that replaces this one, then exits. */
  private handOff(work: Extract<Work, { kind: 'start' | 'resume' }>): void {
    const temporary = `${this.handoffPath}.tmp`
    writeFileSync(temporary, JSON.stringify({ work, claimed_at: this.now().toISOString() }))
    renameSync(temporary, this.handoffPath)
    console.log("board-cli: the runner's code changed; handed the claim on and restarting")
    this.exit(RESTART_STATUS)
  }

  /**
   * At start: carries out the claim the previous daemon handed on, if it is fresh and the board
   * still wants it. The file goes first, so a crash cannot carry the same work out twice.
   */
  async takeOverClaim(shutdown?: AbortSignal): Promise<void> {
    if (!existsSync(this.handoffPath)) return
    const discard = (why: string) => console.log(`board-cli: handoff discarded: ${why}`)
    let text: string
    try {
      text = readFileSync(this.handoffPath, 'utf8')
    } catch (error) {
      rmSync(this.handoffPath, { force: true, recursive: true })
      discard(`the file could not be read (${error instanceof Error ? error.message : error})`)
      return
    }
    rmSync(this.handoffPath, { force: true, recursive: true })
    let work: Work
    let claimedAt: number
    try {
      const parsed = JSON.parse(text) as { work: Work; claimed_at: string }
      work = parsed.work
      claimedAt = Date.parse(parsed.claimed_at)
      if (typeof work !== 'object' || work === null || Number.isNaN(claimedAt))
        throw new Error('unexpected shape')
    } catch {
      discard('the file could not be parsed')
      return
    }
    if (work.kind !== 'start' && work.kind !== 'resume') {
      discard(`it holds a ${String((work as { kind: unknown }).kind)}, which is never handed on`)
      return
    }
    if (this.now().getTime() - claimedAt >= HANDOFF_FRESH_MS) {
      discard('the claim is 60 s old or older; the sweeper blocks the run')
      return
    }
    try {
      const { cancel } = await this.api.heartbeat(this.config.runnerId, [work.run.id])
      if (cancel.includes(work.run.id)) {
        discard('the board no longer wants the run')
        return
      }
      await this.carryWork(work, shutdown)
    } catch (error) {
      console.error(
        `board-cli: handed-on work failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async carryWork(
    work: Extract<Work, { kind: 'start' | 'resume' }>,
    shutdown?: AbortSignal,
  ): Promise<Outcome | 'drafted'> {
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
      const deps = {
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
        runnerCode: this.startCode,
        currentCode: this.fingerprint,
        signal: controller.signal,
        ...(shutdown === undefined ? {} : { shutdown }),
        pauseRequested: () => pauseAsked,
        ...(this.overrides.clock === undefined ? {} : { clock: this.overrides.clock }),
      }
      // A draft or a delivery: the same machinery, different stages (slice 3 spec, §5).
      return work.run.kind === 'spec'
        ? await draftSpec(work, deps)
        : await carryOut(work, { ...deps, runTests: deps.runTests })
    } finally {
      clearInterval(heartbeat)
    }
  }

  /** Until `stop`: a stop mid-run blocks that run, which Resume continues (spec §8). */
  async loop(stop: AbortSignal): Promise<void> {
    await this.takeOverClaim(stop)
    while (!stop.aborted && !this.exiting) {
      if (await this.movedCode()) {
        console.log("board-cli: the runner's code changed; restarting")
        this.exit(RESTART_STATUS)
        return
      }
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
