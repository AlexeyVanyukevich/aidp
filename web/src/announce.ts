import { useEffect, useMemo, useState } from 'react'

type Write = string | ((current: string) => string)

export interface AnnouncerDeps {
  write: (value: Write) => void
  request: (callback: () => void) => number
  cancel: (id: number) => void
}

/**
 * A status region's writer. A message equal to the one shown is announced again only if the
 * region is emptied, stays empty across a painted frame, and is then refilled: two nested
 * frames. The refill happens only if the region is still empty, so a message written in between
 * is never overwritten. At most one write is pending; `say`, `announce` and `dispose` cancel it.
 */
export function createAnnouncer({ write, request, cancel }: AnnouncerDeps) {
  let pending: number | undefined
  const cancelPending = () => {
    if (pending !== undefined) cancel(pending)
    pending = undefined
  }
  return {
    say(text: string) {
      cancelPending()
      write(text)
    },
    announce(text: string) {
      cancelPending()
      write('')
      pending = request(() => {
        pending = request(() => {
          pending = undefined
          write((current) => (current === '' ? text : current))
        })
      })
    },
    dispose: cancelPending,
  }
}

/** The announcer over React state. `setMessage` is the plain setter: it cancels nothing. */
export function useAnnouncer() {
  const [message, setMessage] = useState('')
  const announcer = useMemo(
    () =>
      createAnnouncer({
        write: setMessage,
        request: (callback) => requestAnimationFrame(callback),
        cancel: (id) => cancelAnimationFrame(id),
      }),
    [],
  )
  useEffect(() => announcer.dispose, [announcer])
  const say = (text: string) => announcer.say(text)
  const announce = (text: string) => announcer.announce(text)
  return { message, setMessage, say, announce }
}
