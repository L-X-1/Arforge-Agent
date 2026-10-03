import type { QueryClient } from "@tanstack/solid-query"
import { pathKey } from "@/utils/path-key"
import { shouldOpenSessionInBackground } from "../home-session-open"

export const SHELL_DRAWER_QUERY = "(max-width: 1279px)"
export const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 216

export function workspaceSidebarWidth(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WORKSPACE_SIDEBAR_WIDTH
}

export type NavigationTarget = { server: string; directory: string; sessionID: string }

export function navigationSessionKey(target: NavigationTarget) {
  return JSON.stringify([target.server, pathKey(target.directory), target.sessionID])
}

export function projectContainsDirectory(project: { worktree: string; sandboxes?: string[] }, directory: string) {
  const key = pathKey(directory)
  return [project.worktree, ...(project.sandboxes ?? [])].some((item) => pathKey(item) === key)
}

export function navigationMatches(query: string, ...values: string[]) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const text = values.join(" ").toLocaleLowerCase()
  return words.every((word) => text.includes(word))
}

// Capture the complete target before awaiting. A server or project switch must
// never redirect a successful response into the new navigation scope.
export async function runNavigationRequest<T>(
  target: NavigationTarget,
  request: (target: Readonly<NavigationTarget>) => Promise<T>,
  commit: (target: Readonly<NavigationTarget>, result: T) => void,
) {
  const captured = Object.freeze({ ...target })
  const result = await request(captured)
  commit(captured, result)
  return result
}

type NavigationSession = { id: string; directory: string; parentID?: string; time: { archived?: number } }
export type PinnedNavigationEntry<T> = { target: NavigationTarget; session: T }
export type PinnedNavigationResult<T> = {
  entries: PinnedNavigationEntry<T>[]
  failures: { target: NavigationTarget; error: unknown }[]
}

export function navigationPinTargets(
  values: Record<string, boolean>,
  details: Record<string, NavigationTarget> = {},
): NavigationTarget[] {
  return Object.entries(values).flatMap(([key, enabled]) => {
    if (!enabled) return []
    try {
      const parts: unknown = JSON.parse(key)
      if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === "string" && part.length > 0))
        return []
      const target = { server: parts[0] as string, directory: parts[1] as string, sessionID: parts[2] as string }
      const detail = details[key]
      if (detail && typeof detail.server === "string" && typeof detail.directory === "string" &&
        typeof detail.sessionID === "string" && navigationSessionKey(detail) === navigationSessionKey(target))
        return [{ ...detail }]
      return [target]
    } catch {
      return []
    }
  })
}

export const pinnedNavigationQueryKey = (server: string, targets: readonly NavigationTarget[]) =>
  ["home", "pinned-sessions", server, targets.map(navigationSessionKey).sort()] as const

