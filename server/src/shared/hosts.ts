/** The host name of a `Host` header, without its port, lower-cased. IPv6 literals are refused. */
function hostName(hostHeader: string): string | undefined {
  if (hostHeader.startsWith('[')) return undefined
  const name = hostHeader.split(':')[0]?.trim().toLowerCase()
  return name === '' ? undefined : name
}

export function isAllowedHost(hostHeader: string | undefined, allowed: string[]): boolean {
  if (hostHeader === undefined) return false
  const name = hostName(hostHeader)
  return name !== undefined && allowed.includes(name)
}

/**
 * A write from a browser carries `Origin`; one from the runner or curl does not, and those are
 * not what this check is for. An Origin that is present must name the host the request was
 * addressed to, port included. The Host is read as a URL under the Origin's scheme, so a
 * default port spelled out on one side (`localhost:80`) still matches its absence on the other.
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true
  if (hostHeader === undefined) return false
  try {
    const from = new URL(origin)
    return from.host === new URL(`${from.protocol}//${hostHeader}`).host
  } catch {
    return false
  }
}
