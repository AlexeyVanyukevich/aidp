import { resolve } from 'node:path'

/**
 * Claude Code's configuration directory: `CLAUDE_CONFIG_DIR` when set and not empty, otherwise
 * `.claude` under the home directory. Absolute, without a trailing separator. The settings rule
 * and the guard both read it here, so they cannot disagree.
 */
export function configDir(env: { CLAUDE_CONFIG_DIR?: string | undefined }, home: string): string {
  const set = env.CLAUDE_CONFIG_DIR
  return resolve(set !== undefined && set !== '' ? set : `${home}/.claude`)
}
