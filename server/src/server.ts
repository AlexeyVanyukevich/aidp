import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { PrPoller, realGh } from './modules/runs/pr-poller.js'
import { Sweeper } from './modules/runs/sweeper.js'

const config = loadConfig(process.env)
// The pool exists before the app and its logger do; until then a dropped connection is quiet.
let onPoolError = (_error: Error): void => undefined
const db = createDb(config.databaseUrl, (error) => onPoolError(error))
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
