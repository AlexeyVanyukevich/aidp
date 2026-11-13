import { describe, expect, it } from 'vitest'
import { diffSections } from '../../src/pr-diff.js'
import { cutLines } from '../../src/verify-cuts.js'

// Each section: header line plus `n - 1` lines of 3 characters.
const big = (path: string, chars: number): string =>
  `diff --git a/${path} b/${path}\n${'y'.repeat(chars - `diff --git a/${path} b/${path}\n`.length - 1)}\n`
const join = (...parts: string[]) => parts.join('')

describe('cutLines', () => {
  const D = 'The diff was '
  const tail = (_n: number) =>
    ` characters. The Verify handoff held its first 60000 and told the verifier to read the rest in verify.diff`
  const three = join(big('a.ts', 40_000), big('b.ts', 20_000 + 5_000), big('c.ts', 5_000))
  const exact = join(big('a.ts', 60_000), big('b.ts', 10_000))
  const lock = join(big('a.ts', 30_000), big('package-lock.json', 40_000))
  const many = Array.from({ length: 26 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
  const manyDiff = join(big('first.ts', 58_500), ...many.map((p) => big(p, 1_000)))

  it.each([
    {
      name: 'a 60,000-character diff and short test output',
      diff: 'd'.repeat(60_000),
      test: 'exit code: 0\nok\n',
      expected: '',
    },
    {
      name: 'cut inside the second of three',
      diff: three,
      paths: ['a.ts', 'b.ts', 'c.ts'],
      expected: `${D}${three.length}${tail(0)}. Files not wholly in the handoff: \`b.ts\`, \`c.ts\`.\n\n`,
    },
    {
      name: 'a section ending exactly at the 60,000th character',
      diff: exact,
      paths: ['a.ts', 'b.ts'],
      expected: `${D}${exact.length}${tail(0)}. Files not wholly in the handoff: \`b.ts\`.\n\n`,
    },
    {
      name: 'only a lockfile past the cut',
      diff: lock,
      paths: ['a.ts', 'package-lock.json'],
      expected: `${D}${lock.length}${tail(0)}. Every file not wholly in the handoff is a lockfile or a generated file.\n\n`,
    },
    {
      name: '25 files past the cut',
      diff: manyDiff,
      paths: ['first.ts', ...many],
      expected: `${D}${manyDiff.length}${tail(0)}. Files not wholly in the handoff: ${many
        .slice(1, 21)
        .map((p) => `\`${p}\``)
        .join(', ')}, and 5 more.\n\n`,
    },
  ])('$name', ({ diff, paths, test, expected }) => {
    const out = cutLines(diff, paths === undefined ? null : diffSections(diff, paths), test ?? '')
    expect(out).toBe(expected)
  })

  it('names the line to read from when the sections are null', () => {
    const diff = `${'x'.repeat(69)}\n`.repeat(1000)
    expect(cutLines(diff, null, '')).toBe(`${D}70000${tail(0)}, from line 858.\n\n`)
  })

  it('adds the test line after the diff line', () => {
    const diff = 'x'.repeat(70_000)
    const test = `exit code: 0\n${'t'.repeat(30_000)}`
    expect(cutLines(diff, null, test)).toBe(
      `${D}70000${tail(0)}, from line 1.\n\nThe test output was ${test.length} characters. The Verify handoff left out 10000 of them, which are in test-output.txt.\n\n`,
    )
  })

  it('writes the test line alone for a short diff', () => {
    const test = `exit code: 0\n${'t'.repeat(30_000)}`
    expect(cutLines('+a\n', null, test)).toMatch(/^The test output was/)
  })
})
