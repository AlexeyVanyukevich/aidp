import { describe, expect, it } from 'vitest'
import { AGENTS, PHASES } from '../../src/phases/agents.js'
import { GENERATED_SUFFIXES, LOCKFILES } from '../../src/pr-diff.js'

// The fake claude calls the board's MCP server directly, past Claude Code's tool lists, so the
// scenarios cannot see a tool a phase is not allowed. This can (slice 2 spec, §5).
describe('the agents', () => {
  it.each(['plan', 'build', 'verify'] as const)('lets the %s phase ask the owner', (phase) => {
    expect(PHASES[phase].tools).toContain('mcp__board__request_approval')
    expect(AGENTS[PHASES[phase].agent]?.tools).toContain('mcp__board__request_approval')
  })

  it.each(['planner', 'builder', 'verifier', 'spec-writer'])(
    'tells the %s when to ask, and to stop after',
    (agent) => {
      const prompt = AGENTS[agent]!.prompt
      expect(prompt).toContain('request_approval')
      expect(prompt).toMatch(/end your turn/i)
    },
  )

  it('tells the planner the limit on a plan’s length', () => {
    expect(AGENTS.planner!.prompt).toContain('20,000')
  })

  it('tells the planner a previous plan is a starting point to revise, not to carry out', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('<previous_plan>')
    expect(prompt).toContain('starting point')
    expect(prompt).toContain('Never carry it out')
    expect(prompt).toContain('accepted="no"')
    expect(prompt).toContain('never approved by the owner')
  })

  it('tells the planner what the approval note is', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('<approval_note>')
    expect(prompt).toContain('given at the spec gate')
    expect(prompt).toContain('not a criterion')
    expect(prompt).toContain('never overrides the spec')
    expect(prompt).toContain('the answer wins')
  })

  it('tells the planner to keep the owner’s plan gate answers', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('<plan_answer>')
    expect(prompt).toContain('keeps every correction')
    expect(prompt).toContain('names that correction and says why')
    expect(prompt).toContain('the newer one wins')
    expect(prompt).toContain('<plan_answers_left_out>')
  })

  it('tells the builder to follow the commit rules and never bypass hooks', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toContain('splitting the work into commits')
    expect(prompt).toContain('Never bypass git hooks')
    expect(prompt).toContain('rewrite the message and commit again')
  })

  it('tells the builder how to make a send-back’s changes (AC11)', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('<changes_note>')
    expect(prompt).toContain('git commit --fixup')
    expect(prompt).toContain('GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash')
    expect(prompt).toContain(
      'change that belongs to no commit of the branch gets a commit of its own',
    )
    expect(prompt).toContain('never a criterion')
  })

  it('tells the verifier to list each point of the changes note, with no verdict (AC11)', () => {
    const prompt = AGENTS.verifier!.prompt
    expect(prompt).toContain('<changes_note>')
    expect(prompt).toContain('lists each point of the note')
    expect(prompt).toContain('whether the branch made it')
    expect(prompt).toContain('The list sets no verdict')
  })

  const NOTE_PHRASES: [string, string, string][] = [
    ['builder', '<plan_note>', 'names the element'],
    ['builder', 'condition on the approved plan', 'says what it is'],
    ['builder', 'never overrides the spec', 'keeps the spec above it'],
    ['builder', 'out_of_plan', 'sends a file the plan lacks to the owner'],
    ['builder', 'Decision:', 'follows a decision line'],
    ['builder', 'Open choice, ask me:', 'asks about an open choice'],
    ['verifier', '<plan_note>', 'names the element'],
    ['verifier', 'each point of the note', 'lists the points'],
    ['verifier', 'sets no verdict', 'changes no verdict'],
    ['verifier', 'context only', 'treats another run’s note as context'],
    ['helper', 'Approve plan with a short note', 'suggests a note'],
    ['helper', 'goes into the note for the builder', 'writes a next-gate finding for the builder'],
  ]
  it.each(NOTE_PHRASES)('the %s prompt contains “%s” (%s)', (agent, phrase) => {
    expect(AGENTS[agent]!.prompt.toLowerCase()).toContain(phrase.toLowerCase())
  })
  it('no longer tells the helper “never both”', () => {
    expect(AGENTS.helper!.prompt.toLowerCase()).not.toContain('never both')
  })

  it('tells the helper that fix_by_hand sends the blockers to a builder on the same branch (AC15)', () => {
    expect(AGENTS.helper!.prompt).toContain(
      'fix_by_hand sends the blockers to a builder on the same branch and pull request, keeping the plan',
    )
  })

  it('tells the builder a migration needs an approval', () => {
    expect(AGENTS.builder!.prompt).toContain('kind migration')
  })

  it('tells the builder to ask for a file the plan does not list, not to report it', () => {
    expect(AGENTS.builder!.prompt).toContain('kind out_of_plan')
    expect(AGENTS.builder!.prompt).not.toContain('say in your report which file')
  })
})

