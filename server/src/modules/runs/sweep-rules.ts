import type { ApprovalStatus, RunStatus } from '../../shared/vocabulary.js'

/** Three missed heartbeats, at the runner's 30 s, and a heartbeat due at 90 s still counts. */
export const LOST_AFTER_MS = 90_000
/** An approval is never auto-approved; after this it blocks the card instead (spec §5). */
export const APPROVAL_TTL_MS = 48 * 3_600_000

export interface SweepInput {
  now: Date
  /** When the sweeper last ran; null before its first tick. */
  lastTick: Date | null
  intervalMs: number
  runs: { id: string; status: RunStatus; lastHeartbeatAt: Date | null }[]
  approvals: { id: string; status: ApprovalStatus; createdAt: Date }[]
}

export type SweepDecision = { rearm: true } | { rearm: false; lost: string[]; expired: string[] }

/**
 * Which runs have lost their runner and which approvals have expired. A tick after a gap of more
 * than two intervals — the machine slept, and the runner's heartbeats with it — decides
 * nothing: on waking, the runner deserves a full window to report (spec §8). So does the first.
 */
export function sweepDecisions(input: SweepInput): SweepDecision {
  const { now, lastTick, intervalMs } = input
  if (lastTick === null || now.getTime() - lastTick.getTime() > 2 * intervalMs)
    return { rearm: true }
  const age = (since: Date) => now.getTime() - since.getTime()
  return {
    rearm: false,
    lost: input.runs
      .filter(
        (run) =>
          run.status === 'running' &&
          run.lastHeartbeatAt !== null &&
          age(run.lastHeartbeatAt) > LOST_AFTER_MS,
      )
      .map((run) => run.id),
    expired: input.approvals
      .filter(
        (approval) => approval.status === 'open' && age(approval.createdAt) >= APPROVAL_TTL_MS,
      )
      .map((approval) => approval.id),
  }
}
