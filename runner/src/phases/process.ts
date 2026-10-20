import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionTotals } from '../contract.js'
import { newEvent, type EventSink } from '../sink.js'
import { StreamNormalizer } from '../stream/normalize.js'
import { PHASES } from './agents.js'
import { buildClaudeArgs } from './claude-args.js'
import { PAUSED_MARKER } from './run-dir.js'

export interface ProcessInput {
  runId: string
  phaseId: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  /** The handoff when starting a session; the owner's answer, or a nudge, when resuming one. */
  prompt: string
  sessionId: string
  resume: boolean
  worktree: string
  runDir: string
  budgetUsd: number | null
  /** The session's totals as its previous process's result reported them (spec §7). */
  baseline: Record<string, SessionTotals>
  token: string
}

export interface ProcessTiming {
  /** How long a paused process has to end its turn before it is ended. */
  pauseGraceMs: number
  /** How long a process has after SIGTERM before SIGKILL. */
  stopGraceMs: number
  markerPollMs: number
}

export interface ProcessDeps extends ProcessTiming {
  sink: EventSink
  claudeBin: string
  boardUrl: string
  /** The owner cancelled the run. */
  signal?: AbortSignal
  /** The daemon is stopping. */
  shutdown?: AbortSignal
  /** The heartbeat's backstop for a pause the marker never showed. */
  pauseRequested?: () => boolean
}

export type Stopped = 'no' | 'paused' | 'cancelled' | 'shutdown'

export interface ProcessResult {
  exitCode: number
  /** Why the process ended, if not of its own accord — or that it paused and ended itself. */
  stopped: Stopped
  /** The runner ended it with a signal: Claude Code's own totals miss part of it (spec §3). */
  interrupted: boolean
  normalizer: StreamNormalizer
  stderrTail: string
}

const STDERR_LINES = 50
const pidFile = (input: ProcessInput) => join(input.runDir, `${input.phase}-${input.attempt}.pid`)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A process its runner left running — the runner died, the process did not — would write to the
 * session alongside a resume. It is ended first; but only if it is a claude process, since after
 * a reboot its pid may name something else.
 */
async function endLeftover(input: ProcessInput, deps: ProcessDeps): Promise<void> {
  const file = pidFile(input)
  if (!existsSync(file)) return
  const pid = Number(readFileSync(file, 'utf8').trim())
  rmSync(file, { force: true })
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return
  let command = ''
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return
  }
  if (!command.includes(basename(deps.claudeBin))) return
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + deps.stopGraceMs
  while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
  if (alive(pid)) process.kill(pid, 'SIGKILL')
}

/** One `claude -p` launch: starting or resuming the phase's session (slice 2 spec, §6). */
export async function runProcess(input: ProcessInput, deps: ProcessDeps): Promise<ProcessResult> {
  const config = PHASES[input.phase]
  const label = `${input.phase}-${input.attempt}`
  await endLeftover(input, deps)
  rmSync(join(input.runDir, PAUSED_MARKER), { force: true })

  const normalizer = new StreamNormalizer({
    runId: input.runId,
    phaseId: input.phaseId,
    agent: config.agent,
    baseline: input.baseline,
  })
  const args = buildClaudeArgs({
    prompt: input.prompt,
    sessionId: input.sessionId,
    resume: input.resume,
    role: config.agent,
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    tools: config.tools,
    agentsJson: readFileSync(join(input.runDir, 'agents.json'), 'utf8'),
    settingsPath: join(input.runDir, 'settings.json'),
    mcpPath: join(input.runDir, 'mcp.json'),
    budgetUsd: input.budgetUsd,
  })
  const child = spawn(deps.claudeBin, args, {
    cwd: input.worktree,
    env: {
      ...process.env,
      BOARD_URL: deps.boardUrl,
      BOARD_RUN_TOKEN: input.token,
      BOARD_RUN_ID: input.runId,
      BOARD_PHASE_ID: input.phaseId,
      BOARD_PHASE: input.phase,
      BOARD_AGENT: config.agent,
      BOARD_RUN_DIR: input.runDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid !== undefined) writeFileSync(pidFile(input), String(child.pid))

  let exited = false
  let stopped: Stopped = 'no'
  let interrupted = false
  const timers: NodeJS.Timeout[] = []
  /** SIGTERM lets Claude Code finish the message it has and write its result; SIGKILL if not. */
  const stop = (why: Exclude<Stopped, 'no'>) => {
    if (interrupted || exited) return
    stopped = why
    interrupted = true
    child.kill('SIGTERM')
    timers.push(setTimeout(() => exited || child.kill('SIGKILL'), deps.stopGraceMs))
  }
  const onCancel = () => stop('cancelled')
  const onShutdown = () => stop('shutdown')
  deps.signal?.addEventListener('abort', onCancel, { once: true })
  deps.shutdown?.addEventListener('abort', onShutdown, { once: true })
  if (deps.signal?.aborted) onCancel()
  if (deps.shutdown?.aborted) onShutdown()

  // The marker is the pause's own signal; the heartbeat's word is the backstop (spec §6).
  let pausing = false
  const poll = setInterval(() => {
    if (pausing) return
    if (existsSync(join(input.runDir, PAUSED_MARKER)) || deps.pauseRequested?.() === true) {
      pausing = true
      if (stopped === 'no') stopped = 'paused'
      timers.push(setTimeout(() => stop('paused'), deps.pauseGraceMs))
    }
  }, deps.markerPollMs)

  const stderr: string[] = []
  createInterface({ input: child.stderr }).on('line', (line) => {
    appendFileSync(join(input.runDir, `${label}.stderr.log`), `${line}\n`)
    stderr.push(line)
    if (stderr.length > STDERR_LINES) stderr.shift()
  })

  // Lines are handled in order; a slow send never reorders two events.
  let pending = Promise.resolve()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      appendFileSync(join(input.runDir, `${label}.stdout-noise.log`), `${line}\n`)
      return
    }
    const events = normalizer.push(parsed)
    if (events.length > 0) pending = pending.then(() => deps.sink.send(events))
  })

  const exitCode = await new Promise<number>((resolve) =>
    child.on('close', (code) => {
      exited = true
      resolve(code ?? 1)
    }),
  )
  clearInterval(poll)
  for (const timer of timers) clearTimeout(timer)
  deps.signal?.removeEventListener('abort', onCancel)
  deps.shutdown?.removeEventListener('abort', onShutdown)
  rmSync(pidFile(input), { force: true })
  // A marker that went down as the process ended still means it paused.
  if (stopped === 'no' && existsSync(join(input.runDir, PAUSED_MARKER))) stopped = 'paused'
  await pending

  const closing = [...normalizer.finish()]
  const result = normalizer.result
  const ok = exitCode === 0 && result !== null && !result.isError
  if (!ok && !interrupted && stopped === 'no' && !normalizer.sessionGone) {
    closing.push(
      newEvent(
        { runId: input.runId, phaseId: input.phaseId, agent: config.agent, type: 'error' },
        {
          payload: {
            exit_code: exitCode,
            subtype: result?.subtype ?? null,
            stderr_tail: stderr.join('\n'),
          },
        },
      ),
    )
  }
  await deps.sink.send(closing)
  return { exitCode, stopped, interrupted, normalizer, stderrTail: stderr.join('\n') }
}