// Slice 3 spec §5: the spec-writer reads and asks; it writes nothing but the spec.
describe('the spec-writer', () => {
  const TOOLS = [
    'Read',
    'Grep',
    'Glob',
    'mcp__board__get_task',
    'mcp__board__get_spec',
    'mcp__board__list_projects',
    'mcp__board__list_tasks',
    'mcp__board__read_task',
    'mcp__board__propose_task',
    'mcp__board__list_proposals',
    'mcp__board__save_spec',
    'mcp__board__log_step',
    'mcp__board__request_approval',
  ]

  it('drafts on Opus at high effort, with read tools and the board alone', () => {
    expect(PHASES.spec).toEqual({
      agent: 'spec-writer',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      tools: TOOLS,
    })
    expect(AGENTS['spec-writer']).toMatchObject({ model: 'opus', tools: TOOLS })
  })

  it('asks every open question in one batch, saves, and leaves Open questions empty', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('kind questions')
    expect(prompt).toContain('save_spec')
    expect(prompt).toMatch(/leave .*Open questions.* empty/i)
  })

  // Task 4's recording: told only the sections' names, Opus bolded its ids, which the parser
  // does not read. The template, word for word, shows the form the lint reads.
  it('carries the Spec tab’s template word for word', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('## Requirements\n1. R1 – testable statement')
    expect(prompt).toContain('## Acceptance criteria\n- AC1 (R1): Given … When … Then …')
    expect(prompt).toContain('## Open questions')
  })

  it('tells the spec-writer to write only items under Requirements and Acceptance criteria', () => {
    const prompt = AGENTS['spec-writer']?.prompt ?? ''
    expect(prompt).toContain(
      'write only items, with no lead-in sentence, and indent a line that continues an item',
    )
  })

  it('tells the spec-writer to prefer checkable criteria and to mark the rest owner', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('(R3, owner)')
    expect(prompt).toContain('Prefer a criterion a run can check')
  })
})

const SPEC_WRITER_RULES: { rule: string; clause: string }[] = [
  {
    rule: 'a criterion’s evidence is something a run holds while Verify runs',
    clause:
      'A criterion’s evidence is something a run holds while Verify runs: the branch’s files and diff, the test command’s output, a command run on the branch’s tree, the build’s closing paragraph, or the board.',
  },
  {
    rule: 'a base-run criterion says the builder makes and reports the run',
    clause:
      'A criterion that needs a run on the base’s code or the base commit says that the builder makes the run and reports it in its closing paragraph, with the criterion id, the command, the base commit, the counts and the quoted result lines.',
  },
  {
    rule: 'no criterion whose Then holds only by chance',
    clause:
      'Never write a criterion whose Then holds only by chance, such as a flaky failure showing in some number of runs. An attempt to reproduce one is a requirement the builder reports on, with no criterion, and the criterion goes on a deterministic proof.',
  },
  {
    rule: 'no criterion on the session’s review',
    clause:
      'Never write a criterion on the session’s review, which no run writes. Ask for the build’s closing paragraph instead.',
  },
]

describe('the spec-writer’s rules for evidence', () => {
  it.each(SPEC_WRITER_RULES)('says $rule', ({ clause }) => {
    expect(AGENTS['spec-writer']!.prompt).toContain(clause)
  })
})

