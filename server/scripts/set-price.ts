import { createDb } from '../src/db/client.js'

/**
 * USD per million tokens, from Anthropic's published price list. Cache writes are priced at
 * what Claude Code actually pays: its runs recorded on 2026-10-11 wrote with the one-hour TTL.
 */
const [
  model,
  input,
  output,
  cacheRead,
  cacheWrite,
  effectiveFrom = new Date().toISOString().slice(0, 10),
] = process.argv.slice(2)
const numbers = [input, output, cacheRead, cacheWrite].map(Number)
if (
  model === undefined ||
  numbers.some((n) => !Number.isFinite(n) || n < 0) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
) {
  console.error('usage: set-price <model> <input> <output> <cache_read> <cache_write> [YYYY-MM-DD]')
  process.exit(2)
}
const databaseUrl = process.env.DATABASE_URL
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required')
const db = createDb(databaseUrl)
try {
  const [i, o, r, w] = numbers as [number, number, number, number]
  await db
    .insertInto('prices')
    .values({
      model,
      effective_from: effectiveFrom,
      input: i,
      output: o,
      cache_read: r,
      cache_write: w,
    })
    .onConflict((oc) =>
      oc
        .columns(['model', 'effective_from'])
        .doUpdateSet({ input: i, output: o, cache_read: r, cache_write: w }),
    )
    .execute()
  console.log(
    `${model} from ${effectiveFrom}: input ${i}, output ${o}, cache read ${r}, cache write ${w} USD/MTok`,
  )
} finally {
  await db.destroy()
}
