import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { LIMITS } from './approval-rules.js'

export const ApprovalParams = Type.Object({ id: Uuid })

/** Either or both; the rules say which combinations an approval accepts. */
export const AnswerBody = Type.Object(
  {
    option_id: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    text: Type.Optional(Type.String({ maxLength: LIMITS.answer })),
  },
  { additionalProperties: false },
)

export const ApprovalsQuery = Type.Object(
  { status: Type.Literal('open') },
  { additionalProperties: false },
)