const VERIFIER_TEST_RULES: { rule: string; clause: string }[] = [
  {
    rule: 'a passing command is evidence for a test in a suite it runs',
    clause: 'A passing test command is evidence for a test inside a suite that command runs',
  },
  {
    rule: 'the branch’s files show the test exists',
    clause: 'once the branch’s files show that the test exists',
  },
  {
    rule: 'the suites are read from the step lines',
    clause: 'Tell which suites ran from the step lines in the test output',
  },
  {
    rule: 'the suites of check:all',
    clause:
      '`./run check:all` runs the server, runner and web suites, and the browser journeys in `tests/ui/`',
  },
  {
    rule: 'a suite with no step line counts as not run',
    clause:
      'neither <test_output> nor `test-output.txt` counts as not run, so run the named test yourself',
  },
  { rule: 'why a step line may be cut', clause: 'the runner keeps only the last 64 KiB' },
  {
    rule: 'a test is run only when its suite did not run or it failed or flaked',
    clause:
      'Run a test yourself only when the test command did not run that test’s suite, or when the test output shows that test failing or flaky',
  },
  {
    rule: 'only that test, with an example',
    clause: '`npx playwright test tests/ui/<file>.spec.ts`, never a whole suite',
  },
  {
    rule: 'the command and output lines are cited',
    clause: 'cites the exact command and the output lines',
  },
  {
    rule: 'a green command is no evidence for another suite',
    clause: '“check exit 0”, is never evidence for a test that command does not run',
  },
  {
    rule: 'a test that cannot run fails',
    clause: 'the verdict is fail, and its evidence starts with `not run:`',
  },
  {
    rule: 'the summary names flaky tests',
    clause: 'Your summary names every test the test output marks flaky',
  },
  {
    rule: 'the quoted line must show a failure once everything the test imports has loaded',
    clause:
      'The quoted line must show the test failing once every file and name it imports has loaded: one of the test’s own assertions failing, such as an expect or assert message, Playwright’s expect timing out, or an error thrown by the code under test or by the test’s use of its result, such as `Cannot read properties of undefined`. A line that shows a file, module or export missing or failing to load, such as `Cannot find module`, `does not provide an export named` or `is not a function` for a name the base lacks or the code has not added yet, is no proof, whichever way the run was made. When such a line is all the entries give for a test, the `never seen failing:` evidence says the line shows only a load failure.',
  },
  {
    rule: 'a proof that kept the tested file whole is no proof',
    clause:
      'An entry whose stubs list kept whole a file or a name the test tests, rather than stubbing it, is no proof, since with it whole the failure cannot come from the missing code.',
  },
  {
    rule: 'any Build’s entry may prove a test, for the test as that attempt left it, and the attempt is named',
    clause:
      'A test has proof when any Build’s entry gives proof that meets these rules. A proof counts only for the test as that build attempt left it: when a later Build’s entry for the test sets changed_assertions to yes, only proof from that attempt or a later one counts. Read every Build’s entries before you rule that none does, and in the evidence for a criterion name, for each test it rests on, the build attempt whose entry you used, as in `Build 3`.',
  },
  {
    rule: 'a test is evidence for a criterion only when it would fail if the Then did not hold',
    clause:
      'A test is evidence for a criterion only when it would fail if the criterion’s Then did not hold in the case the test sets up',
  },
  {
    rule: 'a test cannot fail when a change that breaks the Then leaves it passing',
    clause:
      'A test cannot fail when a change to the code that breaks the Then, in the case the test sets up, would leave it passing',
  },
  {
    rule: 'a test that can fail but not when the Then breaks cannot fail either',
    clause: 'a test that can never fail at all, and one that can fail but not when the Then breaks',
  },
  {
    rule: 'a test covering fewer cases than the Then is not weak for that alone',
    clause: 'A test that covers fewer cases than the Then is not weak for that reason alone',
  },
  { rule: 'example: a value compared with itself', clause: 'a value compared with itself' },
  { rule: 'example: no assertion', clause: 'a test with no assertion' },
  {
    rule: 'example: the code under test mocked away',
    clause: 'a test where the code under test is mocked away',
  },
  {
    rule: 'example: an assertion weaker than the Then',
    clause:
      'an assertion weaker than the Then, such as checking that a file exists when the Then says it holds HEAD',
  },
  {
    rule: 'each cited test gets a line on what its assertion checks and why it would fail',
    clause:
      'say in one line what the test’s assertion checks and why that assertion would fail if the criterion’s Then did not hold in the case the test sets up',
  },
  {
    rule: 'a test that cannot fail fails a criterion that asks for one',
    clause:
      'When a criterion asks for a test and that test cannot fail, the verdict is fail, and its evidence starts with `test proves nothing:`, names the test, and says what change to the code it would not catch.',
  },
  {
    rule: 'the fail extends to every test written for a criterion',
    clause:
      'This fail extends to every test written for a criterion: once you find such a test and it cannot fail, the criterion fails',
  },
  {
    rule: 'the fail holds whether or not the criterion asks for a test or the test is cited',
    clause:
      'whether or not the criterion asks for a test, whether or not you cite that test, and whatever other evidence you read, save the one exception below',
  },
  {
    rule: 'the extended fail takes the test proves nothing form',
    clause: 'Its evidence takes the `test proves nothing:` form.',
  },
  {
    rule: 'a test written for a criterion is named by the plan’s check',
    clause: 'the test the plan’s check for that criterion names',
  },
  {
    rule: 'a test written for a criterion is one the diff adds or changes, named by its id',
    clause: 'a test the branch’s diff adds or changes whose name carries the criterion’s id',
  },
  {
    rule: 'a test the diff leaves untouched is never written for a criterion by name alone',
    clause: 'a test the diff leaves untouched is never written for a criterion by its name alone',
  },
  {
    rule: 'a criterion asks for a test when its text names a test, suite or run',
    clause:
      'A criterion asks for a test when its own text names a test, a test suite or a test run to settle it',
  },
  {
    rule: 'a criterion about the diff’s own content may pass on a line of the diff',
    clause:
      'a criterion that does not ask for a test may still pass on a line of the diff if it is about the diff’s own content',
  },
  {
    rule: 'the exception never cites the weak test as evidence',
    clause: 'and never with that test as its evidence',
  },
  {
    rule: 'the exception gives an example of a criterion about the diff’s own content',
    clause: 'such as a file holding a given text or a line staying unchanged',
  },
  {
    rule: 'the verifier looks for the proof in the saved build reports',
    clause:
      'For each test written for a criterion that the branch’s diff adds or changes, look for its proof in <build_reports>, the entries each Build saved with save_build_report. The proof is an entry with the test’s name, the command, which way the run was made, and the quoted failing line. The board saved it only once it found that command among the Build’s own Bash calls and that line in their output. A build summary is never proof, whatever it says, and neither is a test no entry names.',
  },
  {
    rule: 'a test with no proof fails the criterion with never seen failing',
    clause:
      'the criterion fails, and its evidence starts with `never seen failing:`, names the test and says what the saved entries lack',
  },
  {
    rule: 'an untouched test needs no proof',
    clause:
      'A test written for a criterion that the diff leaves untouched needs no proof, and never fails a criterion under this rule',
  },
  {
    rule: 'a guard reason holds only when the base’s code shows the behaviour',
    clause:
      'Accept guards_base only when the base’s code already shows the behaviour, which you judge from the branch’s files the diff leaves unchanged and the lines the diff removes',
  },
  {
    rule: 'a refactor reason holds only when the assertions are unchanged',
    clause: 'Accept refactor only when the diff leaves the test’s assertions the same as before',
  },
  {
    rule: 'a cannot_run entry is no proof',
    clause: 'An entry with reason cannot_run is no proof.',
  },
  {
    rule: 'a reason that does not hold is no proof',
    clause:
      'A reason given only in a build summary is no proof, and neither is a reason that does not hold.',
  },
  {
    rule: 'the never seen failing fail covers only tests written for a criterion',
    clause:
      'The `never seen failing:` fail covers only tests written for a criterion that the branch’s diff adds or changes',
  },
  {
    rule: 'a test written for no criterion is named in the summary and never fails one',
    clause:
      'A test the diff adds or changes that is written for no criterion, and has neither proof nor an accepted reason, is named in your summary and never fails a criterion',
  },
  {
    rule: 'a base-run criterion’s evidence is the builder’s report in the build summaries',
    clause:
      'Evidence for a criterion that asks for a run on the base’s code or on the base commit is the base-run report in the build summaries in <context>: the criterion’s id, the command, the base commit’s hash, the counts and the quoted output lines.',
  },
  {
    rule: 'the verifier judges a base run from the report and never makes it',
    clause:
      'Judge such a criterion’s Then from the report’s counts and quoted lines, and never make the run yourself. A report whose counts make the Then hold passes the criterion.',
  },
  {
    rule: 'a missing or incomplete base-run report fails with no base-run report',
    clause:
      'When no summary has the report, or the report leaves out the id, the command, the base commit, the counts or the quoted lines, the criterion fails, and its evidence starts with `no base-run report:` and says what is missing.',
  },
  {
    rule: 'a criterion on the closing paragraph or the session’s review is judged from the build summaries',
    clause:
      'Evidence for a criterion that asks for something in the build’s closing paragraph or in “the session’s review” is the build summaries in <context>.',
  },
  {
    rule: 'an unmarked criterion gets owner with not checkable in a run in two cases',
    clause:
      'A criterion not marked owner gets owner, with evidence that starts with `not checkable in a run:` and then the reason, in exactly two cases.',
  },
  {
    rule: 'case (a) needs something no route holds, and visibly wrong work still fails',
    clause:
      '(a) it needs something that none of these routes holds: the branch’s files and diff, the test output, a command run on the branch’s tree, the build summaries, or the board through list_tasks and list_proposals; a criterion whose work you can see is wrong still gets fail.',
  },
  {
    rule: 'case (b) needs a report showing at least the runs asked for, with counts',
    clause:
      '(b) its Then depends on an outcome no run can force, such as a flake showing, and a base-run report shows that the runs the criterion asks for were made, with counts at least the number it asks for.',
  },
  {
    rule: 'a case (b) criterion with a missing report or fewer runs fails',
    clause:
      'A case (b) criterion whose report is missing, or shows fewer runs than asked for, fails with evidence that starts with `no base-run report:`.',
  },
]

