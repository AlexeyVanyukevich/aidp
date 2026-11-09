import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { GitError, type Git } from './git.js'

export const LOG_FILE = 'worktree-removals.log'
const OUTPUT_LIMIT = 4_096

export type RemovalCaller =
  | 'run_end'
  | 'delivery_prepare'
  | 'draft_prepare'
  | 'linked_prepare'
  | 'cleanup'
  | 'recreate'
  | 'help'
export type LogCaller = RemovalCaller | 'delivery_resume' | 'draft_resume'
export type LogAction = 'remove' | 'delete' | 'recreate' | 'keep'
export type LogResult =
  'removed' | 'deleted' | 'absent' | 'failed' | 'refused' | 'recreated' | 'kept'

/** One line of the removal log. */
export interface LogLine {
  time: string
  pid: number
  action: LogAction
  run_id: string
  caller: LogCaller
  path: string
  resolved?: string
  result: LogResult
  output?: string
}

/** What a removal needs: where the log is, whose run it is, the time, and who is told. */
export interface LogContext {
  home: string
  runId: string
  clock: () => Date
  /** Told of every line a removal wrote that is worth an event; a failure is swallowed. */
  notify?: (line: LogLine) => Promise<void>
}

export const tail = (text: string): string => text.slice(-OUTPUT_LIMIT)

/**
 * The canonical path: the real path of the deepest ancestor that exists, then the remaining
 * segments as given. Null for a relative path, a `.` or `..` segment, or any error other than
 * "does not exist". Never throws.
 */
export function canonicalPath(path: string): string | null {
  if (!isAbsolute(path)) return null
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null
  let existing = path
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    const parent = dirname(existing)
    if (parent === existing) return null
    rest.push(basename(existing))
    existing = parent
  }
}

export type Guard =
  { ok: true; resolved: string } | { ok: false; reason: string; resolved?: string }

