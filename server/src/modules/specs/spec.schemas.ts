import { Type } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'

export const SpecParams = Type.Object({ id: Uuid })
export const SaveSpecBody = Type.Object(
  { body_md: NonBlankString({ maxLength: 100_000 }) },
  { additionalProperties: false },
)