const BUILDER_TEST_RULES: { rule: string; clause: string }[] = [
  {
    rule: 'each test without an entry is proved through save_build_report, and only saved entries count',
    clause:
      'For each test the branch adds or changes that no entry in <build_reports> already proves, save its proof with save_build_report: the test’s name, as its file and its title, the command you ran, which way the run was made, before_code or against_base, and the line of output where the test failed. The command must be exactly the Bash command you ran in this Build, and the line must be copied from that command’s output: save_build_report refuses an entry otherwise and says why. Save each proof as soon as you see the test fail; a later save for the same test replaces the earlier one. On a later attempt this covers every such test of the branch, not only the tests that attempt adds or changes. Before you end any attempt, run against the base’s code, as above, each test the branch adds or changes that you have not seen failing and that no entry proves. When that run cannot be made, save the test with reason cannot_run and say why. Only saved entries count as proof: a proof written only in your closing paragraph does not.',
  },
  {
    rule: 'stubs are listed in the entry, and a changed test is proved again',
    clause:
      'When a run kept a file or name whole or stubbed it, list each in the entry’s stubs, with its file, its name when it is one name, and whether it was kept whole or stubbed. A test this attempt changes is proved again in this attempt, even when an earlier entry proved it, and its entry sets changed_assertions to true when the change touched the test’s assertions.',
  },
  {
    rule: 'a test that cannot fail on the base is saved with a reason',
    clause:
      'A test that cannot fail on the base is saved with a reason instead of a failing run: guards_base, for guards behaviour the base already has, or refactor, for changed only by a refactor, with why it holds.',
  },
  {
    rule: 'the builder ends by saving every proof not yet saved',
    clause:
      'Finish by saving with save_build_report every proof not yet saved, then reply with one paragraph.',
  },
  {
    rule: 'each test is written and run before the code, and seen failing',
    clause:
      'For each test the build adds or changes, write the test and run it before you write the code it tests, and see it fail',
  },
  {
    rule: 'the against-the-base run happens once the code is committed',
    clause: 'Run it only once the code is committed',
  },
  {
    rule: 'the base is the merge-base with the base element’s branch',
    clause:
      'the base is the commit `git merge-base HEAD origin/<branch>`, where <branch> is the branch of the <base> element',
  },
  {
    rule: 'the base’s version of the plan’s code files is put back, the new tests kept',
    clause:
      'Put back the base’s version of the plan’s code files the test exercises, keeping the new tests',
  },
  {
    rule: 'a code file the base does not have is removed',
    clause:
      'A code file the base does not have is removed, unless the test imports it: then keep it whole or stub it, as below.',
  },
  {
    rule: 'seeing a test fail means it failed once everything it imports has loaded',
    clause:
      'Seeing a test fail means seeing it fail once every file and name it imports has loaded: one of its own assertions failing, or an error thrown by the code under test or by the test’s use of its result. A failure because a file, module or export is missing or cannot load, such as `Cannot find module`, or `is not a function` for a name the file does not export, is not seeing it fail, whichever way the run is made.',
  },
  {
    rule: 'a file or name the test imports is stubbed, or kept whole when the test does not test it',
    clause:
      'When a test imports a file that does not exist yet, before the code, or that the base does not have, against the base, give that file a stub so the test loads: a stub exports the same names as the file but does not do the work, for example a function that returns undefined. When a test imports a name that its file does not export, as the file stands before the code or as the base’s copy you put back, add a stub of that name to the file in the same way. Keep such a file or name whole instead only when the test does not test it, such as a new fixture or helper the test imports: keeping the code under test whole lets the test pass, which proves nothing. A stub is never committed: before the code, the code replaces it before you commit; against the base, you restore it with the other files.',
  },
  {
    rule: 'every file is restored before any further edit or commit',
    clause:
      'restore every file you put back or removed with `git checkout HEAD -- <file>`, at once, before any further edit or commit',
  },
  {
    rule: 'the guard reason',
    clause: 'guards behaviour the base already has',
  },
  {
    rule: 'the refactor reason',
    clause: 'changed only by a refactor',
  },
  {
    rule: 'the builder makes a run on the base for a criterion that asks for one, once the code is committed',
    clause:
      'When a criterion asks for a run on the base’s code or on the base commit, make that run once the code is committed, by the against-the-base procedure above.',
  },
  {
    rule: 'the base-run puts back the criterion’s files, or every changed file for the base commit',
    clause:
      'Put back the base’s version of the files the criterion puts at the base or, for a run on the base commit, of every file the branch changes, and remove a file the base does not have.',
  },
  {
    rule: 'the base-run command runs as many times as the criterion asks',
    clause: 'Run the command the criterion names as many times as the criterion asks.',
  },
  {
    rule: 'the base-run files are restored before any further edit or commit',
    clause:
      'restore every file with `git checkout HEAD -- <file>` at once, before any further edit or commit, as above.',
  },
  {
    rule: 'the closing paragraph reports id, command, base hash, counts and quoted lines',
    clause:
      'report each such run in your closing paragraph: the criterion’s id, the command, the base commit’s hash, the counts (runs made, passed and failed) and the quoted output lines that show the result.',
  },
  {
    rule: 'a later attempt reports every base-run criterion no summary reports',
    clause:
      'On a later attempt, report every such criterion that no summary in <context> already reports.',
  },
  {
    rule: 'the closing paragraph gives what a criterion asks of it or of the session’s review',
    clause:
      'When a criterion asks for something in your closing paragraph or in “the session’s review”, your closing paragraph gives it.',
  },
]

