import { expect, test, type APIRequestContext } from '@playwright/test'
import { appUrl, expectAccessible, registerProject, runtime, tabTo } from './helpers'

// With the project on whole batch, one press of any question's Suggest an answer asks one helper
// for every answer, and Use every answer fills the questions still empty. The fake helper's
// script is in global setup.
const RUN = { timeout: 30_000 }
const draft = () => ({ key: 'DFT', name: 'Drafts', path: runtime().draftPath, repo: 'owner/draft' })

test('a whole batch is suggested in one help and filled with Use every answer', async ({
  page,
  request,
}) => {
  await registerProject(request, draft())
  expect(
    (await request.patch(appUrl('/api/projects/DFT'), { data: { batch_suggest: 'whole' } })).ok(),
  ).toBe(true)
  // The setting is on the Settings page, which is accessible too.
  await page.goto(appUrl('/p/DFT/settings'))
  await expect(
    page
      .getByRole('radiogroup', { name: 'How a batch of questions is suggested' })
      .getByRole('radio', { name: 'The whole batch in one help' }),
  ).toBeChecked()
  await expectAccessible(page)

  const created = (await (
    await request.post(appUrl('/api/projects/DFT/tasks'), {
      data: { title: 'Help with a whole batch', description_md: 'Retry failed deliveries.' },
    })
  ).json()) as { id: string; key: string }
  try {
    await request.post(appUrl(`/api/tasks/${created.id}/actions/draft-spec`))
    await page.goto(appUrl('/p/DFT'))
    await page
      .getByRole('region', { name: 'Needs approval' })
      .getByRole('link', { name: new RegExp(`^${created.key} `) })
      .click(RUN)
    const card = page.getByRole('dialog', { name: 'Help with a whole batch' })
    const panel = card.getByRole('tabpanel', { name: 'Approvals' })
    const status = card.getByRole('status')
    const first = panel.getByRole('region', { name: 'Question 1 of 2' })
    const second = panel.getByRole('region', { name: 'Question 2 of 2' })

    // Question 2 has words typed by hand: Use every answer must keep them.
    await second.getByRole('textbox', { name: 'Your answer to question 2' }).fill('Mine.')

    // Keyboard only: tab to question 1's Suggest an answer and press it.
    const suggest = panel.getByRole('button', { name: 'Suggest an answer' })
    await tabTo(page, first.getByRole('button', { name: 'Suggest an answer' }))
    await page.keyboard.press('Enter')
    // Every question's button is busy, and stays focusable, while the one help runs.
    await expect(suggest.first()).toHaveAttribute('aria-busy', 'true')
    await expect(suggest.nth(1)).toHaveAttribute('aria-busy', 'true')
    await expect(first.getByRole('button', { name: 'Suggest an answer' })).toBeFocused()

    await expect(
      status.filter({ hasText: 'Suggested answers ready for all 2 questions' }),
    ).toBeVisible(RUN)
    await expect(panel.getByRole('region', { name: 'Suggested with the whole batch' })).toHaveCount(
      2,
    )
    await expectAccessible(page)

    const every = panel.getByRole('button', { name: 'Use every answer' })
    await tabTo(page, every)
    await page.keyboard.press('Enter')
    await expect(every).toBeFocused()
    await expect(
      status.filter({ hasText: 'Filled 1 answer; skipped 1 already answered.' }),
    ).toBeVisible()
    await expect(first.getByRole('radio', { name: 'Five' })).toBeChecked()
    await expect(second.getByRole('textbox', { name: 'Your answer to question 2' })).toHaveValue(
      'Mine.',
    )

    // A second press changes nothing, and is announced again.
    await page.keyboard.press('Enter')
    await expect(
      status.filter({ hasText: 'Every question is already answered; nothing was filled.' }),
    ).toBeVisible()
    await expectAccessible(page)

    // Answered, the batch leaves no question open for a later journey's count of questions waiting.
    await panel.getByRole('button', { name: 'Send answers' }).click()
    await expect(card.getByText(`${created.key} · Spec review`)).toBeVisible(RUN)
  } finally {
    // A journey that fails part-way still leaves no question open: answer what is still waiting.
    await answerOpen(request, created.id)
  }
})

async function answerOpen(request: APIRequestContext, taskId: string): Promise<void> {
  const approvals = (await (
    await request.get(appUrl(`/api/tasks/${taskId}/approvals`))
  ).json()) as { id: string; status: string; questions: { id: string }[] | null }[]
  for (const approval of approvals.filter((a) => a.status === 'open'))
    await request.post(appUrl(`/api/approvals/${approval.id}/answer`), {
      data: {
        answers: (approval.questions ?? []).map((q) => ({ question_id: q.id, text: 'Cleanup.' })),
      },
    })
}
