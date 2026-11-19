import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { RunnerConfig } from './config.js'
import type { HelpWork, SessionTotals } from './contract.js'
import type { Git } from './git.js'
import {
  LINKED_FILE,
  prepareLinked,
  readLinked,
  removeLinked,
  type LinkedCheckout,
} from './linked.js'
import { diffSections, type DiffSection } from './pr-diff.js'
import { deleteRunDirectory, removeCheckout, type LogContext } from './worktree-log.js'
import { newEvent, EventSink } from './sink.js'
import { PHASES } from './phases/agents.js'
import { attr, escape, linkedProjects } from './phases/handoff.js'
import { runPaths } from './run-steps.js'
import { runProcess, type ProcessResult, type ProcessTiming } from './phases/process.js'
import { HELP_SAVED_MARKER, prepareRunDir } from './phases/run-dir.js'
import { PR_DIFF } from './hooks/guard.js'

/** Helps a runner carries at once, beside its run. */
export const HELP_SLOTS = 3

/** Why a help a restart cut off is failed. */
export const RESTART_REASON = 'runner restarted'

/** What a helper that ended without saving is told, in the one resume it gets. */
const RESAVE_MESSAGE =
  'Nothing was saved: your closing text does not reach the owner. Call save_help_result now with the advice you already wrote, then end your turn.'

const TIMING: ProcessTiming = { pauseGraceMs: 60_000, stopGraceMs: 10_000, markerPollMs: 500 }

/** The last line of a helper's first message: the result reaches the owner only by being saved. */
const SAVE_LINE = 'Save your result with save_help_result, then end your turn.'

/** The first message of a helper: its mode, and the question or decision it is for. */
export function helpPrompt(work: HelpWork, checkout?: CheckoutMade): string {
  const lines = [`<task key="${attr(work.run.task.key)}">${escape(work.run.task.title)}</task>`]
  if (isQuestion(work)) {
    const asked =
      work.question_index === null ? 'the open question' : `question ${work.question_index + 1}`
    lines.push(
      `Mode: ${work.mode}.`,
      work.mode === 'suggest_all'
        ? 'Suggest an answer to every question of the batch the run is waiting on the owner for. Read them with get_question.'
        : work.mode === 'suggest'
          ? `Suggest an answer to ${asked} of the run waiting on the owner. Read it with get_question.`
          : `Explain ${asked} of the run waiting on the owner in plain words. Read it with get_question.`,
    )
    lines.push(SAVE_LINE)
    return lines.join('\n')
  }
  lines.push(
    `Decision: ${work.decision ?? 'question'}. Mode: ${work.mode}. Read it with get_decision.`,
  )
  if (checkout !== undefined)
    lines.push(`<checkout ref="${attr(checkout.ref)}" source="${attr(checkout.source)}"/>`)
  if (checkout?.diff !== undefined) {
    const { path, bytes, lines: count, files } = checkout.diff
    lines.push(`<diff path="${attr(path)}" bytes="${bytes}" lines="${count}"/>`)
    lines.push(
      `<changed_files>\n${files
        .map(
          (file) =>
            `<file path="${attr(file.path)}" first_line="${file.first_line}" lines="${file.lines}"${file.skip === undefined ? '' : ` skip="${file.skip}"`}/>`,
        )
        .join('\n')}\n</changed_files>`,
    )
  }
  const linked = checkout?.linked ?? []
  if (linked.length > 0)
    lines.push(linkedProjects(linked), 'The linked checkouts may be read and never changed.')
  lines.push(SAVE_LINE)
  return lines.join('\n')
}

/** The payload of a decision help's `help_checkout` event; a review's names the skipped files. */
export function checkoutPayload(made: CheckoutMade): Record<string, unknown> {
  return {
    source: made.source,
    fallback: made.fallback,
    commit: made.commit,
    ...(made.diff === undefined
      ? {}
      : {
          skipped: made.diff.files.flatMap((file) =>
            file.skip === undefined ? [] : [{ path: file.path, skip: file.skip }],
          ),
        }),
  }
}

/** A help from before decisions, or one for a waiting request. */
const isQuestion = (work: HelpWork) => (work.decision ?? 'question') === 'question'

