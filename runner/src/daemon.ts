import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardApi } from './api.js'
import { ConfigurationError, loadRunnerConfig, type RunnerConfig } from './config.js'
import type { RunKind, Work } from './contract.js'
import { carryOut, cleanUp, type Outcome, type Phases } from './delivery.js'
import { draftSpec } from './drafting.js'
import { realExec } from './exec.js'
import { checkExecutable } from './executable.js'
import { runnerCode } from './fingerprint.js'
import { carryHelp, HELP_SLOTS } from './help.js'
import { suggestTitle } from './titling.js'
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

/** The main loop claims these; the title loop claims `title` and nothing else. */
const MAIN_KINDS: readonly RunKind[] = ['spec', 'delivery']
const TITLE_KINDS: readonly RunKind[] = ['title']

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
  /** Set once either loop has seen the code move: neither sends a new claim request. */
  private moved = false
  /** Aborted when the daemon exits: a title run in flight ends failed, "the runner stopped". */
  private readonly titleStop = new AbortController()
  private codeCheck: Promise<boolean> | null = null
  /** The title loop, running, so an exit can wait for it. */
  private titleLane: Promise<void> = Promise.resolve()
  /** Aborted when the daemon restarts on moved code: a help in flight ends failed at once. */
  private readonly helpStop = new AbortController()
  /** The help loop, running, so an exit can wait for it. */
  private helpLane: Promise<void> = Promise.resolve()

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
  ): Promise<Outcome | 'drafted' | 'suggested' | 'cleaned' | 'handed' | false> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs, MAIN_KINDS)
    if (work === null) return false
    if (work.kind === 'cleanup') {
      await this.cleanUp(work)
      return 'cleaned'
    }
    const claimedAt = this.now()
    if (this.moved || (await this.sawMovedCode())) {
      const heard = await this.holdWhile(work.run.id, claimedAt, () => this.quiesceLanes())
      this.handOff(work, heard)
      return 'handed'
    }
    return this.carryWork(work, shutdown)
  }

  /**
   * The title lane's turn: claims a title run, or the cleanup of one, and carries it out beside
   * whatever the main loop is doing. A title claim is never handed on: once the code has moved,
   * or the daemon is exiting, it ends failed, "the runner stopped".
   */
  async runTitleOnce(
    shutdown?: AbortSignal,
  ): Promise<'suggested' | 'failed' | 'cancelled' | 'released' | 'cleaned' | false> {
    const work = await this.api.claim(this.config.runnerId, this.config.claimWaitMs, TITLE_KINDS)
    if (work === null) return false
    if (work.kind === 'cleanup') {
      await this.cleanUp(work)
      return 'cleaned'
    }
    if (work.kind !== 'start') throw new Error('a title run is never resumed')
    const stopping = new AbortController()
    if (this.moved || (await this.sawMovedCode())) stopping.abort()
    const signals = [this.titleStop.signal, stopping.signal, ...(shutdown ? [shutdown] : [])]
    const outcome = await this.carryWork(work, AbortSignal.any(signals))
    return outcome as 'suggested' | 'failed' | 'cancelled' | 'released'
  }

  /** Never handed on: a cleanup runs no hook, so the old code carries it out. */
  private async cleanUp(work: Extract<Work, { kind: 'cleanup' }>): Promise<void> {
    await cleanUp(work, {
      git: this.git,
      config: this.config,
      ...(this.overrides.clock === undefined ? {} : { clock: this.overrides.clock }),
    })
  }

  /** `movedCode`, remembered: the first loop to see it stops both from claiming. */
  private async sawMovedCode(): Promise<boolean> {
    if (this.moved) return true
    // Both loops ask at once: they share the one check, and so its one settle wait.
    this.codeCheck ??= this.movedCode().finally(() => {
      this.codeCheck = null
    })
    if (await this.codeCheck) this.moved = true
    return this.moved
  }

  /**
   * Whether the runner's code has moved since this daemon started. One read equal to the start
   * fingerprint ends the check; a read that differs is read again after a wait, and counts only
   * if the second read agrees (a pull or an edit still in progress does not). A read that fails,
   * as one does when a pull removes a file mid-read, differs and never agrees.
   */
  async movedCode(): Promise<boolean> {
    const first = this.readCode()
    if (first === this.startCode) return false
    await (
      this.overrides.settle ?? (() => new Promise<void>((done) => setTimeout(done, SETTLE_MS)))
    )()
    const second = this.readCode()
    return first !== null && second === first
  }

  private readCode(): string | null {
    try {
      return this.fingerprint()
    } catch {
      return null
    }
  }

  private exit(status: number): void {
    this.exiting = true
    ;(this.overrides.exit ?? ((code: number) => process.exit(code)))(status)
  }

  private now(): Date {
    return (this.overrides.clock ?? (() => new Date()))()
  }

  /**
   * Runs `wait` while heartbeating a claimed run nobody is carrying out yet, so the sweeper does
   * not lose it, and heartbeats it once more at the end. Resolves to when the board last heard
   * of the run: `since`, the claim, if no heartbeat got through.
   */
  private async holdWhile(runId: string, since: Date, wait: () => Promise<void>): Promise<Date> {
    let heard = since
    const beat = async () => {
      const sent = this.now()
      await this.api.heartbeat(this.config.runnerId, [runId]).then(
        () => {
          if (sent > heard) heard = sent
        },
        () => undefined,
      )
    }
    const timer = setInterval(() => void beat(), this.config.heartbeatMs)
    try {
      await wait()
    } finally {
      clearInterval(timer)
    }
    await beat()
    return heard
  }

  /**
   * Leaves a claimed start or resume to the daemon that replaces this one, then exits.
   * `claimed_at` is when the board last heard of the run, which the sweeper counts from.
   */
  private handOff(work: Extract<Work, { kind: 'start' | 'resume' }>, heard: Date): void {
    const temporary = `${this.handoffPath}.tmp`
    writeFileSync(temporary, JSON.stringify({ work, claimed_at: heard.toISOString() }))
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
  ): Promise<Outcome | 'drafted' | 'suggested'> {
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
      if (work.run.kind === 'title') {
        if (work.kind !== 'start') throw new Error('a title run is never resumed')
        return await suggestTitle(work, deps)
      }
      return work.run.kind === 'spec'
        ? await draftSpec(work, deps)
        : await carryOut(work, { ...deps, runTests: deps.runTests })
    } finally {
      clearInterval(heartbeat)
    }
  }

  /**
   * Until `stop`: two claim loops. The main one claims spec and delivery runs; a stop mid-run
   * blocks that run, which Resume continues (spec §8). The title one claims title runs, beside
   * the run the main loop carries; a stop mid-run fails a title run. A third loop carries helps
   * beside both, never more than `HELP_SLOTS` at once, claiming while the run slot is busy and
   * while it is idle.
   */
  async loop(stop: AbortSignal): Promise<void> {
    await this.takeOverClaim(stop)
    this.titleLane = this.titleLoop(stop)
    this.helpLane = this.helpLoop(stop)
    await this.mainLoop(stop)
    await Promise.all([this.titleLane, this.helpLane])
  }

  private async mainLoop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted && !this.exiting) {
      if (await this.sawMovedCode()) {
        console.log("board-cli: the runner's code changed; restarting")
        await this.quiesceLanes()
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

  /**
   * Before the daemon exits with the main loop idle or its claim handed on: a title run in
   * flight is stopped, and so ends failed, "the runner stopped"; an open title claim is waited
   * for, at most the claim wait.
   */
  private async quiesceTitleLane(): Promise<void> {
    this.titleStop.abort()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      this.titleLane,
      new Promise<void>((done) => {
        timer = setTimeout(done, this.config.claimWaitMs + this.config.stopGraceMs)
      }),
    ])
    clearTimeout(timer)
  }

  /**
   * Before the daemon exits on moved code: both lanes are stopped. A running help ends at once,
   * failed "runner restarted" (once the code moved the guard refuses even its saving call, so it
   * could never finish), and a claim still open is waited for, at most the claim wait.
   */
  private async quiesceLanes(): Promise<void> {
    this.helpStop.abort()
    await Promise.all([this.quiesceTitleLane(), this.quiesceHelpLane()])
  }

  private async quiesceHelpLane(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      this.helpLane,
      new Promise<void>((done) => {
        timer = setTimeout(done, this.config.claimWaitMs + this.config.stopGraceMs + 5_000)
      }),
    ])
    clearTimeout(timer)
  }

  /**
   * Carries helps. A help is never handed on through the handoff file: one claimed once the code
   * has moved is given back to the board, queued again, and the new daemon claims it as usual.
   */
  async helpLoop(stop: AbortSignal): Promise<void> {
    const running = new Set<Promise<void>>()
    const idle = () => stop.aborted || this.exiting || this.moved || this.helpStop.signal.aborted
    while (!idle()) {
      if (running.size >= HELP_SLOTS) {
        await Promise.race(running)
        continue
      }
      try {
        if (await this.sawMovedCode()) break
        const work = await this.api.claimHelp(this.config.runnerId, this.config.claimWaitMs)
        if (work === null) continue
        if (idle() || (await this.sawMovedCode())) {
          await this.api.releaseHelp(work.id, this.config.runnerId).catch(() => undefined)
          break
        }
        const carried: Promise<void> = carryHelp(work, {
          api: this.api,
          config: this.config,
          runnerCode: this.startCode,
          shutdown: stop,
          restart: this.helpStop.signal,
        })
          .catch((error: unknown) => {
            console.error(
              `board-cli: help ${work.id}: ${error instanceof Error ? error.message : String(error)}`,
            )
            return this.api.failHelp(work.id, 'the helper could not run').catch(() => undefined)
          })
          .finally(() => running.delete(carried))
        running.add(carried)
      } catch (error) {
        console.error(
          `board-cli: ${error instanceof Error ? error.message : String(error)}; retrying in ${BACKOFF_MS / 1000}s`,
        )
        await new Promise((done) => setTimeout(done, BACKOFF_MS))
      }
    }
    // The code moved: a help in hand cannot finish, so it ends now rather than at the exit.
    if (this.moved) this.helpStop.abort()
    await Promise.all(running)
  }

  private async titleLoop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted && !this.exiting && !this.moved && !this.titleStop.signal.aborted) {
      if (await this.sawMovedCode()) return
      try {
        await this.runTitleOnce(stop)
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
  let config: RunnerConfig
  try {
    config = loadRunnerConfig(process.env)
    checkExecutable('CLAUDE_BIN', config.claudeBin, process.env.PATH)
    checkExecutable('GH_BIN', config.ghBin, process.env.PATH)
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error
    console.error(`board-cli: ${error.message}`)
    process.exit(1)
  }
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
  console.log(`board-cli: runner ${config.runnerId} claiming from ${config.boardUrl}`)
  await new Daemon(config).loop(stop.signal)
}
