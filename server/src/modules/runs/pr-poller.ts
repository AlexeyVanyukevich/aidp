import { execFile } from 'node:child_process'
import type { Kysely } from 'kysely'
import type { Database } from '../../db/schema.js'
import { ConflictError } from '../../shared/errors.js'
import { moveTask } from '../tasks/task.moves.js'

export type Gh = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const realGh: Gh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      })
    })
  })

/** Moves cards in Review once their pull request is merged or closed on GitHub. */
export class PrPoller {
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly db: Kysely<Database>,
    private readonly gh: Gh,
    private readonly log: { warn(obj: object, msg: string): void },
  ) {}

  async tick(): Promise<void> {
    const rows = await this.db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .innerJoin('runs', 'runs.task_id', 'tasks.id')
      .select([
        'tasks.id as taskId',
        'tasks.number',
        'projects.key as projectKey',
        'runs.id as runId',
        'runs.pr_number',
        'projects.github_repo',
      ])
      .where('tasks.state', '=', 'review')
      .where('runs.pr_number', 'is not', null)
      .distinctOn('tasks.id')
      .orderBy('tasks.id')
      .orderBy('runs.created_at', 'desc')
      .execute()
    for (const row of rows) {
      const result = await this.gh([
        'pr',
        'view',
        String(row.pr_number),
        '--repo',
        row.github_repo,
        '--json',
        'state',
      ])
      if (result.code !== 0) {
        this.log.warn(
          { taskId: row.taskId, stderr: result.stderr },
          'could not read a pull request',
        )
        continue
      }
      const { state } = JSON.parse(result.stdout) as { state: string }
      const move = state === 'MERGED' ? 'merge' : state === 'CLOSED' ? 'close_pr' : undefined
      if (move === undefined) continue
      try {
        await this.db.transaction().execute(async (trx) => {
          await moveTask(trx, row.taskId, move)
          if (move === 'close_pr')
            await trx
              .updateTable('runs')
              .set({ failure_reason: 'pull request closed without merging' })
              .where('id', '=', row.runId)
              .execute()
        })
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        this.log.warn(
          { taskId: row.taskId, key: `${row.projectKey}-${row.number}`, move },
          'the PR poller could not move a card',
        )
      }
    }
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.log.warn({ err: error }, 'the PR poller failed'))
    }, intervalMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }
}
