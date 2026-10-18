import { Type } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'

const Budget = Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })

export const ProjectKeyParams = Type.Object({ key: Type.String({ maxLength: 10 }) })
export const TaskParams = Type.Object({ id: Uuid })

export const CreateTaskBody = Type.Object(
  {
    title: NonBlankString({ maxLength: 200 }),
    description_md: Type.Optional(Type.String({ maxLength: 100_000 })),
    budget_usd: Type.Optional(Budget),
  },
  { additionalProperties: false },
)

export const PatchTaskBody = Type.Object(
  {
    title: Type.Optional(NonBlankString({ maxLength: 200 })),
    description_md: Type.Optional(Type.String({ maxLength: 100_000 })),
    budget_usd: Type.Optional(Type.Union([Budget, Type.Null()])),
    position: Type.Optional(Type.Number()),
    // The one move a drag makes. Every other move is a button with its own endpoint.
    state: Type.Optional(Type.Literal('done')),
  },
  { additionalProperties: false, minProperties: 1 },
)
