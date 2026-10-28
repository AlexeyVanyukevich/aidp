import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, closeTestDb, getTestDb, resetDb } from './helpers.js'
import type { RepoInspector } from '../../src/modules/projects/repo-inspector.js'

const fakeInspector: RepoInspector = {
  async inspect(path) {
    if (path === '/repos/pay') return { isGitRepo: true, remotes: ['git@github.com:owner/pay.git'] }
    if (path === '/repos/other')
      return { isGitRepo: true, remotes: ['git@github.com:owner/other.git'] }
    return { isGitRepo: false, remotes: [] }
  },
  async commandExists(command) {
    return !command.startsWith('pnpm')
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

describe('PATCH /api/projects/:key test command', () => {
  const register = () => app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
  const list = async () => (await app.inject({ method: 'GET', url: '/api/projects' })).json()
  const patch = (url: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url, payload: payload as object })
  const unchanged = { name: 'Payments', test_command: 'npm test', setup_command: 'npm ci' }
  const registerWithSetup = () =>
    app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, setup_command: 'npm ci' },
    })

  const refusedBodies: [string, unknown][] = [
    ['an empty body', {}],
    ['an unknown field beside test_command', { test_command: 'true', name: 'New' }],
  ]
  it.each(refusedBodies)('refuses %s and writes nothing', async (_name, body) => {
    await registerWithSetup()
    const response = await patch('/api/projects/PAY', body)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
    expect((await list())[0]).toMatchObject(unchanged)
  })

  const badTestCommands: [string, unknown][] = [
    ['spaces', '   '],
    ['empty', ''],
    ['null', null],
    ['501 characters', 'x'.repeat(501)],
    ['an unresolvable command', 'pnpm test'],
  ]
  it.each(badTestCommands)('refuses a test command of %s, naming the field', async (_n, value) => {
    await registerWithSetup()
    const response = await patch('/api/projects/PAY', { test_command: value })
    expect(response.statusCode).toBe(400)
    const json = response.json()
    expect(json.error).toBe('validation_error')
    expect(JSON.stringify(json)).toContain('test_command')
    if (value === 'pnpm test') expect(json.details.field).toBe('test_command')
    expect((await list())[0]).toMatchObject(unchanged)
  })

  const bothInvalid: [string, unknown][] = [
    ['an unresolvable setup command ', { setup_command: 'true', test_command: 'pnpm test' }],
    ['both unresolvable', { setup_command: 'pnpm install', test_command: 'pnpm test' }],
  ]
  it.each(bothInvalid)('writes neither field when %s', async (_name, body) => {
    await registerWithSetup()
    const response = await patch('/api/projects/PAY', body)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'test_command' } })
    expect((await list())[0]).toMatchObject(unchanged)
  })

  it('refuses a valid test command beside an unresolvable setup command, writing neither', async () => {
    await registerWithSetup()
    const response = await patch('/api/projects/PAY', {
      setup_command: 'pnpm install',
      test_command: 'true',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'setup_command' } })
    expect((await list())[0]).toMatchObject(unchanged)
  })

  it('sets the test command alone, keeping the setup command', async () => {
    await registerWithSetup()
    const response = await patch('/api/projects/PAY', { test_command: 'true' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ test_command: 'true', setup_command: 'npm ci' })
    expect((await list())[0]).toMatchObject({ test_command: 'true', setup_command: 'npm ci' })
  })

  it('sets both fields at once', async () => {
    await register()
    const response = await patch('/api/projects/PAY', {
      setup_command: 'npm ci',
      test_command: 'true',
    })
    expect(response.statusCode).toBe(200)
    expect((await list())[0]).toMatchObject({ test_command: 'true', setup_command: 'npm ci' })
  })

  it('keeps the test command when only the setup command is set', async () => {
    await register()
    await patch('/api/projects/PAY', { setup_command: 'npm ci' })
    expect((await list())[0]).toMatchObject({ test_command: 'npm test', setup_command: 'npm ci' })
  })

  it('answers 404 for an unknown key', async () => {
    const response = await patch('/api/projects/NOPE', { test_command: 'true' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('not_found')
  })
})

