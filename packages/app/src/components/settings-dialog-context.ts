/**
 * The global settings command is mounted above the route-specific Session
 * subtree, so useParams() can be empty even while the renderer is visibly on
 * a Session page. Read only the canonical route segment as presentation
 * context; the server still verifies the Session owner before any mutation.
 */
export function sessionIDFromRoutePath(pathname: string): string | undefined {
  const match = /\/session\/([^/]+)$/.exec(pathname)
  if (!match?.[1]) return undefined
  try {
    const value = decodeURIComponent(match[1]).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Only known workspace routes can be used as a settings return target. */
export function settingsReturnTarget(value: string | undefined): string | undefined {
  if (!value) return
  if (value === "/") return "/"
  if (/^\/server\/[^/?#]+\/session\/[^/?#]+$/.test(value) && sessionIDFromRoutePath(value)) return value
  const home = value.startsWith("/?")
  if (!home && !value.startsWith("/new-session?")) return
  const params = new URLSearchParams(value.slice(value.indexOf("?") + 1))
  const draftID = params.get("draftId")?.trim()
  if (draftID) return `${home ? "/" : "/new-session"}?draftId=${encodeURIComponent(draftID)}`
  if (home && params.get("history") === "1") return "/?history=1"
  if (home && params.get("archived") === "1") return "/?archived=1"
  return undefined
}

/** Carry the original canonical source or draft without changing either owner. */
export function settingsRoute(sessionID?: string, origin?: string): string {
  const value = sessionID?.trim()
  const params: string[] = []
  if (value) params.push(`sessionID=${encodeURIComponent(value)}`)
  const current = origin ?? (typeof window === "undefined" ? undefined : window.location.pathname + window.location.search)
  const target = settingsReturnTarget(current)
  if (target && (!value || target.startsWith("/new-session?") || sessionIDFromRoutePath(target) === value))
    params.push(`returnTo=${encodeURIComponent(target)}`)
  const query = params.join("&")
  return query ? `/settings?${query}` : "/settings"
}
