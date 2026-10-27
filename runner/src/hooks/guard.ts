import { isAbsolute, relative, resolve, sep, basename } from 'node:path'

export type Verdict = { allow: true } | { allow: false; reason: string }

const COMMAND_RULES: [RegExp, string][] = [
  [
    /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|(?:-r|--recursive)\s+(?:-f|--force)|(?:-f|--force)\s+(?:-r|--recursive))\b/,
    'rm -rf is not allowed in a run',
  ],
  [/\bgit\s+push\b/, 'agents never push; the runner pushes when Verify passes'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard is not allowed in a run'],
  [
    /(?:^|[\s'"/=])\.env(?:\.[\w.-]+)?(?=$|[\s'";|&)])/,
    '.env files hold secrets and are off limits',
  ],
]

const HOOK_REASON =
  'git hooks are not to be skipped: the commit-msg hook must not be skipped. Fix the message and commit again.'

/** Splits a shell command into words, quotes removed, so text inside a message is one word. */
function words(command: string): string[] {
  const out: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let current = ''
  let last = 0
  for (const match of command.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last && /\s/.test(command.slice(last, start))) {
      if (current !== '') out.push(current)
      current = ''
    }
    current += match[1] ?? match[2] ?? match[3] ?? ''
    last = start + match[0].length
  }
  if (current !== '') out.push(current)
  return out
}

/** `git commit` that skips the hooks: with --no-verify or -n, or under -c core.hooksPath. */
export function skipsCommitHook(command: string): boolean {
  // Each simple command on its own: a `;`, `&&` or `|` outside quotes ends one.
  const segments: string[][] = [[]]
  for (const word of words(command.replace(/(&&|\|\||;|\|)/g, ' $1 '))) {
    if (/^(?:&&|\|\||;|\|)$/.test(word)) segments.push([])
    else segments.at(-1)?.push(word)
  }
  return segments.some((segment) => {
    const git = segment.findIndex((w) => w === 'git' || w.endsWith('/git'))
    if (git === -1) return false
    const rest = segment.slice(git + 1)
    const commit = rest.indexOf('commit')
    if (commit === -1) return false
    for (let i = 0; i < commit; i++) {
      const w = rest[i] ?? ''
      const config = w === '-c' ? (rest[i + 1] ?? '') : w.startsWith('-c') ? w.slice(2) : ''
      if (/^core\.hookspath(?:=|$)/i.test(config)) return true
    }
    const options = rest.slice(commit + 1)
    for (let i = 0; i < options.length; i++) {
      const w = options[i] ?? ''
      if (w === '--') break
      // The value of a message option is text, never an option.
      if (w === '-m' || w === '--message' || w === '-F' || w === '-C' || w === '-c') {
        i += 1
        continue
      }
      if (w.startsWith('--')) {
        if (w === '--no-verify') return true
        continue
      }
      if (w.startsWith('-') && w.length > 1) {
        // A cluster: letters up to a message option, whose rest or next word is its value.
        for (const letter of w.slice(1)) {
          if (letter === 'n') return true
          if ('mFCc'.includes(letter)) break
        }
        if (/^-[a-zA-Z]*[mFCc]$/.test(w)) i += 1
      }
    }
    return false
  })
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The tools a model can send to the background, where `-p` loses them when its turn ends. */
const BACKGROUND_TOOLS = new Set(['Bash', 'Agent'])
const BACKGROUND =
  'Run it in the foreground: a command or agent left running in the background is lost when your turn ends. Give a long command a timeout instead.'

function deny(reason: string): Verdict {
  return { allow: false, reason }
}

/** A path with a `migrations` segment whose file name does not start with `index.` (a registry). */
export function isMigration(relativePath: string): boolean {
  const segments = relativePath.split('/')
  return segments.includes('migrations') && !(segments.at(-1) ?? '').startsWith('index.')
}

function migrationReason(path: string, exists: boolean): string {
  return `${exists ? 'changing' : 'creating'} the migration \`${path}\` needs the owner's approval. Call request_approval with kind migration, the path in files, a summary of what it changes and whether its down step undoes it in question, and the whole file in context_md. Then end your turn.`
}

export function decide(
  input: { tool_name: string; tool_input: Record<string, unknown> },
  ctx: {
    phase: string
    /** The plan's files and those the owner allowed since; null before there is a plan. */
    allowedFiles: string[] | null
    /** The board paused the run: nothing the agent does may change anything (spec §6). */
    paused: boolean
    /** Migrations the owner approved for this run; the guard reads them from the run directory. */
    approvedMigrations?: string[]
    cwd: string
    exists: (path: string) => boolean
  },
): Verdict {
  if (ctx.paused) return deny('The run is paused; end your turn.')
  // The model asks for the background itself (slice 3 spec, §3, fact 3).
  if (BACKGROUND_TOOLS.has(input.tool_name) && input.tool_input.run_in_background === true)
    return deny(BACKGROUND)
  if (input.tool_name === 'Bash') {
    const command = typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
    for (const [pattern, reason] of COMMAND_RULES) if (pattern.test(command)) return deny(reason)
    if (skipsCommitHook(command)) return deny(HOOK_REASON)
    return { allow: true }
  }

  if (!FILE_TOOLS.has(input.tool_name)) return { allow: true }
  const raw = input.tool_input.file_path ?? input.tool_input.notebook_path
  if (typeof raw !== 'string') return { allow: true }
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw)
  const inside = relative(ctx.cwd, absolute)
  if (inside.startsWith('..') || isAbsolute(inside))
    return deny('this path is outside the worktree')
  if (/^\.env(\..*)?$/.test(basename(absolute)))
    return deny('.env files hold secrets and are off limits')
  const relativePath = inside.split(sep).join('/')
  const approved = (ctx.approvedMigrations ?? []).includes(relativePath)
  if (isMigration(relativePath) && !approved) {
    const exists = ctx.exists(absolute)
    if (ctx.phase === 'build') {
      return deny(migrationReason(relativePath, exists))
    } else if (input.tool_name === 'Write' && !exists) {
      return deny(
        'a new migration needs a person; finish without it and say in your report that one is needed',
      )
    }
  }
  if (
    ctx.phase === 'build' &&
    ctx.allowedFiles !== null &&
    !approved &&
    !ctx.allowedFiles.includes(relativePath)
  ) {
    return deny(
      `\`${relativePath}\` is not in the plan. If the work needs it, call request_approval with kind out_of_plan, the files, and why. Then end your turn.`,
    )
  }
  return { allow: true }
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
}
