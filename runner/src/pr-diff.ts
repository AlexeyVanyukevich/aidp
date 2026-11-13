import { posix } from 'node:path'

/** One changed file's section of `pr.diff`. */
export interface DiffSection {
  path: string
  /** The line of `pr.diff` (from 1) where the file's `diff --git` section begins. */
  first_line: number
  /** The section's line count. */
  lines: number
  /** Set when the file's name marks it as one a reviewer skips. */
  skip?: 'lockfile' | 'generated'
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
])
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.map']

/** `lockfile` by base name, `generated` by suffix, else none. */
export function skipMark(path: string): DiffSection['skip'] {
  if (LOCKFILES.has(posix.basename(path))) return 'lockfile'
  if (GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix))) return 'generated'
  return undefined
}

/**
 * The sections of a `git diff --no-renames` text, one per changed path, in the diff's order:
 * the n-th path of `git diff -z --name-only` over the same range names the n-th section. Pure.
 */
export function diffSections(diff: string, paths: string[]): DiffSection[] {
  const lines = diff === '' ? [] : diff.split('\n')
  // A diff ends with a line break: the empty piece after it is no line.
  if (lines.at(-1) === '') lines.pop()
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (line.startsWith('diff --git ')) starts.push(index)
  })
  if (starts.length !== paths.length)
    throw new Error(
      `the diff has ${starts.length} section${starts.length === 1 ? '' : 's'} but ${paths.length} path${paths.length === 1 ? '' : 's'} changed`,
    )
  return starts.map((start, n) => {
    const path = paths[n] ?? ''
    const mark = skipMark(path)
    return {
      path,
      first_line: start + 1,
      lines: (starts[n + 1] ?? lines.length) - start,
      ...(mark === undefined ? {} : { skip: mark }),
    }
  })
}