/** What a decision help's checkout came to. */
export interface CheckoutMade {
  worktree: string
  runDir: string
  /** The ref the helper reads. */
  ref: string
  source: 'base' | 'pr_branch' | 'paused_run' | 'pull_request'
  /** Whether the source named was not there and the base was read instead. */
  fallback: boolean
  madeWorktree: boolean
  /** The full hash of HEAD in the worktree the helper reads. */
  commit: string
  /** The checkouts `linked.json` lists. */
  linked: LinkedCheckout[]
  /** The pull request's diff, written to `pr.diff` in the run directory; a review only. */
  diff?: { path: string; bytes: number; lines: number; files: DiffSection[] }
}

/** The file in a help's run directory that says what the help made, for its removal. */
export const HELP_FILE = 'help.json'

interface HelpMarker {
  repo_path: string
  made_worktree: boolean
}

function readMarker(runDir: string): HelpMarker | null {
  try {
    const value = JSON.parse(readFileSync(join(runDir, HELP_FILE), 'utf8')) as Partial<HelpMarker>
    if (typeof value.repo_path === 'string' && typeof value.made_worktree === 'boolean')
      return { repo_path: value.repo_path, made_worktree: value.made_worktree }
  } catch {
    // Unreadable: nothing is known to have been made, so nothing but the directory goes.
  }
  return null
}

/**
 * Makes a decision help's checkout (R9). `help.json` is written before anything is made, so a
 * killed daemon's leftovers can be cleared by what it says.
 */
export async function prepareHelpCheckout(
  work: HelpWork,
  git: Git,
  home: string,
  removals: LogContext,
): Promise<CheckoutMade> {
  const decision = work.decision_work ?? null
  if (decision === null) throw new Error('a question help has no checkout to make')
  const { worktree, runDir, linked } = runPaths(home, work.run.id)
  const source = decision.checkout
  const paused = source.source === 'paused_run' ? runPaths(home, source.run_id) : null
  const reuse = paused !== null && existsSync(paused.worktree)
  prepareRunDir(runDir)
  writeFileSync(
    join(runDir, HELP_FILE),
    JSON.stringify({ repo_path: decision.repo_path, made_worktree: !reuse }),
  )
  if (reuse && paused !== null) {
    writeFileSync(join(runDir, LINKED_FILE), JSON.stringify(readLinked(paused.runDir)))
    return {
      worktree: paused.worktree,
      runDir,
      ref: `worktree:${source.source === 'paused_run' ? source.run_id : ''}`,
      source: 'paused_run',
      fallback: false,
      madeWorktree: false,
      commit: await git.head(paused.worktree),
      linked: readLinked(runDir),
    }
  }
  let ref = `origin/${decision.base_branch}`
  let fallback = source.source === 'paused_run'
  if (source.source === 'pull_request') {
    // A review never falls back to the base: there would be nothing of the pull request to read.
    if ((await git.fetchBranch(decision.repo_path, source.branch)) === 'missing')
      throw new Error(`the branch \`${source.branch}\` is not on origin`)
    await git.fetchBase(decision.repo_path, decision.base_branch)
    ref = `origin/${source.branch}`
    const { diff, paths } = await git.pullRequestDiff(
      decision.repo_path,
      decision.base_branch,
      source.branch,
    )
    const files = diffSections(diff, paths)
    const path = join(runDir, PR_DIFF)
    writeFileSync(path, diff)
    await git.prepareDetachedRef(decision.repo_path, ref, worktree)
    await prepareLinked(git, decision.links, linked, runDir, removals)
    return {
      worktree,
      runDir,
      ref,
      source: 'pull_request',
      fallback: false,
      madeWorktree: true,
      commit: await git.head(worktree),
      linked: readLinked(runDir),
      diff: {
        path,
        bytes: Buffer.byteLength(diff),
        lines: diff === '' ? 0 : diff.split('\n').length - (diff.endsWith('\n') ? 1 : 0),
        files,
      },
    }
  }
  if (source.source === 'pr_branch') {
    const fetched = await git.fetchBranch(decision.repo_path, source.branch)
    if (fetched === 'fetched') ref = `origin/${source.branch}`
    else fallback = true
  }
  if (ref === `origin/${decision.base_branch}`)
    await git.fetchBase(decision.repo_path, decision.base_branch)
  await git.prepareDetachedRef(decision.repo_path, ref, worktree)
  await prepareLinked(git, decision.links, linked, runDir, removals)
  return {
    worktree,
    runDir,
    ref,
    source: source.source,
    fallback,
    madeWorktree: true,
    commit: await git.head(worktree),
    linked: readLinked(runDir),
  }
}

