import type { Migration } from 'kysely/migration'
import * as initial from './001_initial.js'
import * as pauseAndResume from './002_pause_and_resume.js'
import * as draftedSpecs from './003_drafted_specs.js'
import * as setupCommand from './004_setup_command.js'
import * as planKeptFrom from './005_plan_kept_from.js'
import * as projectLinks from './006_project_links.js'

/**
 * Listed rather than discovered from disk: a file provider imports at runtime, which fails
 * wherever TypeScript cannot be loaded directly, such as Vitest's global setup. Keys are the
 * names Kysely records; they apply in lexicographic order, so keep the numeric prefix.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_pause_and_resume': pauseAndResume,
  '003_drafted_specs': draftedSpecs,
  '004_setup_command': setupCommand,
  '005_plan_kept_from': planKeptFrom,
  '006_project_links': projectLinks,
}
