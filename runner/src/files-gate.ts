import { isMigration } from './hooks/guard.js'
import { sameMigrationContent } from './migration-content.js'

/** Why a changed path is not allowed. */
export const DIFFERS = 'a migration that differs from the one the owner approved'

export type Reason = 'not in the plan' | 'a migration the owner has not approved' | typeof DIFFERS

export interface Violation {
  path: string
  reason: Reason
  /** The path is in the branch's net difference from the fork point, not only in the worktree. */
  committed: boolean
}

export interface Changes {
  /** Paths the branch changes against the merge-base with `origin/<base>`. */
  committed: string[]
  /** Staged, unstaged and untracked paths. */
  uncommitted: string[]
  /** Uncommitted paths the runner's own commands wrote; a committed path is never excluded. */
  excluded: string[]
  allowed: string[]
  approvedMigrations: { path: string; content: string }[]
  /** An approved path's file in the worktree, and at `HEAD`; null or absent when it has none. */
  worktreeFiles?: Record<string, string | null>
  headFiles?: Record<string, string | null>
}

/**
 * The worktree and `HEAD` copies of every approved migration among the changed paths, which
 * `violationsOf` compares with the approved content. A worktree copy that cannot be read counts
 * as missing; a failure to read `HEAD` throws, as a git failure does elsewhere in the gate.
 */
export async function readApprovedCopies(
  approved: { path: string }[],
  changedPaths: string[],
  readWorktree: (path: string) => string | null,
  readHead: (path: string) => Promise<string | null>,
): Promise<{
  worktreeFiles: Record<string, string | null>
  headFiles: Record<string, string | null>
}> {
  const changed = new Set(changedPaths)
  const worktreeFiles: Record<string, string | null> = {}
  const headFiles: Record<string, string | null> = {}
  for (const { path } of approved) {
    if (!changed.has(path)) continue
    worktreeFiles[path] = readWorktree(path)
    headFiles[path] = await readHead(path)
  }
  return { worktreeFiles, headFiles }
}

const differs = (approved: string, actual: string | null | undefined) =>
  actual === null || actual === undefined || !sameMigrationContent(actual, approved)

/** Each changed path once: a committed path is never excluded, an uncommitted one may be. */
export function violationsOf(changes: Changes): Violation[] {
  const committed = new Set(changes.committed)
  const excluded = new Set(changes.excluded)
  const allowed = new Set(changes.allowed)
  const approved = new Map(changes.approvedMigrations.map((entry) => [entry.path, entry.content]))
  const paths = new Set([
    ...changes.committed,
    ...changes.uncommitted.filter((p) => !excluded.has(p)),
  ])
  const found: Violation[] = []
  for (const path of paths) {
    // The owner's approval of a migration covers its file, as it does at the PreToolUse guard.
    const content = approved.get(path)
    const reason: Reason | null =
      !allowed.has(path) && content === undefined
        ? 'not in the plan'
        : isMigration(path) && content === undefined
          ? 'a migration the owner has not approved'
          : content !== undefined &&
              (differs(content, changes.worktreeFiles?.[path]) ||
                (committed.has(path) && differs(content, changes.headFiles?.[path])))
            ? DIFFERS
            : null
    if (reason !== null) found.push({ path, reason, committed: committed.has(path) })
  }
  return found
}

/** The paths in `after` that `before` did not hold. */
export function newlyChanged(before: string[], after: string[]): string[] {
  const had = new Set(before)
  return after.filter((p) => !had.has(p))
}

const SAFE = /^[\w@%+=:,./-]+$/
const shell = (path: string) => (SAFE.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`)

/** The text the builder reads, from the gate or the hook: every path, why, and how to undo it. */
export function formatViolations(violations: Violation[], mergeBase: string): string {
  const sorted = [...violations].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const lines = ['The build changed files the run does not allow:', '']
  for (const v of sorted)
    lines.push(`- \`${v.path}\` – ${v.reason} (${v.committed ? 'committed' : 'uncommitted'})`)
  const differing = sorted.filter((v) => v.reason === DIFFERS)
  const others = sorted.filter((v) => v.reason !== DIFFERS)
  if (others.length > 0) lines.push('', 'Undo each one, or ask for it:')
  const committed = others.filter((v) => v.committed)
  if (committed.length > 0) {
    lines.push(
      '',
      `A committed path: restore it to its content at the fork point, or remove it if the branch added it, and commit the undo.`,
    )
    for (const v of committed)
      lines.push(
        `- \`git checkout ${mergeBase} -- ${shell(v.path)}\`, or \`git rm ${shell(v.path)}\` for a file the branch added`,
      )
  }
  if (others.some((v) => !v.committed))
    lines.push(
      '',
      'An uncommitted path: delete the file if a command you ran generated it, or undo your change to it. Never commit it.',
    )
  if (differing.length > 0)
    lines.push(
      '',
      `A migration that differs from the one the owner approved: write the approved content again with one Write${differing.some((v) => v.committed) ? ' and commit it' : ''}, or call \`request_approval\` with kind \`migration\` and the whole new file. The approved version is in the \`<approved_migration>\` element of the Build handoff, and in the guard's refusal of a Write that differs.`,
    )
  if (others.length > 0)
    lines.push(
      '',
      'If the work needs a path, call `request_approval` with kind `out_of_plan`, the files, and why; for a migration, call it with kind `migration`. Then end your turn.',
    )
  return lines.join('\n')
}
