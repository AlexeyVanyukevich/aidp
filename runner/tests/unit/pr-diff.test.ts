import { describe, expect, it } from 'vitest'
import { diffSections, skipMark, type DiffSection } from '../../src/pr-diff.js'

const section = (path: string, body: string[]) => [`diff --git a/${path} b/${path}`, ...body]
const text = (...sections: string[][]) => sections.flat().join('\n') + '\n'

const source = section('src/a.ts', [
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
])
const lock = section('package-lock.json', ['index 1..2 100644', '@@ -1 +1 @@', '-a', '+b'])
const webLock = section('web/pnpm-lock.yaml', ['index 1..2 100644', '@@ -1 +1 @@', '-a', '+b'])
const minified = section('dist/app.min.js', ['index 1..2 100644', '@@ -1 +1 @@', '-a', '+b'])
const map = section('app.js.map', ['new file mode 100644', '@@ -0,0 +1 @@', '+{}'])
const spaced = section('my docs/read me.md', ['index 1..2 100644', '@@ -1 +1 @@', '-a', '+b'])
const deleted = section('old.ts', [
  'deleted file mode 100644',
  'index 1..0',
  '@@ -1 +0,0 @@',
  '-gone',
])
const binary = section('logo.png', [
  'index 1..2 100644',
  'Binary files a/logo.png and b/logo.png differ',
])

interface Row {
  name: string
  diff: string
  paths: string[]
  expected: DiffSection[]
}

const rows: Row[] = [
  {
    name: 'a source file',
    diff: text(source),
    paths: ['src/a.ts'],
    expected: [{ path: 'src/a.ts', first_line: 1, lines: 7 }],
  },
  {
    name: 'a lockfile after a source file',
    diff: text(source, lock),
    paths: ['src/a.ts', 'package-lock.json'],
    expected: [
      { path: 'src/a.ts', first_line: 1, lines: 7 },
      { path: 'package-lock.json', first_line: 8, lines: 5, skip: 'lockfile' },
    ],
  },
  {
    name: 'a lockfile in a directory',
    diff: text(webLock),
    paths: ['web/pnpm-lock.yaml'],
    expected: [{ path: 'web/pnpm-lock.yaml', first_line: 1, lines: 5, skip: 'lockfile' }],
  },
  {
    name: 'a minified script',
    diff: text(minified),
    paths: ['dist/app.min.js'],
    expected: [{ path: 'dist/app.min.js', first_line: 1, lines: 5, skip: 'generated' }],
  },
  {
    name: 'a source map',
    diff: text(map),
    paths: ['app.js.map'],
    expected: [{ path: 'app.js.map', first_line: 1, lines: 4, skip: 'generated' }],
  },
  {
    name: 'a path with a space',
    diff: text(spaced),
    paths: ['my docs/read me.md'],
    expected: [{ path: 'my docs/read me.md', first_line: 1, lines: 5 }],
  },
  {
    name: 'a deleted file',
    diff: text(deleted),
    paths: ['old.ts'],
    expected: [{ path: 'old.ts', first_line: 1, lines: 5 }],
  },
  {
    name: 'a binary file between two others',
    diff: text(source, binary, deleted),
    paths: ['src/a.ts', 'logo.png', 'old.ts'],
    expected: [
      { path: 'src/a.ts', first_line: 1, lines: 7 },
      { path: 'logo.png', first_line: 8, lines: 3 },
      { path: 'old.ts', first_line: 11, lines: 5 },
    ],
  },
  { name: 'an empty diff', diff: '', paths: [], expected: [] },
]

describe('diffSections', () => {
  it.each(rows)('$name', ({ diff, paths, expected }) => {
    const found = diffSections(diff, paths)
    expect(found).toEqual(expected)
    const total = diff === '' ? 0 : diff.split('\n').length - 1
    expect(found.reduce((sum, file) => sum + file.lines, 0)).toBe(total)
  })

  it('refuses a path list that does not match the sections', () => {
    expect(() => diffSections(text(source), [])).toThrow(/1 section.*0 path/)
  })
})

describe('skipMark', () => {
  const marks: [string, DiffSection['skip']][] = [
    ['package-lock.json', 'lockfile'],
    ['npm-shrinkwrap.json', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['bun.lock', 'lockfile'],
    ['bun.lockb', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['Gemfile.lock', 'lockfile'],
    ['poetry.lock', 'lockfile'],
    ['uv.lock', 'lockfile'],
    ['composer.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['a/b/go.sum', 'lockfile'],
    ['x.min.js', 'generated'],
    ['x.min.css', 'generated'],
    ['x.map', 'generated'],
    ['src/lockfile.ts', undefined],
    ['src/a.js', undefined],
  ]
  it.each(marks)('%s', (path, mark) => {
    expect(skipMark(path)).toBe(mark)
  })
})
