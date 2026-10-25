/** The header's count of questions waiting across every project; nothing at zero (spec §11). */
export function questionsText(count: number): string {
  if (count === 0) return ''
  return count === 1 ? '1 question waiting' : `${count} questions waiting`
}

/** Questions waiting across every open approval: a batch counts each of its questions. */
export function waitingCount(open: { question_count: number }[]): number {
  return open.reduce((total, approval) => total + approval.question_count, 0)
}
