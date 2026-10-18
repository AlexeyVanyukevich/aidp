import type { FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { NotFoundError } from '../../shared/errors.js'
import { Uuid } from '../../shared/schemas.js'

export function registerPrFiles(instance: FastifyInstance): void {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  app.get(
    '/api/runs/:id/files',
    { schema: { params: Type.Object({ id: Uuid }) } },
    async (request) => {
      const run = await app.db
        .selectFrom('runs')
        .innerJoin('tasks', 'tasks.id', 'runs.task_id')
        .innerJoin('projects', 'projects.id', 'tasks.project_id')
        .select(['runs.pr_number', 'projects.github_repo'])
        .where('runs.id', '=', request.params.id)
        .executeTakeFirst()
      if (run === undefined) throw new NotFoundError('No such run')
      if (run.pr_number === null) return []
      const result = await app.gh([
        'pr',
        'view',
        String(run.pr_number),
        '--repo',
        run.github_repo,
        '--json',
        'files',
      ])
      if (result.code !== 0) throw new Error(`gh pr view failed: ${result.stderr}`)
      return (
        JSON.parse(result.stdout) as {
          files: { path: string; additions: number; deletions: number }[]
        }
      ).files
    },
  )
}
