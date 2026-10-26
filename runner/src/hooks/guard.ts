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
