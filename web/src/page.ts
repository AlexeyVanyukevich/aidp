import { useEffect, useRef } from 'react'

const APP = 'AI Delivery Platform'

/** Names the document while mounted, and gives back the name it found when unmounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined) return undefined
    const before = document.title
    document.title = `${title} · ${APP}`
    return () => {
      document.title = before
    }
  }, [title])
}

let current: string | undefined

/**
 * Names a page and returns the ref for its `h1`, which must render from the first paint with
 * `tabIndex={-1}`. Arriving from another page moves focus to that heading — a client-side route
 * change otherwise leaves it on a link that is gone. The first page loaded keeps the browser's
 * focus, and StrictMode's second run of the effect sees the same id and does nothing.
 */
export function usePage(title: string | undefined, id: string) {
  useDocumentTitle(title)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const arrived = current !== undefined && current !== id
    current = id
    if (arrived) heading.current?.focus()
  }, [id])
  return heading
}
