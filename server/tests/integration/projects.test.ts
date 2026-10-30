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

  it('starts the project with one default command, `npm test`, unchecked', async () => {
    const asked: string[] = []
    const watching = await buildTestApp({
      repoInspector: {
        ...fakeInspector,
        commandExists: async (command) => {
          asked.push(command)
          return true
        },
      },
    })
    try {
      const response = await watching.inject({
        method: 'POST',
        url: '/api/projects',
        payload: VALID,
      })
      expect(response.statusCode).toBe(201)
      expect(response.json()).not.toHaveProperty('test_command')
      const commands = await watching.inject({
        method: 'GET',
        url: '/api/projects/PAY/test-commands',
      })
      expect(commands.json()).toEqual([
        { id: expect.any(String), name: 'tests', command: 'npm test', is_default: true },
      ])
      expect(asked).toEqual([])
    } finally {
      await watching.close()
    }
  })

  it('refuses a body with test_command and registers nothing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, test_command: 'npm test' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).json()).toEqual([])
  })

  it.each([
    ['a path that is not a repository', { repo_path: '/repos/missing' }, 'repo_path'],
    ['a repository whose remote is another', { repo_path: '/repos/other' }, 'github_repo'],
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
    ['a test command', { test_command: 'npm test' }],
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

describe('PATCH /api/projects/:key', () => {
  const register = () => app.inject({ method: 'POST', url: '/api/projects', payload: VALID })
  const patch = (payload: unknown) =>
    app.inject({ method: 'PATCH', url: '/api/projects/PAY', payload: payload as object })

  it('refuses test_command as an unknown field and changes nothing', async () => {
    await register()
    const response = await patch({ test_command: 'npm run x' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('validation_error')
    const commands = await app.inject({ method: 'GET', url: '/api/projects/PAY/test-commands' })
    expect(commands.json()).toMatchObject([{ command: 'npm test' }])
  })

  it('still clears the setup command', async () => {
    await register()
    expect((await patch({ setup_command: null })).statusCode).toBe(200)
  })
})

describe('test commands', () => {
  const register = (key = 'PAY') =>
    app.inject({
      method: 'POST',
      url: '/api/projects',
      payload:
        key === 'PAY'
          ? VALID
          : { ...VALID, key, repo_path: '/repos/other', github_repo: 'owner/other' },
    })
  const url = (suffix = '', key = 'PAY') => `/api/projects/${key}/test-commands${suffix}`
  const list = async (key = 'PAY') =>
    (await app.inject({ method: 'GET', url: url('', key) })).json() as {
      id: string
      name: string
      command: string
      is_default: boolean
    }[]
  const add = (payload: unknown, key = 'PAY') =>
    app.inject({ method: 'POST', url: url('', key), payload: payload as object })
  const patch = (id: string, payload: unknown, key = 'PAY') =>
    app.inject({ method: 'PATCH', url: url(`/${id}`, key), payload: payload as object })
  const idOf = async (name: string) => (await list()).find((c) => c.name === name)!.id

  beforeEach(async () => {
    await register()
  })

  it('lists by lower-case name on both routes, the default marked, and 404s an unknown key', async () => {
    await add({ name: 'unit', command: 'npm run unit' })
    await add({ name: 'Lint', command: 'npm run lint' })
    expect((await list()).map((c) => [c.name, c.is_default])).toEqual([
      ['Lint', false],
      ['tests', true],
      ['unit', false],
    ])
    const projects = (await app.inject({ method: 'GET', url: '/api/projects' })).json()
    expect(projects[0]).not.toHaveProperty('test_command')
    expect(projects[0].test_commands.map((c: { name: string }) => c.name)).toEqual([
      'Lint',
      'tests',
      'unit',
    ])
    expect((await app.inject({ method: 'GET', url: url('', 'NOPE') })).statusCode).toBe(404)
    expect((await add({ name: 'x', command: 'true' }, 'NOPE')).statusCode).toBe(404)
  })

  const refusals: [string, { name: string; command: string }, 'name' | 'command'][] = [
    ['a blank name', { name: '   ', command: 'true' }, 'name'],
    ['a 41-character name', { name: 'n'.repeat(41), command: 'true' }, 'name'],
    ['a name taken in other case', { name: 'TESTS', command: 'true' }, 'name'],
    ['a bad name and a bad command', { name: '', command: 'pnpm test' }, 'name'],
    ['a blank command', { name: 'unit', command: '  ' }, 'command'],
    ['a 501-character command', { name: 'unit', command: 'x'.repeat(501) }, 'command'],
    ['a command that does not resolve', { name: 'unit', command: 'pnpm test' }, 'command'],
  ]
  it.each(refusals)('refuses %s, naming the field', async (_name, body, field) => {
    const response = await add(body)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'validation_error', details: { field } })
    expect(await list()).toHaveLength(1)
  })

  it('adds a trimmed, non-default command', async () => {
    const response = await add({ name: '  unit ', command: 'npm run unit' })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      name: 'unit',
      command: 'npm run unit',
      is_default: false,
    })
  })

  it('checks the name before it asks whether the command resolves', async () => {
    const asked: string[] = []
    const watching = await buildTestApp({
      repoInspector: {
        ...fakeInspector,
        commandExists: async (command) => {
          asked.push(command)
          return true
        },
      },
    })
    try {
      await watching.inject({ method: 'POST', url: '/api/projects', payload: VALID })
      asked.length = 0
      const response = await watching.inject({
        method: 'POST',
        url: url(),
        payload: { name: '', command: 'npm run unit' },
      })
      expect(response.statusCode).toBe(400)
      expect(asked).toEqual([])
    } finally {
      await watching.close()
    }
  })

  it('answers 400 on the name, never 500, when two adds race', async () => {
    let waiting = 0
    let release: () => void = () => undefined
    const both = new Promise<void>((resolve) => (release = resolve))
    const racing = await buildTestApp({
      repoInspector: {
        ...fakeInspector,
        commandExists: async () => {
          waiting += 1
          if (waiting >= 2) release()
          // Only the two adds below wait; registration's own checks come first.
          await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 3000))])
          return true
        },
      },
    })
    try {
      await racing.inject({ method: 'POST', url: '/api/projects', payload: VALID })
      waiting = 0
      const send = () =>
        racing.inject({
          method: 'POST',
          url: url(),
          payload: { name: 'unit', command: 'npm run unit' },
        })
      const responses = await Promise.all([send(), send()])
      expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 400])
      const refused = responses.find((r) => r.statusCode === 400)!
      expect(refused.json()).toMatchObject({ details: { field: 'name' } })
      const commands = await racing.inject({ method: 'GET', url: url() })
      expect(commands.json().filter((c: { name: string }) => c.name === 'unit')).toHaveLength(1)
    } finally {
      await racing.close()
    }
  })

  it('makes a command the only default', async () => {
    await add({ name: 'unit', command: 'npm run unit' })
    const response = await patch(await idOf('unit'), { is_default: true })
    expect(response.statusCode).toBe(200)
    expect((await list()).filter((c) => c.is_default).map((c) => c.name)).toEqual(['unit'])
  })

  it.each([
    ['an empty body', {}],
    ['is_default false', { is_default: false }],
    ['an unknown field', { colour: 'blue' }],
  ])('refuses a patch of %s', async (_name, body) => {
    await add({ name: 'unit', command: 'npm run unit' })
    expect((await patch(await idOf('unit'), body)).statusCode).toBe(400)
  })

  it('changes nothing when one field is refused', async () => {
    await add({ name: 'unit', command: 'npm run unit' })
    const response = await patch(await idOf('unit'), { name: 'renamed', command: 'pnpm x' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ details: { field: 'command' } })
    expect((await list()).map((c) => c.name)).toContain('unit')
  })

  it('renames and edits a command, allowing its own name in other case', async () => {
    await add({ name: 'unit', command: 'npm run unit' })
    const response = await patch(await idOf('unit'), { name: 'UNIT', command: 'npm run u' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ name: 'UNIT', command: 'npm run u' })
  })

  it('answers 404 for a command of another project', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { ...VALID, key: 'OTH', repo_path: '/repos/other', github_repo: 'owner/other' },
    })
    const other = (await list('OTH'))[0]!.id
    expect((await patch(other, { name: 'x' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: url(`/${other}`) })).statusCode).toBe(404)
  })

  it('removes a command, resetting every task that chose it, Done included', async () => {
    const db = getTestDb()
    await add({ name: 'unit', command: 'npm run unit' })
    const id = await idOf('unit')
    const { id: projectId } = await db
      .selectFrom('projects')
      .select('id')
      .where('key', '=', 'PAY')
      .executeTakeFirstOrThrow()
    const tasks = []
    for (const [number, state] of [
      [1, 'ready'],
      [2, 'done'],
    ] as const)
      tasks.push(
        (
          await db
            .insertInto('tasks')
            .values({
              project_id: projectId,
              number,
              title: 'T',
              state,
              position: number,
              test_command_id: id,
              updated_at: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id,
      )
    const response = await app.inject({ method: 'DELETE', url: url(`/${id}`) })
    expect(response.statusCode).toBe(204)
    const rows = await db.selectFrom('tasks').select('test_command_id').execute()
    expect(rows.map((r) => r.test_command_id)).toEqual([null, null])
    expect(await list()).toHaveLength(1)
  })

  it('refuses to remove the default', async () => {
    const response = await app.inject({ method: 'DELETE', url: url(`/${await idOf('tests')}`) })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('conflict')
    expect(await list()).toHaveLength(1)
  })

  it('publishes project.updated for each change, and task.updated for a reset task', async () => {
    const messages: { topic: string; key?: string; taskId?: string }[] = []
    const unsubscribe = app.bus.subscribe((message) => messages.push(message))
    try {
      const added = await add({ name: 'unit', command: 'npm run unit' })
      const id = added.json().id as string
      const db = getTestDb()
      const project = await db
        .selectFrom('projects')
        .select('id')
        .where('key', '=', 'PAY')
        .executeTakeFirstOrThrow()
      const task = await db
        .insertInto('tasks')
        .values({
          project_id: project.id,
          number: 1,
          title: 'T',
          state: 'ready',
          position: 1,
          test_command_id: id,
          updated_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await patch(id, { name: 'unit2' })
      await patch(id, { is_default: true })
      await patch(await idOf('tests'), { is_default: true })
      await app.inject({ method: 'DELETE', url: url(`/${id}`) })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(messages.filter((m) => m.topic === 'project.updated')).toEqual(
        Array.from({ length: 5 }, () => ({ topic: 'project.updated', key: 'PAY' })),
      )
      expect(messages).toContainEqual({ topic: 'task.updated', taskId: task.id })
    } finally {
      unsubscribe()
    }
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