/** Passes the run's worktree, its `-linked` directory and a direct child of that, and no more. */
export function guardPath(home: string, runId: string, path: string): Guard {
  try {
    if (runId === '' || runId === '.' || runId === '..' || runId.includes('/'))
      return { ok: false, reason: `not a run id: ${runId}` }
    const resolved = canonicalPath(path)
    if (resolved === null) return { ok: false, reason: `no canonical path for ${path}` }
    const root = canonicalPath(home)
    if (root === null) return { ok: false, reason: `no canonical path for home ${home}` }
    const worktree = join(root, 'worktrees', runId)
    const linked = `${worktree}-linked`
    if (resolved === worktree || resolved === linked || dirname(resolved) === linked)
      return { ok: true, resolved }
    return { ok: false, reason: `${resolved} is not a path of run ${runId}`, resolved }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Passes exactly `<home>/runs/<run id>`, the run directory of the run id it is given, and no
 * other path: not another run's, not a path inside it, not `runs` itself, not a worktree.
 */
export function guardRunDir(home: string, runId: string, path: string): Guard {
  try {
    if (runId === '' || runId === '.' || runId === '..' || runId.includes('/'))
      return { ok: false, reason: `not a run id: ${runId}` }
    const resolved = canonicalPath(path)
    if (resolved === null) return { ok: false, reason: `no canonical path for ${path}` }
    const root = canonicalPath(home)
    if (root === null) return { ok: false, reason: `no canonical path for home ${home}` }
    if (resolved === join(root, 'runs', runId)) return { ok: true, resolved }
    return { ok: false, reason: `${resolved} is not the run directory of run ${runId}`, resolved }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Appends one line to the log, and returns it. A failed write is swallowed. */
export function recordLine(
  ctx: LogContext,
  fields: Omit<LogLine, 'time' | 'pid' | 'run_id' | 'output'> & { output?: string },
): LogLine {
  const line: LogLine = {
    time: ctx.clock().toISOString(),
    pid: process.pid,
    action: fields.action,
    run_id: ctx.runId,
    caller: fields.caller,
    path: fields.path,
    ...(fields.resolved === undefined ? {} : { resolved: fields.resolved }),
    result: fields.result,
    ...(fields.output === undefined ? {} : { output: tail(fields.output) }),
  }
  try {
    mkdirSync(ctx.home, { recursive: true })
    appendFileSync(join(ctx.home, LOG_FILE), `${JSON.stringify(line)}\n`)
  } catch {
    // The log is a record, never a reason to stop a run.
  }
  return line
}

const NOTIFIED = new Set<LogResult>(['removed', 'deleted', 'failed', 'refused'])

async function finish(ctx: LogContext, line: LogLine): Promise<LogLine> {
  if (ctx.notify !== undefined && NOTIFIED.has(line.result))
    await ctx.notify(line).catch(() => undefined)
  return line
}

const message = (error: unknown): string =>
  error instanceof GitError ? error.output : error instanceof Error ? error.message : String(error)

/** Removes one git worktree through the guard, logging what came of it. Never throws. */
export async function removeCheckout(
  ctx: LogContext,
  git: Pick<Git, 'removeWorktree'>,
  repo: string,
  caller: RemovalCaller,
  path: string,
): Promise<LogLine> {
  const guard = guardPath(ctx.home, ctx.runId, path)
  if (!guard.ok)
    return finish(
      ctx,
      recordLine(ctx, {
        action: 'remove',
        caller,
        path,
        ...(guard.resolved === undefined ? {} : { resolved: guard.resolved }),
        result: 'refused',
        output: guard.reason,
      }),
    )
  const base = { action: 'remove', caller, path, resolved: guard.resolved } as const
  if (!existsSync(guard.resolved))
    return finish(ctx, recordLine(ctx, { ...base, result: 'absent' }))
  try {
    await git.removeWorktree(repo, guard.resolved)
    return await finish(ctx, recordLine(ctx, { ...base, result: 'removed' }))
  } catch (error) {
    return finish(ctx, recordLine(ctx, { ...base, result: 'failed', output: message(error) }))
  }
}

/** Deletes a directory through the guard, logging what came of it. Never throws. */
export async function deleteDirectory(
  ctx: LogContext,
  caller: RemovalCaller,
  path: string,
): Promise<LogLine> {
  const guard = guardPath(ctx.home, ctx.runId, path)
  if (!guard.ok)
    return finish(
      ctx,
      recordLine(ctx, {
        action: 'delete',
        caller,
        path,
        ...(guard.resolved === undefined ? {} : { resolved: guard.resolved }),
        result: 'refused',
        output: guard.reason,
      }),
    )
  const base = { action: 'delete', caller, path, resolved: guard.resolved } as const
  if (!existsSync(guard.resolved))
    return finish(ctx, recordLine(ctx, { ...base, result: 'absent' }))
  try {
    rmSync(guard.resolved, { recursive: true, force: true })
    return await finish(ctx, recordLine(ctx, { ...base, result: 'deleted' }))
  } catch (error) {
    return finish(ctx, recordLine(ctx, { ...base, result: 'failed', output: message(error) }))
  }
}

/** Deletes a run directory through its own guard, logging what came of it. Never throws. */
export async function deleteRunDirectory(
  ctx: LogContext,
  caller: RemovalCaller,
  path: string,
): Promise<LogLine> {
  const guard = guardRunDir(ctx.home, ctx.runId, path)
  if (!guard.ok)
    return finish(
      ctx,
      recordLine(ctx, {
        action: 'delete',
        caller,
        path,
        ...(guard.resolved === undefined ? {} : { resolved: guard.resolved }),
        result: 'refused',
        output: guard.reason,
      }),
    )
  const base = { action: 'delete', caller, path, resolved: guard.resolved } as const
  if (!existsSync(guard.resolved))
    return finish(ctx, recordLine(ctx, { ...base, result: 'absent' }))
  try {
    rmSync(guard.resolved, { recursive: true, force: true })
    return await finish(ctx, recordLine(ctx, { ...base, result: 'deleted' }))
  } catch (error) {
    return finish(ctx, recordLine(ctx, { ...base, result: 'failed', output: message(error) }))
  }
}
