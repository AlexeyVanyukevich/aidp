import { isMigration } from './hooks/guard.js'

/** Why a changed path is not allowed. */
export type Reason = 'not in the plan' | 'a migration the owner has not approved'

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
  approvedMigrations: string[]
}

/** Each changed path once: a committed path is never excluded, an uncommitted one may be. */
export function violationsOf(changes: Changes): Violation[] {
  const committed = new Set(changes.committed)
  const excluded = new Set(changes.excluded)
  const allowed = new Set(changes.allowed)
  const approved = new Set(changes.approvedMigrations)
  const paths = new Set([
    ...changes.committed,
    ...changes.uncommitted.filter((p) => !excluded.has(p)),
  ])
  const found: Violation[] = []
  for (const path of paths) {
    // The owner's approval of a migration covers its file, as it does at the PreToolUse guard.
    const reason: Reason | null =
      !allowed.has(path) && !approved.has(path)
        ? 'not in the plan'
        : isMigration(path) && !approved.has(path)
          ? 'a migration the owner has not approved'
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
  lines.push('', 'Undo each one, or ask for it:')
  const committed = sorted.filter((v) => v.committed)
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
  if (sorted.some((v) => !v.committed))
    lines.push(
      '',
      'An uncommitted path: delete the file if a command you ran generated it, or undo your change to it. Never commit it.',
    )
  lines.push(
    '',
    'If the work needs a path, call `request_approval` with kind `out_of_plan`, the files, and why; for a migration, call it with kind `migration`. Then end your turn.',
  )
  return lines.join('\n')
}
