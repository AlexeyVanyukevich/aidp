import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, resetDb } from './helpers.js'
import type { RepoInspector } from '../../src/modules/projects/repo-inspector.js'

const fakeInspector: RepoInspector = {
  async inspect(path) {
    if (path === '/repos/pay') return { isGitRepo: true, remotes: ['git@github.com:owner/pay.git'] }
    if (path === '/repos/other')
      return { isGitRepo: true, remotes: ['git@github.com:owner/other.git'] }
    return { isGitRepo: false, remotes: [] }
  },
  async commandExists(command) {
    return command.startsWith('npm')
  },
}

const VALID = {
  key: 'PAY',
  name: 'Payments',
  repo_path: '/repos/pay',
  github_repo: 'owner/pay',
  base_branch: 'main',
  test_command: 'npm test',
}

let app: FastifyInstance
beforeAll(async () => {
  app = await buildTestApp({ repoInspector: fakeInspector })
})
beforeEach(resetDb)
afterAll(async () => {
  await app.close()
  await closeTestDb()
})

describe('POST /api/projects', () => {
  it('registers a target repository', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject(VALID)

    const list = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(list.json()).toEqual([expect.objectContaining({ key: 'PAY' })])
  })

  it.each([
    ['a path that is not a repository', { repo_path: '/repos/missing' }, 'repo_path'],
    ['a repository whose remote is another', { repo_path: '/repos/other' }, 'github_repo'],
    ['a test command that does not exist', { test_command: 'pnpm test' }, 'test_command'],
  ])('refuses %s, naming the field', async (_name, change, field) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, ...change },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field } })
  })

  it.each([
    ['a lower-case key', { key: 'pay' }],
    ['a relative path', { repo_path: 'repos/pay' }],
    ['a repository without an owner', { github_repo: 'pay' }],
    ['a blank test command', { test_command: '   ' }],
    ['an unknown field', { colour: 'blue' }],
  ])('refuses %s at the schema', async (_name, change) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, ...change },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
  })

  it('refuses a second project with the same key', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field: 'key' } })
  })
})