describe('the builder’s rules for seeing a test fail', () => {
  it.each(BUILDER_TEST_RULES)('says $rule', ({ clause }) => {
    expect(AGENTS.builder!.prompt).toContain(clause)
  })

  it('names no build_report tag and offers the tool', () => {
    expect(AGENTS.builder!.prompt).not.toMatch(/<build_report[ />]/)
    expect(PHASES.build.tools).toContain('mcp__board__save_build_report')
  })

  it('no longer lets a builder admit a missing run without trying', () => {
    expect(AGENTS.builder!.prompt).not.toContain(
      'A test you never saw failing, say so in plain words',
    )
  })
})

describe('the verifier’s rules for tests', () => {
  it('no longer reads proof from the build summaries', () => {
    for (const phrase of [
      'look for its proof in the build summaries',
      'says what the summaries lack',
    ])
      expect(AGENTS.verifier!.prompt).not.toContain(phrase)
  })

  it('no longer says every other criterion never gets owner without exception', () => {
    expect(AGENTS.verifier!.prompt).not.toContain(
      'Every other criterion gets pass or fail, never owner.',
    )
  })

  it.each(VERIFIER_TEST_RULES)('says $rule', ({ clause }) => {
    expect(AGENTS.verifier!.prompt).toContain(clause)
  })
})

describe('the owner check in the prompts', () => {
  it('tells the planner to name the hand check and what a run can still check', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('names the hand check the owner will do')
    expect(prompt).toContain('anything a run can still check')
  })

  it('tells the verifier which criteria take owner and that fail still applies', () => {
    const prompt = AGENTS.verifier!.prompt
    expect(prompt).toContain('owner check')
    expect(prompt).toContain('gets fail when you can see the work is wrong')
    expect(prompt).toContain('never gets pass')
    expect(prompt).toContain('not back to Build')
  })

  it('tells the builder which Bash commands may change files, and to delete generated ones', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('only with Edit and Write')
    expect(prompt).toContain('may change only the plan’s files, as a formatter does or git rm does')
    expect(prompt).toContain('undo such a change')
    expect(prompt).toContain('git checkout')
    expect(prompt).toContain('generated that the plan does not list')
    expect(prompt).toContain('is deleted, and never committed')
  })

  it('tells the builder uncommitted changes are undone before the test command runs', () => {
    const prompt = AGENTS.builder!.prompt
    expect(prompt).toContain('Before the test command runs, the runner undoes every change')
    expect(prompt).toContain('Only commits are tested, verified and pushed')
  })
})

interface PhraseRow {
  agent: string
  present: string[]
  absent: string[]
}
const PHRASES: PhraseRow[] = [
  {
    agent: 'verifier',
    present: [
      'withdrawn',
      'Withdrawn by the owner',
      'plan-gate answers',
      'the owner’s answer',
      'never goes back to Build',
    ],
    absent: ['judge it only by the spec, the diff and the test output'],
  },
  {
    agent: 'planner',
    present: [
      'withdrawn',
      'changed criterion',
      'quotes the owner’s',
      'no row in the checks table',
      'never has confidence high',
    ],
    absent: ['every acceptance criterion gets a check'],
  },
]

describe('the withdrawal wording', () => {
  it.each(PHRASES)('is in the $agent prompt', ({ agent, present, absent }) => {
    const prompt = AGENTS[agent]!.prompt.toLowerCase()
    for (const phrase of present) expect(prompt).toContain(phrase.toLowerCase())
    for (const phrase of absent) expect(prompt).not.toContain(phrase.toLowerCase())
  })
})

describe('the title phase', () => {
  it('runs title-writer on Sonnet at medium effort with exactly its tools', () => {
    expect(PHASES.title).toMatchObject({ agent: 'title-writer', model: 'sonnet', effort: 'medium' })
    expect([...PHASES.title.tools].sort()).toEqual(
      [
        'Read',
        'Grep',
        'Glob',
        'mcp__board__get_task',
        'mcp__board__suggest_title',
        'mcp__board__log_step',
      ].sort(),
    )
    expect(AGENTS['title-writer']?.tools).toEqual(PHASES.title.tools)
    expect(AGENTS['title-writer']?.model).toBe('sonnet')
  })

  it('has no way to edit, run a command, delegate or ask', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'Agent', 'mcp__board__request_approval'])
      expect(PHASES.title.tools).not.toContain(tool)
  })

  it('tells the agent to read the code, name it in its own terms, and suggest when unsure', () => {
    const prompt = AGENTS['title-writer']!.prompt
    expect(prompt).toContain('Read the code the task touches')
    expect(prompt).toContain('code’s own terms')
    expect(prompt).toContain('still suggest your best title')
  })
})

