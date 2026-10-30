import { BrowserRouter, Link, Route, Routes } from 'react-router'
import type { QueryClient } from '@tanstack/react-query'
import { QuestionsWaiting } from './board/QuestionsWaiting'
import { CardDrawer } from './card/CardDrawer'
import { useBoardStream } from './stream'
import { Board } from './routes/Board'
import { Projects } from './routes/Projects'
import { Settings } from './routes/Settings'

export function App({ client }: { client: QueryClient }) {
  useBoardStream(client)
  return (
    <BrowserRouter>
      <header className="top">
        <Link to="/" className="brand">
          AI Delivery Platform
        </Link>
        <QuestionsWaiting />
      </header>
      <Routes>
        <Route path="/" element={<Projects />} />
        <Route path="/p/:key/settings" element={<Settings />} />
        <Route path="/p/:key" element={<Board />}>
          <Route path=":taskId" element={<CardDrawer />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
