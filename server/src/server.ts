import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { PrPoller, realGh } from './modules/runs/pr-poller.js'
import { Sweeper } from './modules/runs/sweeper.js'

const config = loadConfig(process.env)
// The pool exists before the app and its logger do; until then a dropped connection is quiet.
let onPoolError = (_error: Error): void => undefined
const db = createDb(config.databaseUrl, (error) => onPoolError(error))
// Pending migrations apply before anything listens; a failed one stops the start.
try {
  await runMigrations(db)
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: `the server did not start: ${error instanceof Error ? error.message : String(error)}`,
    }),
  )
  await db.destroy().catch(() => undefined)
  process.exit(1)
}
const app = await buildApp({ config, db })
onPoolError = (error) => app.log.warn({ err: error }, 'the database ended a pooled connection')
const poller = new PrPoller(db, realGh, app.log)
poller.start(config.prPollMs)
app.addHook('onClose', async () => poller.stop())
const sweeper = new Sweeper(db, () => new Date(), config.sweepMs, app.log)
sweeper.start()
app.addHook('onClose', async () => sweeper.stop())

app.addHook('onClose', async () => {
  await db.destroy()
})

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
