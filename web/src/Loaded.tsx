import { useRef, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Loading, Trouble } from '@zellige/react'

/**
 * A query's three states in the kit's components. Retry removes its own button, so it moves
 * focus first to this wrapper, which stays. `children` is a render function, not a component:
 * it must call no hook.
 */
export function Loaded<T>({
  query,
  failure,
  children,
}: {
  query: UseQueryResult<T>
  failure: string
  children: (data: T) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const retry = () => {
    box.current?.focus()
    void query.refetch()
  }
  return (
    <div ref={box} tabIndex={-1} className="loaded">
      {query.data !== undefined ? (
        children(query.data)
      ) : query.isError ? (
        <Trouble title={failure} onRetry={retry} />
      ) : (
        <Loading />
      )}
    </div>
  )
}
