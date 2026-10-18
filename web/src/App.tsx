import { BrowserRouter, Link, Route, Routes } from 'react-router'
import type { QueryClient } from '@tanstack/react-query'
import { useBoardStream } from './stream'
import { Projects } from './routes/Projects'

export function App({ client }: { client: QueryClient }) {
  useBoardStream(client)
  return (
    <BrowserRouter>
      <header className="top">
        <Link to="/" className="brand">
          AI Task Board
        </Link>
      </header>
      <Routes>
        <Route path="/" element={<Projects />} />
      </Routes>
    </BrowserRouter>
  )
}
