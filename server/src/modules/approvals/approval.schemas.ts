import { Type } from 'typebox'
import { Uuid } from '../../shared/schemas.js'
import { LIMITS } from './approval-rules.js'

export const ApprovalParams = Type.Object({ id: Uuid })

const OptionId = Type.String({ minLength: 1, maxLength: 50 })
const AnswerText = Type.String({ maxLength: LIMITS.answer })

/** One question's answer: either or both; the rules say which combinations an approval accepts. */
const SingleAnswer = Type.Object(
  { option_id: Type.Optional(OptionId), text: Type.Optional(AnswerText) },
  { additionalProperties: false },
)

/** A batch's answers, one per question (slice 3 spec, §6). */
const BatchAnswers = Type.Object(
  {
    answers: Type.Array(
      Type.Object(
        {
          question_id: Type.String({ minLength: 1, maxLength: 10 }),
          option_id: Type.Optional(OptionId),
          text: Type.Optional(AnswerText),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.questions },
    ),
  },
  { additionalProperties: false },
)

/** The service checks the shape against the approval's kind. */
export const AnswerBody = Type.Union([SingleAnswer, BatchAnswers])

export const ApprovalsQuery = Type.Object(
  { status: Type.Literal('open') },
  { additionalProperties: false },
)