describe('the helper', () => {
  const helper = AGENTS.helper!

  it('reads and saves, on Opus at high effort, with exactly these tools', () => {
    expect(PHASES.help).toMatchObject({ agent: 'helper', model: 'opus', effort: 'high' })
    expect(helper.model).toBe('opus')
    expect(PHASES.help.tools.toSorted()).toEqual(
      [
        'Read',
        'Grep',
        'Glob',
        'mcp__board__get_task',
        'mcp__board__get_spec',
        'mcp__board__get_question',
        'mcp__board__get_decision',
        'mcp__board__get_phase_record',
        'mcp__board__list_projects',
        'mcp__board__list_tasks',
        'mcp__board__read_task',
        'mcp__board__save_help_result',
      ].toSorted(),
    )
    expect(helper.tools).toEqual(PHASES.help.tools)
    expect(PHASES.help.tools).not.toContain('mcp__board__request_approval')
  })

  it.each([
    [
      'answers one question, or in suggest_all mode every question of the batch',
      'You answer this one question only, except in suggest_all mode, where you answer every question of the batch.',
    ],
    ['writes nothing', 'You write nothing'],
    [
      'says where it is unsure rather than guessing',
      'Say where you are unsure rather than guessing',
    ],
    ['in explain mode neither changes what is asked nor recommends', 'Do not change what is asked'],
    ['in explain mode carries no recommendation', 'no option and no recommendation'],
  ])('tells the helper it %s', (_name, words) => {
    expect(helper.prompt).toContain(words)
  })
})

describe('the helper’s independence from the asking agent', () => {
  const prompt = AGENTS.helper!.prompt

  it('does not list a recommendation among what get_question returns', () => {
    expect(prompt).not.toContain('options and recommendation')
    const lists = prompt
      .split('\n\n')
      .filter((p) => p.includes('get_question returns'))
      .join('\n')
    expect(lists).not.toContain('recommendation')
  })

  it.each([
    [
      'says the question and its context are the asking agent’s and may argue for one option',
      'written by the asking agent and may argue for one option',
    ],
    ['chooses from the code, the task and the spec', 'choose from the code, the task and the spec'],
    ['names what in the code settles the choice', 'name what in the code settles your choice'],
    ['names batch_context_md', 'batch_context_md'],
    [
      'says batch_context_md is the context the owner sees above the batch',
      'the context the owner sees above the batch',
    ],
  ])('tells the helper it %s', (_name, words) => {
    expect(prompt).toContain(words)
  })
})

describe('the board-reading tools', () => {
  const NEW = ['list_projects', 'list_tasks', 'read_task'].map((t) => `mcp__board__${t}`)
  const CURRENT = {
    build: [
      'Read',
      'Edit',
      'Write',
      'Bash',
      'mcp__board__get_task',
      'mcp__board__get_spec',
      'mcp__board__list_tasks',
      'mcp__board__read_task',
      'mcp__board__propose_task',
      'mcp__board__list_proposals',
      'mcp__board__log_step',
      'mcp__board__request_approval',
      'mcp__board__save_build_report',
    ],
    verify: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Agent',
      'mcp__board__get_task',
      'mcp__board__get_spec',
      'mcp__board__list_tasks',
      'mcp__board__read_task',
      'mcp__board__propose_task',
      'mcp__board__list_proposals',
      'mcp__board__save_report',
      'mcp__board__log_step',
      'mcp__board__request_approval',
    ],
    title: [
      'Read',
      'Grep',
      'Glob',
      'mcp__board__get_task',
      'mcp__board__suggest_title',
      'mcp__board__log_step',
    ],
    rephrase: [
      'Read',
      'Grep',
      'Glob',
      'mcp__board__get_task',
      'mcp__board__save_suggestion',
      'mcp__board__log_step',
    ],
  } as const
  it.each(['spec', 'plan', 'help'] as const)('gives the %s phase the three tools', (phase) => {
    for (const tool of NEW) expect(PHASES[phase].tools).toContain(tool)
  })
  it.each(Object.entries(CURRENT))('leaves the %s phase’s tools as they were', (phase, tools) => {
    expect(PHASES[phase as keyof typeof CURRENT].tools).toEqual(tools)
  })

  it('tells the spec writer to read the board and name related tasks', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('<linked_projects>')
    expect(prompt).toContain('project key')
    expect(prompt).toContain('## Context')
    expect(prompt).toContain('projects you searched')
  })
  it('tells the planner to read the board and say which tasks it takes in', () => {
    const prompt = AGENTS.planner!.prompt
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('<linked_projects>')
    expect(prompt).toContain('takes it in or leaves it out')
  })
  it('tells the helper to check the board', () => {
    const prompt = AGENTS.helper!.prompt
    expect(prompt).toContain('read_task')
    expect(prompt).toContain('list_tasks')
    expect(prompt).toContain('whether a task exists')
  })
})

