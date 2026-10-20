import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { questionsText } from './questions'

/**
 * Text in the banner, not a control and not a live region: it changes with every run's
 * questions, as the board's moves do, and those are not announced either (spec §11).
 */
export function QuestionsWaiting() {
  const open = useQuery({ queryKey: ['approvals', 'open'], queryFn: () => api.openApprovals() })
  const text = questionsText(open.data?.length ?? 0)
  return text === '' ? null : <p className="questions-waiting">{text}</p>
}
