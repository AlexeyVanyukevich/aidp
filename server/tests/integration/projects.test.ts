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
    expect(response.json()).toMatchObject({ ...VALID, setup_command: null })

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

describe('the setup command', () => {
  const post = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/projects', payload: { ...VALID, ...payload } })
  const list = async () => (await app.inject({ method: 'GET', url: '/api/projects' })).json()
  const patch = (url: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url, payload: payload as object })

  it('is stored when it resolves, and listed', async () => {
    const response = await post({ setup_command: 'npm ci' })
    expect(response.statusCode).toBe(201)
    expect((await list())[0]).toMatchObject({ setup_command: 'npm ci' })
  })

  it.each([
    ['omitted', {}],
    ['blank', { setup_command: '  ' }],
    ['null', { setup_command: null }],
  ])('is null when %s', async (_name, change) => {
    const response = await post(change)
    expect(response.statusCode).toBe(201)
    expect(response.json().setup_command).toBeNull()
  })

  it('is refused at creation when it does not resolve, and no project is made', async () => {
    const response = await post({ setup_command: 'pnpm install' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { field: 'setup_command' },
    })
    expect(await list()).toEqual([])
  })

  it('is set and cleared by PATCH', async () => {
    await post({})
    const set = await patch('/api/projects/PAY', { setup_command: 'npm ci' })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ key: 'PAY', setup_command: 'npm ci' })
    expect((await list())[0]).toMatchObject({ setup_command: 'npm ci' })
    const cleared = await patch('/api/projects/PAY', { setup_command: null })
    expect(cleared.json().setup_command).toBeNull()
    await patch('/api/projects/PAY', { setup_command: 'npm ci' })
    expect(
      (await patch('/api/projects/PAY', { setup_command: ' ' })).json().setup_command,
    ).toBeNull()
  })

  it('refuses PATCH of another field or of an unresolvable command, leaving the project', async () => {
    await post({ setup_command: 'npm ci' })
    expect((await patch('/api/projects/PAY', { name: 'New' })).statusCode).toBe(400)
    expect(
      (await patch('/api/projects/PAY', { setup_command: 'npm ci', name: 'New' })).statusCode,
    ).toBe(400)
    const bad = await patch('/api/projects/PAY', { setup_command: 'pnpm install' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ details: { field: 'setup_command' } })
    expect((await list())[0]).toMatchObject({ name: 'Payments', setup_command: 'npm ci' })
  })

  it('answers 404 for an unknown key', async () => {
    expect((await patch('/api/projects/NOPE', { setup_command: null })).statusCode).toBe(404)
  })
})
