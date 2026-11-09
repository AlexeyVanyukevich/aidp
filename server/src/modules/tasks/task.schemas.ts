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
    // A command of the task's project; null follows the project's default.
    test_command_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
    // Marks the task done: a drag from Review, or Mark done from Backlog, Spec review or Failed.
    // Every other move is a button with its own endpoint.
    state: Type.Optional(Type.Literal('done')),
  },
  { additionalProperties: false, minProperties: 1 },
)

/** Blank text passes here and is refused by the action, which names the field (§8). */
export const RedraftBody = Type.Object(
  { note: Type.String({ maxLength: 4_000 }) },
  { additionalProperties: false },
)

/** Blank text passes here and is refused by the action, which names the field. */
export const AcceptTitleBody = Type.Object(
  { title: Type.String({ maxLength: 200 }) },
  { additionalProperties: false },
)

/** The suggestion as shown, edited or not; blank is refused here, as the description's limit. */
export const AcceptSuggestionBody = Type.Object(
  { description_md: NonBlankString({ maxLength: 100_000 }) },
  { additionalProperties: false },
)

/** Reorder takes no input: no body, or an empty object. */
export const ReorderBody = Type.Union([
  Type.Object({}, { additionalProperties: false }),
  Type.Null(),
])
