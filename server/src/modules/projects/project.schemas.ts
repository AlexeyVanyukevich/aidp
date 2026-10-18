import { Type } from 'typebox'
import { NonBlankString } from '../../shared/schemas.js'

export const CreateProjectBody = Type.Object(
  {
    key: Type.String({ pattern: '^[A-Z][A-Z0-9]{1,9}$' }),
    name: NonBlankString({ maxLength: 100 }),
    repo_path: Type.String({ pattern: '^/', maxLength: 1000 }),
    github_repo: Type.String({ pattern: '^[^/\\s]+/[^/\\s]+$', maxLength: 200 }),
    base_branch: NonBlankString({ maxLength: 200 }),
    test_command: NonBlankString({ maxLength: 500 }),
  },
  { additionalProperties: false },
)