export async function loadPinnedNavigationSessions<T extends NavigationSession>(
  targets: readonly NavigationTarget[],
  load: (target: Readonly<NavigationTarget>) => Promise<T>,
  signal?: AbortSignal,
  revision?: (target: Readonly<NavigationTarget>) => number,
): Promise<PinnedNavigationResult<T>> {
  const pending = [...new Map(targets.map((target) =>
    [navigationSessionKey(target), Object.freeze({ ...target })] as const)).values()]
  const entries: (PinnedNavigationEntry<T> | undefined)[] = []
  const failures: PinnedNavigationResult<T>["failures"] = []
  let cursor = 0
  const worker = async () => {
    while (!signal?.aborted) {
      const index = cursor++
      const target = pending[index]
      if (!target) return
      try {
        const startedAt = revision?.(target)
        const session = await load(target)
        if (signal?.aborted) return
        if (revision && startedAt !== revision(target)) continue
        if (session.id !== target.sessionID || pathKey(session.directory) !== pathKey(target.directory))
          throw new Error("Pinned session response does not match its server/workspace target")
        if (!session.parentID && typeof session.time.archived !== "number") entries[index] = { target, session }
      } catch (error) {
        if (!signal?.aborted) failures.push({ target, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker))
  return { entries: entries.filter((entry): entry is PinnedNavigationEntry<T> => !!entry), failures }
}

export function mergePinnedNavigationSessions<T extends NavigationSession>(
  recent: readonly T[],
  indexed: readonly T[],
  loaded: readonly PinnedNavigationEntry<T>[],
  targets: readonly NavigationTarget[],
  server: string,
): T[] {
  const key = (session: T) => navigationSessionKey({ server, directory: session.directory, sessionID: session.id })
  const candidates = new Map(loaded.filter((entry) => entry.target.server === server &&
    navigationSessionKey(entry.target) === key(entry.session)).map((entry) => [key(entry.session), entry.session]))
  // The live index wins over an older supplemental response, including archive events.
  for (const session of indexed) candidates.set(key(session), session)
  const result = new Map(recent.map((session) => [key(session), session]))
  for (const target of targets) {
    if (target.server !== server) continue
    const id = navigationSessionKey(target)
    const session = candidates.get(id)
    if (session && !session.parentID && typeof session.time.archived !== "number") result.set(id, session)
  }
  return [...result.values()]
}

export function retainPinnedNavigationRecords<T extends { session: NavigationSession }>(
  records: readonly T[], targets: readonly NavigationTarget[], server: string, limit: number,
): T[] {
  const pins = new Set(targets.filter((target) => target.server === server).map(navigationSessionKey))
  return [...records.slice(0, limit), ...records.slice(limit).filter(({ session }) =>
    pins.has(navigationSessionKey({ server, directory: session.directory, sessionID: session.id })))]
}

export function shouldOpenNavigationSessionInBackground(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean,
) {
  return shouldOpenSessionInBackground({
    button: event.button, mac, meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey,
  })
}

export type PinnedNavigationEvents = Record<string, {
  revision: number
  removed: false | "archived" | "deleted"
}>

export const pinnedNavigationEventsKey = (server: string) =>
  ["home", "pinned-session-events", server] as const

export function pinnedNavigationRevision(queryClient: QueryClient, target: Readonly<NavigationTarget>) {
  return queryClient.getQueryData<PinnedNavigationEvents>(pinnedNavigationEventsKey(target.server))
    ?.[navigationSessionKey(target)]?.revision ?? 0
}

export function pinnedNavigationRemoved(queryClient: QueryClient, target: Readonly<NavigationTarget>) {
  return !!queryClient.getQueryData<PinnedNavigationEvents>(pinnedNavigationEventsKey(target.server))
    ?.[navigationSessionKey(target)]?.removed
}

export function filterRemovedNavigationSessions<T extends NavigationSession>(
  sessions: readonly T[], server: string, events: PinnedNavigationEvents,
): T[] {
  return sessions.filter((session) => !events[navigationSessionKey({
    server, directory: session.directory, sessionID: session.id,
  })]?.removed)
}

// Only explicit server events invalidate a target. A missing index row is not
// evidence of deletion, and the user's persisted pin is never removed here.
export function applyPinnedNavigationEvent<T extends NavigationSession>(
  queryClient: QueryClient,
  server: string,
  event: { type: "session.created" | "session.updated" | "session.deleted"; properties: { info: T } },
) {
  const session = event.properties.info
  if (!session || typeof session.directory !== "string" || !session.directory) return false
  const target = { server, directory: session.directory, sessionID: session.id }
  const key = navigationSessionKey(target)
  const eventsKey = pinnedNavigationEventsKey(server)
  const previous = queryClient.getQueryData<PinnedNavigationEvents>(eventsKey)?.[key]
  const removed: PinnedNavigationEvents[string]["removed"] = event.type === "session.deleted"
    ? "deleted"
    : previous?.removed === "deleted" && event.type !== "session.created"
      ? "deleted"
      : typeof session.time.archived === "number" ? "archived" : false
  if ((!previous && !removed) || previous?.removed === removed) return false
  const predicate = (query: { queryKey: readonly unknown[] }) => {
    const [home, kind, scope, targets] = query.queryKey
    return home === "home" && kind === "pinned-sessions" && scope === server &&
      Array.isArray(targets) && targets.includes(key)
  }
  // Keep tracking a known tombstone through restore, even if its query was GC'd.
  if (!previous && queryClient.getQueryCache().findAll({ predicate }).length === 0) return false
  queryClient.setQueryData<PinnedNavigationEvents>(eventsKey, (current) => ({
    ...current, [key]: { revision: (previous?.revision ?? 0) + 1, removed },
  }))
  // Do not allow cancellation to revert the removal to the pre-request cache.
  void queryClient.cancelQueries({ predicate }, { revert: false }).catch(() => undefined)
  queryClient.setQueriesData<PinnedNavigationResult<T>>({ predicate }, (current) => current && ({
    ...current,
    entries: current.entries.filter((entry) => navigationSessionKey(entry.target) !== key),
    failures: current.failures.filter((failure) => navigationSessionKey(failure.target) !== key),
  }))
  void queryClient.invalidateQueries({ predicate, refetchType: "active" }).catch(() => undefined)
  return true
}
