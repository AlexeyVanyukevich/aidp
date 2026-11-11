import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearMark,
  clearUntested,
  prepareRunDir,
  readAllowed,
  readApproved,
  readExcluded,
  readMark,
  readUntested,
  writeMark,
  writeUntested,
} from '../../src/phases/run-dir.js'

const ENTRIES = [{ path: 'a/migrations/004_x.ts', content: 'a => <b> & c\r\n\n' }]
const READERS = {
  readAllowed: {
    read: readAllowed,
    file: 'allowed-files.json',
    missing: null,
    good: ['a', 'b'] as unknown,
    shape: 'an array of strings',
  },
  readApproved: {
    read: readApproved,
    file: 'approved-migrations.json',
    missing: [],
    good: ENTRIES as unknown,
    shape: 'an array of { path, content } entries',
  },
  readExcluded: {
    read: readExcluded,
    file: 'excluded-paths.json',
    missing: [],
    good: ['a', 'b'] as unknown,
    shape: 'an array of strings',
  },
} as const

interface Row {
  name: string
  reader: keyof typeof READERS
  /** The file's text; `directory` puts a directory at its path, which exists but cannot be read. */
  content: string | null | 'directory'
  /** What the reader returns; `missing` is the reader's own value for a missing file. */
  result: unknown | 'missing' | { throws: string }
}

const CASES: Row[] = (Object.keys(READERS) as (keyof typeof READERS)[]).flatMap((reader) => {
  const { file, good, shape: shapeText } = READERS[reader]
  const invalid = { throws: `${file} is not valid JSON` }
  const shape = { throws: `${file} is not ${shapeText}` }
  return [
    { name: `${reader}: missing file`, reader, content: null, result: 'missing' },
    { name: `${reader}: a good list`, reader, content: JSON.stringify(good), result: good },
    { name: `${reader}: not json`, reader, content: 'not json', result: invalid },
    { name: `${reader}: a string`, reader, content: '"abc"', result: shape },
    { name: `${reader}: an object`, reader, content: '{}', result: shape },
    { name: `${reader}: an array of numbers`, reader, content: '[1]', result: shape },
    ...(reader === 'readApproved'
      ? [
          {
            name: `${reader}: plain strings (the old form)`,
            reader,
            content: '["a"]',
            result: shape,
          },
          {
            name: `${reader}: an entry without content`,
            reader,
            content: '[{"path":"a"}]',
            result: shape,
          },
          {
            name: `${reader}: a content that is not a string`,
            reader,
            content: '[{"path":"a","content":1}]',
            result: shape,
          },
        ]
      : [
          {
            name: `${reader}: entries instead of strings`,
            reader,
            content: JSON.stringify(ENTRIES),
            result: shape,
          },
        ]),
    {
      name: `${reader}: present but unreadable`,
      reader,
      content: 'directory',
      result: { throws: `${file} cannot be read` },
    },
  ]
})

describe('the run directory’s base marks', () => {
  const MARKS = ['setup', 'build', 'tested', 'verify'] as const
  it.each(MARKS)('%s: null when missing, trimmed when written, null once cleared', (mark) => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      expect(readMark(dir, mark)).toBeNull()
      writeMark(dir, mark, 'abc123')
      expect(readFileSync(join(dir, `${mark}-base.txt`), 'utf8')).toBe('abc123')
      writeFileSync(join(dir, `${mark}-base.txt`), 'abc123\n')
      expect(readMark(dir, mark)).toBe('abc123')
      clearMark(dir, mark)
      expect(readMark(dir, mark)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the untested commits as a list, empty when missing or cleared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      expect(readUntested(dir)).toEqual([])
      writeUntested(dir, [{ sha: 'abc1234', subject: 'fix: x' }])
      expect(readUntested(dir)).toEqual([{ sha: 'abc1234', subject: 'fix: x' }])
      writeFileSync(join(dir, 'untested-commits.json'), '["abc"]')
      expect(() => readUntested(dir)).toThrow('untested-commits.json is not an array')
      clearUntested(dir)
      expect(readUntested(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the run directory’s list readers', () => {
  it.each(CASES)('$name', ({ reader, content, result }) => {
    const { read, file, missing } = READERS[reader]
    const dir = mkdtempSync(join(tmpdir(), 'rd-'))
    try {
      if (content === 'directory') mkdirSync(join(dir, file))
      else if (content !== null) writeFileSync(join(dir, file), content)
      if (typeof result === 'object' && result !== null && 'throws' in result)
        expect(() => read(dir)).toThrow(result.throws)
      else expect(read(dir)).toEqual(result === 'missing' ? missing : result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prepareRunDir settings', () => {
  interface Row {
    name: string
    env: Record<string, string | undefined>
    rule: string
  }
  const rows: Row[] = [
    {
      name: 'dir set',
      env: { CLAUDE_CONFIG_DIR: '/tmp/cfg' },
      rule: 'Read(//tmp/cfg/projects/**/tool-results/**)',
    },
    {
      name: 'dir with trailing slash',
      env: { CLAUDE_CONFIG_DIR: '/tmp/cfg/' },
      rule: 'Read(//tmp/cfg/projects/**/tool-results/**)',
    },
    {
      name: 'dir unset',
      env: {},
      rule: 'Read(//home/u/.claude/projects/**/tool-results/**)',
    },
    {
      name: 'dir empty',
      env: { CLAUDE_CONFIG_DIR: '' },
      rule: 'Read(//home/u/.claude/projects/**/tool-results/**)',
    },
  ]
  it.each(rows)('writes one rule: $name', ({ env, rule }) => {
    const dir = mkdtempSync(join(tmpdir(), 'run-dir-'))
    try {
      prepareRunDir(dir, env, '/home/u')
      const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
      expect(settings.permissions).toEqual({ allow: [rule] })
      expect(settings.attribution).toEqual({ commit: '', pr: '' })
      expect(Object.keys(settings.hooks)).toEqual([
        'PreToolUse',
        'PostToolUse',
        'SubagentStart',
        'SubagentStop',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
