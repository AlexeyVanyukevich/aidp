import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationError } from '../../src/config.js'
import { checkExecutable } from '../../src/executable.js'

const root = mkdtempSync(join(tmpdir(), 'exe-'))
const exe = join(root, 'claude')
writeFileSync(exe, '#!/bin/sh\n')
chmodSync(exe, 0o755)
const plain = join(root, 'plain')
writeFileSync(plain, 'x')
chmodSync(plain, 0o644)
const dir = join(root, 'adir')
mkdirSync(dir)
const link = join(root, 'link')
symlinkSync(exe, link)
const empty = join(root, 'empty')
mkdirSync(empty)
const bin = join(root, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'tool'), '#!/bin/sh\n')
chmodSync(join(bin, 'tool'), 0o755)
const here = join(root, 'cwd')
mkdirSync(here)
writeFileSync(join(here, 'tool'), '#!/bin/sh\n')
chmodSync(join(here, 'tool'), 0o755)

interface Row {
  name: string
  value: string
  path: string
  cwd?: string
  refused: boolean
  reason?: string
}
const ROWS: Row[] = [
  { name: 'absolute executable', value: exe, path: '', refused: false },
  { name: 'symlink to executable', value: link, path: '', refused: false },
  {
    name: 'bare name after a PATH entry without it',
    value: 'tool',
    path: `${empty}:${bin}`,
    refused: false,
  },
  {
    name: 'absolute missing',
    value: join(root, 'nope'),
    path: '',
    refused: true,
    reason: 'does not exist',
  },
  { name: 'directory', value: dir, path: '', refused: true, reason: 'not a regular file' },
  {
    name: 'no execute permission',
    value: plain,
    path: '',
    refused: true,
    reason: 'not executable',
  },
  {
    name: 'relative with slash',
    value: 'bin/claude',
    path: bin,
    refused: true,
    reason: 'relative path',
  },
  { name: 'dot-slash', value: './claude', path: bin, refused: true, reason: 'relative path' },
  {
    name: 'bare name nowhere',
    value: 'tool',
    path: empty,
    refused: true,
    reason: 'not found on the runner',
  },
  {
    name: 'bare name in relative entry',
    value: 'tool',
    path: 'cwd',
    cwd: root,
    refused: true,
    reason: 'not found on the runner',
  },
  {
    name: 'empty PATH entry with cwd executable',
    value: 'tool',
    path: `${empty}:`,
    cwd: here,
    refused: true,
    reason: 'not found on the runner',
  },
]

const original = process.cwd()
afterEach(() => process.chdir(original))

describe('checkExecutable', () => {
  it.each(ROWS)('$name', ({ value, path, cwd, refused, reason }) => {
    if (cwd !== undefined) process.chdir(cwd)
    if (!refused) {
      expect(() => checkExecutable('CLAUDE_BIN', value, path)).not.toThrow()
      return
    }
    let error: unknown
    try {
      checkExecutable('CLAUDE_BIN', value, path)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ConfigurationError)
    const message = (error as ConfigurationError).message
    expect(message).not.toContain('\n')
    expect(message).toContain('CLAUDE_BIN')
    expect(message).toContain(value)
    expect(message).toContain('absolute path')
    expect(message).toContain('PATH')
    expect(message).toContain(reason ?? '')
  })
})
