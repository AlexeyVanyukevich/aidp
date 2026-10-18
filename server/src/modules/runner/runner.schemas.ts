import { Type, type Static } from 'typebox'
import { NonBlankString, Uuid } from '../../shared/schemas.js'
import { EVENT_TYPES } from '../../shared/vocabulary.js'

const NullableString = (maxLength: number) => Type.Union([Type.String({ maxLength }), Type.Null()])
const Count = Type.Integer({ minimum: 0 })

export const RunnerEventSchema = Type.Object(
  {
    id: Uuid,
    run_id: Uuid,
    phase_id: Type.Union([Uuid, Type.Null()]),
    ts: Type.String({ format: 'date-time' }),
    type: Type.Enum(EVENT_TYPES),
    agent: NullableString(100),
    model: NullableString(200),
    tool: NullableString(200),
    target: NullableString(2000),
    status: NullableString(50),
    duration_ms: Type.Union([Count, Type.Null()]),
    usage: Type.Object(
      { input: Count, output: Count, cache_read: Count, cache_write: Count },
      { additionalProperties: false },
    ),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
)
export type RunnerEvent = Static<typeof RunnerEventSchema>

export const EventsBody = Type.Object(
  { events: Type.Array(RunnerEventSchema, { minItems: 1, maxItems: 500 }) },
  { additionalProperties: false },
)

export const ClaimBody = Type.Object(
  {
    runner_id: NonBlankString({ maxLength: 100 }),
    wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  },
  { additionalProperties: false },
)

export const HeartbeatBody = Type.Object(
  { runner_id: NonBlankString({ maxLength: 100 }), run_ids: Type.Array(Uuid, { maxItems: 50 }) },
  { additionalProperties: false },
)

export const RunParams = Type.Object({ id: Uuid })
