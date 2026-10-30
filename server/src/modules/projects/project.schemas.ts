import { Type } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'

const SetupCommand = Type.Union([Type.String({ maxLength: 500 }), Type.Null()])

export const CreateProjectBody = Type.Object(
  {
    key: Type.String({ pattern: '^[A-Z][A-Z0-9]{1,9}$' }),
    name: NonBlankString({ maxLength: 100 }),
    repo_path: Type.String({ pattern: '^/', maxLength: 1000 }),
    github_repo: Type.String({ pattern: '^[^/\\s]+/[^/\\s]+$', maxLength: 200 }),
    base_branch: NonBlankString({ maxLength: 200 }),
    setup_command: Type.Optional(SetupCommand),
  },
  { additionalProperties: false },
)

export const UpdateProjectBody = Type.Object(
  {
    setup_command: Type.Optional(SetupCommand),
  },
  { additionalProperties: false, minProperties: 1 },
)

export const ProjectKeyParams = Type.Object({ key: Type.String() })

export const LinkBody = Type.Object(
  { target: Type.String({ maxLength: 100 }), note: Type.String({ maxLength: 5000 }) },
  { additionalProperties: false },
)

export const LinkParams = Type.Object({ key: Type.String(), target: Type.String() })

// Length and blankness are checked in the service so a refusal names its field.
export const AddTestCommandBody = Type.Object(
  { name: Type.String({ maxLength: 2000 }), command: Type.String({ maxLength: 5000 }) },
  { additionalProperties: false },
)

export const UpdateTestCommandBody = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 2000 })),
    command: Type.Optional(Type.String({ maxLength: 5000 })),
    is_default: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false, minProperties: 1 },
)

export const TestCommandParams = Type.Object({ key: Type.String(), id: Uuid })
