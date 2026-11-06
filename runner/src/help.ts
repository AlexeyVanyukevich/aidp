import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardApi } from './api.js'
import type { RunnerConfig } from './config.js'
import type { HelpWork } from './contract.js'
import { newEvent, EventSink } from './sink.js'
import { PHASES } from './phases/agents.js'
import { attr, escape } from './phases/handoff.js'
import { runPaths } from './run-steps.js'
import { runProcess, type ProcessTiming } from './phases/process.js'
import { prepareRunDir } from './phases/run-dir.js'

/** Helps a runner carries at once, beside its run. */
export const HELP_SLOTS = 3

/** Why a help a restart cut off is failed. */
export const RESTART_REASON = 'runner restarted'

const TIMING: ProcessTiming = { pauseGraceMs: 60_000, stopGraceMs: 10_000, markerPollMs: 500 }

/** The first message of a helper: its mode, and the question it is for. */
export function helpPrompt(work: HelpWork): string {
  const asked =
    work.question_index === null ? 'the open question' : `question ${work.question_index + 1}`
  return [
    `<task key="${attr(work.run.task.key)}">${escape(work.run.task.title)}</task>`,
    `Mode: ${work.mode}.`,
    work.mode === 'suggest'
      ? `Suggest an answer to ${asked} of the run waiting on the owner. Read it with get_question.`
      : `Explain ${asked} of the run waiting on the owner in plain words. Read it with get_question.`,
  ].join('\n')
}

export interface HelpDeps {
  api: BoardApi
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
    // The asking run's own worktree: the board keeps no path for a run that has not ended.
    const { worktree } = runPaths(config.home, runId)
    if (!existsSync(worktree)) {
      await api.failHelp(work.id, 'the run’s worktree is gone')
      return
    }
    const runDir = join(config.home, 'helps', work.id)
    prepareRunDir(runDir)
    token = await api.issueHelpToken(work.id)
    const sink = new EventSink(api, join(runDir, 'events.ndjson'), () => token)
    const sessionId = randomUUID()
    await sink.send([
      newEvent(
        { runId, phaseId: work.phase_id, agent, type: 'phase_start', model: PHASES.help.model },
        { payload: { name: 'help', attempt: work.attempt, session_id: sessionId } },
      ),
    ])
    const result = await runProcess(
      {
        runId,
        phaseId: work.phase_id,
        phase: 'help',
        attempt: work.attempt,
        prompt: helpPrompt(work),
        sessionId,
        resume: false,
        worktree,
        runDir,
        budgetUsd: work.run.task.budget_usd,
        baseline: {},
        token,
      },
      {
        sink,
        claudeBin: config.claudeBin,
        boardUrl: config.boardUrl,
        runnerCode: deps.runnerCode,
        signal: controller.signal,
        ...(deps.shutdown === undefined ? {} : { shutdown: deps.shutdown }),
        ...TIMING,
        ...deps.timing,
      },
    )
    const ok = result.exitCode === 0 && result.normalizer.result?.isError === false
    await sink.send([
      newEvent(
        { runId, phaseId: work.phase_id, agent, type: 'phase_end' },
        {
          payload: {
            status: ok ? 'succeeded' : 'failed',
            summary_md: result.normalizer.result?.text ?? '',
            reported_cost: result.normalizer.reportedCost(),
            session_id: result.normalizer.sessionId ?? sessionId,
            ...(result.interrupted ? { interrupted: true } : {}),
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
            ? 'the helper ended without saving a result'
            : 'the helper ended with an error',
    )
  } finally {
    deps.restart?.removeEventListener('abort', onRestart)
    clearInterval(heartbeat)
    if (token !== '') await api.retire(token).catch(() => undefined)
  }
}