/**
 * What the end of a decision help removes: when it made its worktree, the checkouts its
 * `linked.json` lists, the `-linked` directory and the worktree, with the git registrations
 * pruned; in every case, its run directory. A worktree it did not make is never touched.
 */
export async function cleanUpHelp(git: Git, home: string, runId: string): Promise<void> {
  const { worktree, runDir, linked } = runPaths(home, runId)
  const removals: LogContext = { home, runId, clock: () => new Date() }
  const marker = readMarker(runDir)
  if (marker !== null && marker.made_worktree) {
    await removeLinked(git, linked, runDir, removals, 'help')
    await removeCheckout(removals, git, marker.repo_path, 'help', worktree)
    await git.pruneWorktrees(marker.repo_path).catch(() => undefined)
  }
  await deleteRunDirectory(removals, 'help', runDir)
}

/**
 * At daemon start, before the first claim: the run directories a killed daemon left that hold a
 * `help.json`, asked about; those whose help run has ended are cleared. When the board cannot
 * be asked, the leftovers wait for a later start.
 */
export async function clearEndedHelps(api: BoardApi, git: Git, home: string): Promise<void> {
  const ids = helpLeftovers(home)
  if (ids.length === 0) return
  let ended: string[]
  try {
    ended = await api.helpsEnded(ids)
  } catch (error) {
    console.error(
      `board-cli: could not ask which helps have ended: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  for (const id of ended.filter((id) => ids.includes(id))) await cleanUpHelp(git, home, id)
}

/** The ids of the run directories under `home` that hold a `help.json`. */
export function helpLeftovers(home: string): string[] {
  try {
    return readdirSync(join(home, 'runs')).filter((id) =>
      existsSync(join(home, 'runs', id, HELP_FILE)),
    )
  } catch {
    return []
  }
}

export interface HelpDeps {
  api: BoardApi
  git: Git
  config: RunnerConfig
  /** The runner's code fingerprint at its start: the guard compares it with its own. */
  runnerCode: string
  /** Aborted when the board stops this help, or the daemon stops. */
  shutdown?: AbortSignal
  /** Aborted when the runner restarts on moved code: the help ends at once, failed. */
  restart?: AbortSignal
  timing?: Partial<ProcessTiming>
}

/**
 * One help: its own Claude Code session in the asking run's worktree, its own run directory
 * and token, its own heartbeat. The asking run's records are never written; the Help phase is
 * the help's own.
 */
export async function carryHelp(work: HelpWork, deps: HelpDeps): Promise<void> {
  const { api, config } = deps
  const controller = new AbortController()
  const heartbeat = setInterval(() => {
    api
      .helpHeartbeat(config.runnerId, [work.id])
      .then(({ stop }) => {
        if (stop.includes(work.id)) controller.abort()
      })
      .catch(() => undefined)
  }, config.heartbeatMs)
  const onRestart = () => controller.abort()
  deps.restart?.addEventListener('abort', onRestart)
  if (deps.restart?.aborted === true) controller.abort()
  let token = ''
  const runId = work.run.id
  const agent = PHASES.help.agent
  try {
    let worktree: string
    let runDir: string
    let made: CheckoutMade | undefined
    if (isQuestion(work)) {
      // The asking run's own worktree: the board keeps no path for a run that has not ended.
      worktree = runPaths(config.home, runId).worktree
      if (!existsSync(worktree)) {
        await api.failHelp(work.id, 'the run’s worktree is gone')
        return
      }
      runDir = join(config.home, 'helps', work.id)
      prepareRunDir(runDir)
    } else {
      const removals: LogContext = { home: config.home, runId, clock: () => new Date() }
      try {
        made = await prepareHelpCheckout(work, deps.git, config.home, removals)
      } catch (error) {
        const detail =
          error instanceof Error
            ? 'output' in error && typeof error.output === 'string'
              ? error.output
              : error.message
            : String(error)
        await api.failHelp(work.id, `the help’s checkout could not be made: ${detail}`)
        return
      }
      worktree = made.worktree
      runDir = made.runDir
    }
    token = await api.issueHelpToken(work.id)
    const sink = new EventSink(api, join(runDir, 'events.ndjson'), () => token)
    if (made !== undefined)
      await sink.send([
        newEvent(
          { runId, phaseId: work.phase_id, agent: 'runner', type: 'tool_call' },
          {
            tool: 'help_checkout',
            target: made.ref,
            status: 'ok',
            payload: checkoutPayload(made),
          },
        ),
      ])
    const sessionId = randomUUID()
    await sink.send([
      newEvent(
        { runId, phaseId: work.phase_id, agent, type: 'phase_start', model: PHASES.help.model },
        { payload: { name: 'help', attempt: work.attempt, session_id: sessionId } },
      ),
    ])
    const processInput = (
      prompt: string,
      resume: boolean,
      baseline: Record<string, SessionTotals>,
      session: string = sessionId,
    ) => ({
      runId,
      phaseId: work.phase_id,
      phase: 'help' as const,
      attempt: work.attempt,
      prompt,
      sessionId: session,
      resume,
      worktree,
      runDir,
      budgetUsd: work.run.task.budget_usd,
      baseline,
      token,
    })
    const processDeps = {
      sink,
      claudeBin: config.claudeBin,
      boardUrl: config.boardUrl,
      runnerCode: deps.runnerCode,
      signal: controller.signal,
      ...(deps.shutdown === undefined ? {} : { shutdown: deps.shutdown }),
      ...TIMING,
      ...deps.timing,
    }
    // A marker left from before must not pass for this help's save.
    rmSync(join(runDir, HELP_SAVED_MARKER), { force: true })
    const first = await runProcess(processInput(helpPrompt(work, made), false, {}), processDeps)
    const endedWell = (r: ProcessResult) =>
      r.exitCode === 0 && r.normalizer.result !== null && !r.normalizer.result.isError
    const saved = () => existsSync(join(runDir, HELP_SAVED_MARKER))
    let last = first
    let resumed = false
    if (
      endedWell(first) &&
      !saved() &&
      !first.interrupted &&
      first.stopped === 'no' &&
      !controller.signal.aborted &&
      deps.restart?.aborted !== true &&
      deps.shutdown?.aborted !== true
    ) {
      // The board may have stopped the help since the last heartbeat; only a help it still
      // carries is asked again.
      const stillWanted = await api
        .helpHeartbeat(config.runnerId, [work.id])
        .then(({ stop }) => !stop.includes(work.id))
        .catch(() => false)
      if (stillWanted && !controller.signal.aborted) {
        resumed = true
        last = await runProcess(
          processInput(
            RESAVE_MESSAGE,
            true,
            first.normalizer.totals() ?? {},
            first.normalizer.sessionId ?? sessionId,
          ),
          processDeps,
        )
      }
    }
    const ok = endedWell(last)
    const reported: Record<string, number> = {}
    for (const r of resumed ? [first, last] : [first])
      for (const [model, usd] of Object.entries(r.normalizer.reportedCost()))
        reported[model] = (reported[model] ?? 0) + usd
    const lastText = last.normalizer.result?.text ?? ''
    const text = lastText === '' ? (first.normalizer.result?.text ?? '') : lastText
    await sink.send([
      newEvent(
        { runId, phaseId: work.phase_id, agent, type: 'phase_end' },
        {
          payload: {
            status: ok ? 'succeeded' : 'failed',
            summary_md: text,
            reported_cost: reported,
            session_id: last.normalizer.sessionId ?? sessionId,
            ...(first.interrupted || last.interrupted ? { interrupted: true } : {}),
          },
        },
      ),
    ])
    // A help that saved is already succeeded, and one that was stopped is stopped: the board
    // keeps both. Any other end is a failure with its reason. Once the code has moved the guard
    // refuses even the saving call, so a help cut off by a restart never finishes.
    await api.failHelp(
      work.id,
      deps.restart?.aborted === true
        ? RESTART_REASON
        : deps.shutdown?.aborted === true
          ? 'the runner stopped'
          : ok
            ? resumed && !saved()
              ? 'the helper ended without saving a result, even when asked to save'
              : 'the helper ended without saving a result'
            : 'the helper ended with an error',
    )
  } finally {
    deps.restart?.removeEventListener('abort', onRestart)
    clearInterval(heartbeat)
    if (token !== '') await api.retire(token).catch(() => undefined)
    if (!isQuestion(work)) await cleanUpHelp(deps.git, config.home, runId)
  }
}
