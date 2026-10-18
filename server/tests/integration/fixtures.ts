import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/schema.js'
import type { TaskState } from '../../src/shared/vocabulary.js'

/** The smallest spec that lints clean: one requirement, one criterion, no open question. */
export const GOOD_SPEC = `## Requirements
1. R1 – Retries back off
## Acceptance criteria
- AC1 (R1): Given a failure Then it retries after 1s
## Open questions
`

export async function seedProject(
  db: Kysely<Database>,
  overrides: Partial<{
    key: string
    repo_path: string
    github_repo: string
    test_command: string
  }> = {},
): Promise<{ id: string; key: string }> {
  return db
    .insertInto('projects')
    .values({
      key: 'PAY',
      name: 'Payments',
      repo_path: `/repos/${overrides.key ?? 'PAY'}`,
      github_repo: 'owner/pay',
      base_branch: 'main',
      test_command: 'npm test',
      ...overrides,
    })
    .returning(['id', 'key'])
    .executeTakeFirstOrThrow()
}

export async function seedTask(
  db: Kysely<Database>,
  projectId: string,
  overrides: Partial<{ title: string; state: TaskState; number: number; position: number }> = {},
): Promise<{ id: string }> {
  const number = overrides.number ?? 1
  await db
    .updateTable('projects')
    .set((eb) => ({
      next_task_number: eb.fn('greatest', [eb.ref('next_task_number'), eb.val(number + 1)]),
    }))
    .where('id', '=', projectId)
    .execute()
  return db
    .insertInto('tasks')
    .values({
      project_id: projectId,
      number,
      title: overrides.title ?? 'Retry webhooks',
      state: overrides.state ?? 'backlog',
      position: overrides.position ?? 1,
      updated_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}

/** A project, a task in Ready with an approved spec, and its queued delivery run. */
export async function seedQueuedRun(
  db: Kysely<Database>,
  overrides: Partial<{ state: TaskState; projectKey: string }> = {},
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const project = await seedProject(db, { key: overrides.projectKey ?? 'PAY' })
  const task = await seedTask(db, project.id, { state: overrides.state ?? 'ready' })
  await db
    .insertInto('specs')
    .values({
      task_id: task.id,
      version: 1,
      body_md: GOOD_SPEC,
      status: 'approved',
      approved_at: new Date(),
      criteria: JSON.stringify([
        { id: 'AC1', requirements: ['R1'], text: 'Given a failure Then it retries after 1s' },
      ]),
    })
    .execute()
  const run = await db
    .insertInto('runs')
    .values({ task_id: task.id, kind: 'delivery', spec_version: 1, status: 'queued' })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { projectId: project.id, taskId: task.id, runId: run.id }
}
