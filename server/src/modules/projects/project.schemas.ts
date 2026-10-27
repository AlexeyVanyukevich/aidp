import { Type } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

const SetupCommand = Type.Union([Type.String({ maxLength: 500 }), Type.Null()])

export const CreateProjectBody = Type.Object(
  {
    key: Type.String({ pattern: '^[A-Z][A-Z0-9]{1,9}$' }),
    name: NonBlankString({ maxLength: 100 }),
    repo_path: Type.String({ pattern: '^/', maxLength: 1000 }),
    github_repo: Type.String({ pattern: '^[^/\\s]+/[^/\\s]+$', maxLength: 200 }),
    base_branch: NonBlankString({ maxLength: 200 }),
    test_command: NonBlankString({ maxLength: 500 }),
    setup_command: Type.Optional(SetupCommand),
  },
  { additionalProperties: false },
)

export const UpdateProjectBody = Type.Object(
  { setup_command: SetupCommand },
  { additionalProperties: false },
)

export const ProjectKeyParams = Type.Object({ key: Type.String() })