describe('the project_links table', () => {
  const db = () => getTestDb()
  const make = async (key: string) =>
    (
      await db()
        .insertInto('projects')
        .values({
          key,
          name: key,
          repo_path: `/tmp/${key}`,
          github_repo: `owner/${key.toLowerCase()}`,
          base_branch: 'main',
          test_command: 'npm test',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  const link = (from: string, to: string) =>
    db().insertInto('project_links').values({ project_id: from, linked_project_id: to, note: 'n' })

  it('removes every link from or to a deleted project, and nothing else', async () => {
    const [a, b, c, d] = [
      await make('AAA'),
      await make('BBB'),
      await make('CCC'),
      await make('DDD'),
    ]
    await link(a, b).execute()
    await link(b, a).execute()
    await link(c, a).execute()
    await link(c, d).execute()
    await db().deleteFrom('projects').where('id', '=', a).execute()
    const left = await db()
      .selectFrom('project_links')
      .select(['project_id', 'linked_project_id'])
      .execute()
    expect(left).toEqual([{ project_id: c, linked_project_id: d }])
    const projects = await db().selectFrom('projects').select('id').execute()
    expect(projects.map((p) => p.id).sort()).toEqual([b, c, d].sort())
  })

  it('refuses a project linked to itself', async () => {
    const a = await make('AAA')
    await expect(link(a, a).execute()).rejects.toThrow()
  })
})

describe('links between projects', () => {
  const OTHER = {
    ...VALID,
    key: 'OTH',
    name: 'Other',
    repo_path: '/repos/other',
    github_repo: 'owner/other',
  }
  const link = (key: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/projects/${key}/links`, payload: payload as object })
  const unlink = (key: string, target: string) =>
    app.inject({ method: 'DELETE', url: `/api/projects/${key}/links/${target}` })
  const list = async () =>
    (await app.inject({ method: 'GET', url: '/api/projects' })).json() as {
      key: string
      links: { key: string; name: string; note: string }[]
    }[]

  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
    await app.inject({ method: 'POST', url: '/api/projects', payload: OTHER })
  })

  it('links one way, and lists the link under the project that references', async () => {
    const response = await link('PAY', { target: 'OTH', note: 'the kit' })
    expect(response.statusCode).toBe(201)
    const projects = await list()
    expect(projects.find((p) => p.key === 'PAY')?.links).toEqual([
      { key: 'OTH', name: 'Other', note: 'the kit' },
    ])
    expect(projects.find((p) => p.key === 'OTH')?.links).toEqual([])
  })

  it.each([
    ['itself', 'PAY'],
    ['an unknown project', 'NOPE'],
  ])('refuses a link to %s, naming target', async (_name, target) => {
    const response = await link('PAY', { target, note: 'n' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: 'validation_error',
      details: { field: 'target' },
    })
  })

  it('refuses a link that exists', async () => {
    await link('PAY', { target: 'OTH', note: 'n' })
    const response = await link('PAY', { target: 'OTH', note: 'again' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'target' } })
  })

  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['501 characters', 'x'.repeat(501)],
  ])('refuses a %s note, creating nothing', async (_name, note) => {
    const response = await link('PAY', { target: 'OTH', note })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field: 'note' } })
    expect((await list()).find((p) => p.key === 'PAY')?.links).toEqual([])
  })

  it('answers 404 for an unknown project', async () => {
    expect((await link('NOPE', { target: 'OTH', note: 'n' })).statusCode).toBe(404)
  })

  it('removes one link, leaving the reverse, and answers 404 the second time', async () => {
    await link('PAY', { target: 'OTH', note: 'a' })
    await link('OTH', { target: 'PAY', note: 'b' })
    expect((await unlink('PAY', 'OTH')).statusCode).toBe(204)
    const projects = await list()
    expect(projects.find((p) => p.key === 'PAY')?.links).toEqual([])
    expect(projects.find((p) => p.key === 'OTH')?.links).toEqual([
      { key: 'PAY', name: 'Payments', note: 'b' },
    ])
    expect((await unlink('PAY', 'OTH')).statusCode).toBe(404)
  })
})
