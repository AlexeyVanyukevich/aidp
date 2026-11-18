import type { BuildEntry } from './phases/handoff.js'

/** One `build_report` artifact, in save order: the Build phase that saved it, and its entries. */
export interface SavedBuildReport {
  phaseId: string
  attempt: number
  tests: BuildEntry[]
}

/** A Build attempt's entries, as the handoff shows them. */
export interface BuildReportGroup {
  attempt: number
  tests: BuildEntry[]
}

/**
 * Folds a run's saved reports: within one Build phase a later entry for the same test name
 * replaces the earlier; phases that share an attempt are folded together; groups run by attempt.
 */
export function foldBuildReports(saves: readonly SavedBuildReport[]): BuildReportGroup[] {
  const byPhase = new Map<string, { attempt: number; tests: Map<string, BuildEntry> }>()
  for (const save of saves) {
    const phase = byPhase.get(save.phaseId) ?? { attempt: save.attempt, tests: new Map() }
    byPhase.set(save.phaseId, phase)
    for (const entry of save.tests) {
      phase.tests.delete(entry.name)
      phase.tests.set(entry.name, entry)
    }
  }
  const byAttempt = new Map<number, Map<string, BuildEntry>>()
  for (const phase of byPhase.values()) {
    const group = byAttempt.get(phase.attempt) ?? new Map<string, BuildEntry>()
    byAttempt.set(phase.attempt, group)
    for (const entry of phase.tests.values()) {
      group.delete(entry.name)
      group.set(entry.name, entry)
    }
  }
  return [...byAttempt]
    .sort(([a], [b]) => a - b)
    .map(([attempt, tests]) => ({ attempt, tests: [...tests.values()] }))
}