describe('proposing a finding', () => {
  const PROPOSE = ['propose_task', 'list_proposals'].map((t) => `mcp__board__${t}`)
  it.each(['spec', 'plan', 'build', 'verify'] as const)(
    'gives the %s phase the proposal tools',
    (phase) => {
      for (const tool of PHASES[phase].tools.length > 0 ? PROPOSE : [])
        expect(PHASES[phase].tools).toContain(tool)
    },
  )
  it.each(['build', 'verify'] as const)('gives the %s phase list_tasks and read_task', (phase) => {
    expect(PHASES[phase].tools).toContain('mcp__board__list_tasks')
    expect(PHASES[phase].tools).toContain('mcp__board__read_task')
  })
  it.each(['help', 'title', 'rephrase'] as const)(
    'keeps the proposal tools from the %s phase',
    (phase) => {
      for (const tool of PROPOSE) expect(PHASES[phase].tools).not.toContain(tool)
    },
  )
  it('keeps the proposal tools from a helper', async () => {
    const { HELP_TOOLS } = await import('../../src/hooks/guard.js')
    for (const tool of PROPOSE) expect(HELP_TOOLS.has(tool)).toBe(false)
  })

  interface Row {
    agent: string
    ends: string
    unrelated: boolean
  }
  const rows: Row[] = [
    { agent: 'spec-writer', ends: 'the closing paragraph', unrelated: false },
    { agent: 'planner', ends: 'the plan summary', unrelated: false },
    { agent: 'builder', ends: 'your closing paragraph', unrelated: true },
    { agent: 'verifier', ends: 'the verify report’s summary', unrelated: true },
  ]
  describe.each(rows)('the $agent’s prompt', ({ agent, ends, unrelated }) => {
    const prompt = AGENTS[agent]!.prompt
    it.each([
      'propose_task',
      'list_tasks',
      'list_proposals',
      'Where, Found, Problem, Impact',
      'task’s own project or in a project in <linked_projects>',
      'never with the board’s HTTP API',
      'the curl line in CLAUDE.md’s Findings rule is for sessions outside a run',
      `Name each proposal you made in ${ends}`,
      'once the cap refuses one, list the remaining findings there',
    ])('says %s', (words) => {
      expect(prompt).toContain(words)
    })
    it('never has the agent file a task itself', () => {
      expect(prompt).not.toMatch(
        /\b(file|filing) (an? (task|finding|proposal)|the (task|finding|proposal)|this (task|finding|proposal))/i,
      )
      expect(prompt).not.toMatch(/\byou (file|filed)\b/i)
    })
    it(
      unrelated ? 'says every finding is unrelated' : 'tells of the pause and the workaround',
      () => {
        if (unrelated) {
          expect(prompt).toContain('Every finding you propose is unrelated')
          expect(prompt).toContain('goes through request_approval')
        } else {
          expect(prompt).toContain('pauses the run until the owner settles it')
          expect(prompt).toContain('workaround_md')
        }
      },
    )
  })

  // Each row: a case, its verdict, and the clause of the verifier's prompt that settles it.
  const verifier: { case: string; verdict: 'passes' | 'fails'; clause: string }[] = [
    {
      case: 'an open proposal of this run matches',
      verdict: 'passes',
      clause: 'a matching proposal of any run of this task that is open or filed',
    },
    {
      case: 'a filed proposal of an earlier run matches',
      verdict: 'passes',
      clause: 'any run of this task',
    },
    {
      case: 'a task filed by hand is found by list_tasks',
      verdict: 'passes',
      clause: 'list_tasks finds a matching task in the target project',
    },
    {
      case: 'only a dismissed proposal matches',
      verdict: 'fails',
      clause: 'A dismissed proposal never counts',
    },
    { case: 'nothing matches', verdict: 'fails', clause: 'with neither the criterion fails' },
  ]
  it.each(verifier)('the verifier $verdict when $case', ({ clause }) => {
    expect(AGENTS.verifier!.prompt).toContain(clause)
    expect(AGENTS.verifier!.prompt).toContain('(outcome `file` or `workaround`)')
  })
  it('tells the helper how to advise on a proposal', () => {
    expect(AGENTS.helper!.prompt).toContain('advise:')
    expect(AGENTS.helper!.prompt).toContain('recommend one offered variant')
  })
})

