import { pathKey } from "@/utils/path-key"

type MenuSession = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  time: { archived?: number }
}

export type SessionMenuSource<T extends MenuSession, S extends string, O extends object = object> = {
  owner: O
  server: S
  current: T
  directories: readonly string[]
  sessions: readonly T[]
}

function target<T extends MenuSession, S extends string>(source: SessionMenuSource<T, S> | undefined, offset: number) {
  if (!source) return
  const allowed = new Set(source.directories.map(pathKey)),
    seen = new Set<string>()
  const sessions = source.sessions.filter((session) => {
    if (
      seen.has(session.id) ||
      session.projectID !== source.current.projectID ||
      !allowed.has(pathKey(session.directory)) ||
      session.parentID ||
      session.time.archived
    )
      return false
    seen.add(session.id)
    return true
  })
  if (!sessions.length) return
  const index = sessions.findIndex((session) => session.id === source.current.id)
  const next =
    sessions[
      index === -1 ? (offset > 0 ? 0 : sessions.length - 1) : (index + offset + sessions.length) % sessions.length
    ]
  return next?.id === source.current.id ? undefined : next
}

export function createSessionMenuCommands<T extends MenuSession, S extends string, O extends object>(input: {
  snapshot: () => SessionMenuSource<T, S, O> | undefined
  select: (source: SessionMenuSource<T, S, O>, session: T) => void
  previous: string
  next: string
  category: string
}) {
  return ([-1, 1] as const).map((offset) => ({
    id: offset < 0 ? "session.previous" : "session.next",
    title: offset < 0 ? input.previous : input.next,
    category: input.category,
    keybind: offset < 0 ? "alt+arrowup" : "alt+arrowdown",
    disabled: !target(input.snapshot(), offset),
    onSelect: () => {
      const captured = input.snapshot(),
        next = target(captured, offset)
      if (!captured || !next) return
      const current = input.snapshot()
      if (
        !current ||
        current.owner !== captured.owner ||
        current.server !== captured.server ||
        current.current.id !== captured.current.id
      )
        return
      input.select(captured, next)
    },
  }))
}
