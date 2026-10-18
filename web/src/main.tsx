import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@zellige/core/tokens.css'
import '@zellige/core/zl.css'
import { App } from './App'
import './styles.css'

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App client={client} />
    </QueryClientProvider>
  </StrictMode>,
)
