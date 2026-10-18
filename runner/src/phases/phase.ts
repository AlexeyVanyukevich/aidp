import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BoardApi } from '../api.js'
import { EventSink, newEvent } from '../sink.js'
import { StreamNormalizer } from '../stream/normalize.js'
import { PHASES } from './agents.js'
import { buildClaudeArgs } from './claude-args.js'

export interface PhaseInput {
  runId: string
  phase: 'plan' | 'build' | 'verify'
  attempt: number
  handoff: string
  worktree: string
  runDir: string
  budgetUsd: number | null
}

export interface PhaseDeps {
  api: BoardApi
  sink: EventSink
  claudeBin: string
  boardUrl: string
  signal?: AbortSignal
  /** The sink reads the token through this, so buffered events replay with a live one. */
  setToken(token: string): void
}

export interface PhaseResult {
  phaseId: string
  ok: boolean
  summary: string
  sessionId: string | null
  cancelled: boolean
}

const STDERR_LINES = 50

export async function runPhase(input: PhaseInput, deps: PhaseDeps): Promise<PhaseResult> {
  const config = PHASES[input.phase]
  const phaseId = randomUUID()
  const sessionId = randomUUID()
  const label = `${input.phase}-${input.attempt}`
  const base = { runId: input.runId, phaseId, agent: config.agent }

  const token = await deps.api.issueToken(input.runId)
  deps.setToken(token)
  await deps.sink.send([
    newEvent(
      { ...base, type: 'phase_start', model: config.model },
      { payload: { name: input.phase, attempt: input.attempt, session_id: sessionId } },
    ),
  ])

  const normalizer = new StreamNormalizer({ runId: input.runId, phaseId, agent: config.agent })
  const args = buildClaudeArgs({
    prompt: input.handoff,
    sessionId,
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
      BOARD_RUN_TOKEN: token,
      BOARD_RUN_ID: input.runId,
      BOARD_PHASE_ID: phaseId,
      BOARD_PHASE: input.phase,
      BOARD_AGENT: config.agent,
      BOARD_RUN_DIR: input.runDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    child.kill('SIGTERM')
  }
  deps.signal?.addEventListener('abort', onAbort, { once: true })

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
    child.on('close', (code) => resolve(code ?? 1)),
  )
  deps.signal?.removeEventListener('abort', onAbort)
  await pending

  const result = normalizer.result
  const ok = !cancelled && exitCode === 0 && result !== null && !result.isError
  const closing = [...normalizer.finish()]
  if (!ok && !cancelled) {
    closing.push(
      newEvent(
        { ...base, type: 'error' },
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
  closing.push(
    newEvent(
      { ...base, type: 'phase_end' },
      {
        payload: {
          status: ok ? 'succeeded' : 'failed',
          summary_md: result?.text ?? '',
          reported_cost: normalizer.reportedCost(),
          session_id: normalizer.sessionId ?? sessionId,
        },
      },
    ),
  )
  await deps.sink.send(closing)
  await deps.api.retire(token).catch(() => undefined)
  return {
    phaseId,
    ok,
    summary: result?.text ?? '',
    sessionId: normalizer.sessionId ?? sessionId,
    cancelled,
  }
}
