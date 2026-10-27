import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LinkedProject } from './contract.js'
import type { Git } from './git.js'

/** One linked project's read-only checkout, as `linked.json` lists it. */
export interface LinkedCheckout extends LinkedProject {
  /** Where the checkout is: outside the run's worktree, so its status and diff never show it. */
  path: string
}

export const LINKED_FILE = 'linked.json'

type CheckoutGit = Pick<Git, 'prepareDetachedWorktree' | 'removeWorktree' | 'pruneWorktrees'>

/** What `linked.json` says; empty when the run has no links or has not got to `prepare`. */
export function readLinked(runDir: string): LinkedCheckout[] {
  try {
    return JSON.parse(readFileSync(join(runDir, LINKED_FILE), 'utf8')) as LinkedCheckout[]
  } catch {
    return []
  }
}

function writeLinked(runDir: string, checkouts: LinkedCheckout[]): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, LINKED_FILE), JSON.stringify(checkouts))
}

/**
 * A detached worktree of each linked project's `origin/<base>`, never of the owner's own branch.
 * `linked.json` grows as each checkout is made, so a failure partway leaves a list that
 * `removeLinked` can still clear.
 */
export async function prepareLinked(
  git: CheckoutGit,
  links: LinkedProject[],
  dir: string,
  runDir: string,
): Promise<void> {
  await removeLinked(git, dir, runDir)
  if (links.length === 0) return
  const made: LinkedCheckout[] = []
  writeLinked(runDir, made)
  for (const link of links) {
    const path = join(dir, link.key)
    mkdirSync(dir, { recursive: true })
    // Listed before it is made: a worktree add that fails after creating the directory is
    // still cleared at the run's end.
    made.push({ ...link, path })
    writeLinked(runDir, made)
    await git.prepareDetachedWorktree(link.repo_path, link.base_branch, path)
  }
}

/** A resumed run's checkouts that are gone from disk are made again, from the base's tip. */
export async function restoreLinked(git: CheckoutGit, runDir: string): Promise<void> {
  for (const checkout of readLinked(runDir)) {
    if (existsSync(checkout.path)) continue
    await git.pruneWorktrees(checkout.repo_path)
    await git.prepareDetachedWorktree(checkout.repo_path, checkout.base_branch, checkout.path)
  }
}

/** Removes every checkout `linked.json` lists, then the directory that held them. */
export async function removeLinked(git: CheckoutGit, dir: string, runDir: string): Promise<void> {
  for (const checkout of readLinked(runDir)) {
    await git.removeWorktree(checkout.repo_path, checkout.path).catch(() => undefined)
    await git.pruneWorktrees(checkout.repo_path).catch(() => undefined)
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(join(runDir, LINKED_FILE), { force: true })
}
