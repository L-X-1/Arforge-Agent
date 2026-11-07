import { retryBootstrapRead } from "./bootstrap-read"

type PermissionRef = { readonly id: string; readonly sessionID: string }
type Event = {
  readonly type: string
  readonly properties?: unknown
  readonly current?: { readonly type: string; readonly data: unknown }
}
type Read = { valid: boolean; loading: boolean; failed: boolean; touched: Set<string>; promise: Promise<void> }
const fields = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined)

/** Retire obsolete UI asks from an authoritative GET; never invent a human reply. */
export function createPermissionRetirement<T extends PermissionRef>(input: {
  get: (sessionID: string) => readonly T[]
  set: (sessionID: string, requests: T[]) => void
  read: (sessionID: string, current: () => boolean) => Promise<readonly PermissionRef[]>
  capture: () => () => boolean
  onError: (error: unknown, retry: () => void) => void
}) {
  const reads = new Map<string, Read>()
  let disposed = false
  const invalidate = (sessionID: string) => {
    const pending = reads.get(sessionID)
    if (pending) pending.valid = false
    reads.delete(sessionID)
  }
  const refresh = (sessionID: string): Promise<void> => {
    if (disposed) return Promise.resolve()
    const pending = reads.get(sessionID)
    if (pending?.loading) return pending.promise
    if (pending) invalidate(sessionID)
    const captured = new Set(
      input
        .get(sessionID)
        .filter((x) => x.sessionID === sessionID)
        .map((x) => x.id),
    )
    if (!captured.size) return Promise.resolve()
    const lifetime = input.capture()
    const entry: Read = { valid: true, loading: true, failed: false, touched: new Set(), promise: Promise.resolve() }
    const current = () => !disposed && entry.valid && lifetime()
    reads.set(sessionID, entry)
    entry.promise = Promise.resolve()
      .then(async () => {
        const result = await retryBootstrapRead(() => input.read(sessionID, current), current)
        if (!Array.isArray(result) || result.some((x) => typeof x?.id !== "string" || typeof x?.sessionID !== "string"))
          throw new TypeError("Invalid pending permission response")
        if (!current()) return
        const live = new Set(result.filter((x) => x.sessionID === sessionID).map((x) => x.id))
        const before = input.get(sessionID)
        // A fresh Asked/Replied event outranks a read started earlier. Only prune
        // untouched captured identities; never resurrect or overwrite a request.
        const next = before.filter((x) => !captured.has(x.id) || entry.touched.has(x.id) || live.has(x.id))
        if (next.length !== before.length) input.set(sessionID, next)
      })
      .catch((error) => {
        if (!current() || fields(error)?.name === "AbortError") return
        entry.failed = true
        input.onError(error, () => {
          if (current()) void refresh(sessionID)
        })
      })
      .finally(() => {
        entry.loading = false
        // Keep a failed read's retry token until a source change or retry, so
        // a stale toast cannot act after delete/move/A-B-A navigation.
        if (reads.get(sessionID) === entry && (!entry.failed || !current())) reads.delete(sessionID)
      })
    return entry.promise
  }
  return {
    refresh,
    observe(event: Event) {
      const type = event.current?.type ?? event.type
      const data = fields(event.current?.data ?? event.properties)
      const info = fields(data?.info)
      const sessionID = data?.sessionID ?? info?.id
      if (typeof sessionID !== "string") return
      if (type === "session.deleted" || type === "session.moved" || type === "session.next.moved") {
        invalidate(sessionID)
        return
      }
      if (
        type === "permission.asked" ||
        type === "permission.v2.asked" ||
        type === "permission.replied" ||
        type === "permission.v2.replied"
      ) {
        const id = data?.requestID ?? data?.id
        if (typeof id === "string") reads.get(sessionID)?.touched.add(id)
        if (reads.get(sessionID)?.failed && !input.get(sessionID).length) invalidate(sessionID)
        return
      }
      if (
        type === "session.next.step.failed" ||
        (type === "session.next.step.ended" && /interrupt|cancel/.test(String(data?.finish))) ||
        (type === "agent.run.state-changed" &&
          ["paused", "completed", "failed", "cancelled"].includes(String(data?.to)))
      )
        void refresh(sessionID)
    },
    dispose() {
      disposed = true
      for (const entry of reads.values()) entry.valid = false
      reads.clear()
    },
  }
}
