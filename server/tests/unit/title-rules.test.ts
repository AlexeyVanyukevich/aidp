import { describe, expect, it } from 'vitest'
import {
  checkSuggestion,
  suggestionRefusal,
  type TitleFinding,
} from '../../src/modules/mcp/title-rules.js'

const CASES: [string, { title: string; reason: string }, TitleFinding[]][] = [
  ['a good pair', { title: 'Rename drop_draft', reason: 'names drop_draft' }, []],
  ['a title of 200', { title: 'x'.repeat(200), reason: 'r' }, []],
  ['a reason of 300', { title: 't', reason: 'r'.repeat(300) }, []],
  ['a blank title', { title: '   ', reason: 'r' }, [{ field: 'title', code: 'blank' }]],
  ['an empty title', { title: '', reason: 'r' }, [{ field: 'title', code: 'blank' }]],
  [
    'a title over 200',
    { title: 'x'.repeat(201), reason: 'r' },
    [{ field: 'title', code: 'too_long' }],
  ],
  [
    'a title with a line break',
    { title: 'a\nb', reason: 'r' },
    [{ field: 'title', code: 'multiline' }],
  ],
  [
    'a reason over 300',
    { title: 't', reason: 'r'.repeat(301) },
    [{ field: 'reason', code: 'too_long' }],
  ],
  [
    'a reason with a line break',
    { title: 't', reason: 'a\r\nb' },
    [{ field: 'reason', code: 'multiline' }],
  ],
  ['a blank reason', { title: 't', reason: ' ' }, [{ field: 'reason', code: 'blank' }]],
]

describe('checkSuggestion', () => {
  it.each(CASES)('%s', (_name, input, findings) => {
    expect(checkSuggestion(input)).toEqual(findings)
  })

  it('names the field in the refusal', () => {
    expect(suggestionRefusal([{ field: 'reason', code: 'too_long' }])).toContain(
      'reason: at most 300',
    )
  })
})
