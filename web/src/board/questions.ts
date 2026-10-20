/** The header's count of questions waiting across every project; nothing at zero (spec §11). */
export function questionsText(count: number): string {
  if (count === 0) return ''
  return count === 1 ? '1 question waiting' : `${count} questions waiting`
}