describe('the helper’s instructions for a pull request review', () => {
  const prompt = AGENTS.helper!.prompt
  const rows: { name: string; words: string }[] = [
    { name: 'it names the mode', words: 'code_review:' },
    { name: 'it reads the diff by section with offset and limit', words: 'section by section' },
    { name: 'it limits a part to 1,000 lines', words: 'parts of at most 1,000 lines' },
    { name: 'it uses Read’s offset and limit', words: 'using offset and limit' },
    { name: 'it halves a part Read refuses', words: 'halve it and read again' },
    { name: 'it skips marked files', words: 'Skip every file marked skip' },
    { name: 'a cut line makes a file read in part', words: 'cut a line of it at 2,000 characters' },
    {
      name: 'an unfinished section makes a file read in part',
      words: 'stopped before the end of its section',
    },
    { name: 'it judges fit', words: 'fits the code around it' },
    { name: 'it judges repetition', words: 'repeats what already exists' },
    { name: 'it judges breakage', words: 'breaks something the spec never mentions' },
    { name: 'it judges bugs and tests', words: 'has bugs, or lacks tests' },
    {
      name: 'it does not repeat the Verify report',
      words: 'Do not repeat the Verify report’s verdicts',
    },
    {
      name: 'a finding names its file and why it matters',
      words: 'matters that says why it matters',
    },
    {
      name: 'it picks its next_step by the rules of R14',
      words:
        'merge only when there is no finding; merge_and_file when there is no blocker and at least one outside finding; fix_by_hand, rerun_keep or rerun_again only when there is a blocker, and rerun_keep only when get_decision gives a plan_to_keep',
    },
    {
      name: 'it leaves the skipped files to the board',
      words: 'The board lists the files marked skip on the review itself; do not list them.',
    },
    {
      name: 'it lists partial and unread files under unsure',
      words: 'list by path every file you read in part or did not read',
    },
    {
      name: 'it groups a list too long to fit',
      words: 'name each directory and how many of its files instead',
    },
    { name: 'it reads test_output', words: 'Read test_output from get_decision' },
    {
      name: 'a skipped or missing suite is a test finding',
      words:
        'shows skipped, empty or missing a suite or test that the Verify report or the plan relies on',
    },
    {
      name: 'evidence not shown passing is a test finding',
      words: 'cites as evidence a test the text does not show passing',
    },
    {
      name: 'a cut suite goes under unsure',
      words:
        'when truncated is true, or the text begins with the line saying the board kept only the last 4,096 characters, a suite or test whose lines are not in the text goes under unsure and never into a test finding, even when the Verify report cites it',
    },
    {
      name: 'a null test_output goes under unsure',
      words: 'When test_output is null, say so under unsure.',
    },
    {
      name: 'it says when every file was read whole',
      words: 'When every file you did not skip was read whole, say so.',
    },
  ]
  it.each(rows)('$name', ({ words }) => {
    expect(prompt).toContain(words)
  })

  it('states the truncation exception after both test finding cases', () => {
    const at = (words: string) => prompt.indexOf(words)
    const exception = at('when truncated is true')
    expect(exception).toBeGreaterThan(at('shows skipped, empty or missing'))
    expect(exception).toBeGreaterThan(at('does not show passing'))
  })

  it('tells the helper a review finding may carry choices and a recommended one', () => {
    const line = AGENTS.helper!.prompt.split('\n\n').find((part) => part.startsWith('review:'))!
    expect(line).toContain('choices')
    expect(line).toContain('recommended')
  })

  it('tells the spec-writer to ask about an open choice, not decide it', () => {
    const prompt = AGENTS['spec-writer']!.prompt
    expect(prompt).toContain('Open choice, ask me:')
    expect(prompt).toContain('Decision:')
    expect(prompt).toContain('does not decide it')
    expect(prompt).toContain('(recommended)')
    expect(prompt).toContain('as the question’s recommendation')
  })
})

// The kit's specs made `chore: release X.Y.Z` a requirement, and its builds committed one: a
// release is the owner's, cut after the merge.
const NO_RELEASE: { agent: string; clause: string }[] = [
  ...['spec-writer', 'planner', 'builder'].map((agent) => ({
    agent,
    clause:
      'A task never releases its project: releasing is the owner’s act, after the merge. No requirement, criterion, plan step or commit bumps the project’s version, writes a `chore: release` commit or makes a tag, even when another task waits on a release of this work, and even when the repository’s rules or skills say how a release is cut.',
  })),
  {
    agent: 'spec-writer',
    clause:
      'When another task waits on a release of this work, say in ## Out of scope that the owner releases after the merge.',
  },
  ...['planner', 'builder'].map((agent) => ({
    agent,
    clause:
      'When the spec or the plan asks for a release, do not carry that part out: ask the owner through request_approval with kind question, then end your turn.',
  })),
]

describe('the release, which no run makes', () => {
  it.each(NO_RELEASE)('the $agent prompt says: $clause', ({ agent, clause }) => {
    expect(AGENTS[agent]!.prompt).toContain(clause)
  })
})

describe('the verifier’s reading of the cuts', () => {
  const prompt = AGENTS.verifier!.prompt
  const clauses = [
    'the diff and the test output in the handoff, and the files those two name',
    'in the run directory, outside the worktree',
    'Never change them',
    'the rest of the diff is in the file the marker names, from the line it gives',
    '`^diff --git ` with output_mode content, line numbers on and head_limit 0',
    'When the Grep result was saved to a file, Read that file',
    'Keep the matches at or after the line the marker gives and, when no match is on that line, the last match before it',
    'parts of at most 1,000 lines, and halve a part that Read refuses',
    'When Read cuts a line at 2,000 characters',
    "sed -n '<L>p' <file>",
    'cut -c',
    '`[test output cut: …]` marker, the characters left out are in the file the marker names',
    'what came before it is in no file',
    'Never give pass to a criterion whose evidence lies in a part of the diff or of the test output you did not read',
    'A file counts as read in part when a line of it that Read cut was not then read whole with Bash, or when reading stopped before the end of its section',
    'names each changed file you did not read whole, including any lockfile or generated file you skipped',
  ]
  it.each(clauses)('says: %s', (clause) => {
    expect(prompt).toContain(clause)
  })
  it.each([...LOCKFILES, ...GENERATED_SUFFIXES])('names %s as skipped', (name) => {
    expect(prompt).toContain(`\`${name}\``)
  })
})

describe('the helper’s review of a redrafted spec', () => {
  const review = AGENTS.helper!.prompt.split('\n\n').find((p) => p.startsWith('review:'))!

  it.each([
    'previous',
    'missing',
    'quote',
    'risk',
    'unless the diff changed',
    'earlier_review.version equals previous.version',
    'Decision:',
    'previous.answers',
    'context only',
    'previous.note is not null',
    'When previous.note is null, case (c) does not apply',
    'their where fields point into version earlier_review.version',
  ])('says %s', (phrase) => {
    expect(review).toContain(phrase)
  })
})

describe('the helper’s duty to save', () => {
  const prompt = AGENTS.helper!.prompt
  it.each([
    [
      'that only the saved result reaches the owner',
      'Only what save_help_result saves reaches the owner',
    ],
    ['that its closing text never reaches the owner', 'never your closing text'],
    [
      'not to end before the save answered Saved.',
      'Do not end your turn before the save has answered "Saved."',
    ],
    [
      'never to say it saved unless the save answered so',
      'Never say you saved unless the save answered "Saved."',
    ],
  ])('tells the helper %s', (_name, words) => {
    expect(prompt).toContain(words)
  })
})
