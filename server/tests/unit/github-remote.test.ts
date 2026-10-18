import { describe, expect, it } from 'vitest'
import { matchesGithubRepo } from '../../src/modules/projects/repo-inspector.js'

describe('matchesGithubRepo', () => {
  it.each([
    ['https with .git', ['https://github.com/owner/pay.git'], true],
    ['https without .git', ['https://github.com/owner/pay'], true],
    ['ssh', ['git@github.com:owner/pay.git'], true],
    ['ssh url form', ['ssh://git@github.com/owner/pay.git'], true],
    ['different case', ['https://github.com/Owner/Pay.git'], true],
    [
      'one of several remotes',
      ['https://gitlab.com/x/y.git', 'git@github.com:owner/pay.git'],
      true,
    ],
    ['another repository', ['https://github.com/owner/payments.git'], false],
    ['another owner', ['https://github.com/someone/pay.git'], false],
    ['not GitHub', ['https://gitlab.com/owner/pay.git'], false],
    ['no remotes', [], false],
  ])('%s', (_name, remotes, expected) => {
    expect(matchesGithubRepo(remotes, 'owner/pay')).toBe(expected)
  })
})
