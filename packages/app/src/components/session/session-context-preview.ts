import { checksum, hash } from "@arforge-ai/core/util/encode"

/** Read-only context evidence. No range selector or compaction result is invented here. */
export type ContextCandidate = { id: string; type: string; createdAt: number }
export type ContextPreviewSnapshot = {
  sessionID: string
  directory: string
  projectID: string
  updatedAt: number
  revision: string
  candidates: ContextCandidate[]
  contextJSON: string
  sampledAt: number
}

export type ContextPreviewBinding = {
  key: string
  isCurrent: () => boolean
  read: () => Promise<ContextPreviewSnapshot>
  compact: (snapshot: ContextPreviewSnapshot) => Promise<unknown>
}

export type ContextPreviewState = {
  phase: "closed" | "loading" | "ready" | "checking" | "submitting" | "admitted" | "error" | "stale"
  snapshot?: ContextPreviewSnapshot
  error?: unknown
}

export class ContextPreviewChanged extends Error {
  constructor() { super("Context preview changed") }
}

/** The exact read projection is re-read before dispatch; it is not a server CAS token. */
export function createContextPreviewController(input: {
  capture: () => ContextPreviewBinding | undefined
  update: (state: ContextPreviewState) => void
}) {
  let generation = 0
  let disposed = false
  let binding: ContextPreviewBinding | undefined
  let state: ContextPreviewState = { phase: "closed" }
  const set = (next: ContextPreviewState) => {
    state = next
    if (!disposed) input.update(next)
  }
  const invalidate = () => {
    generation++
    binding = undefined
    if (state.phase !== "closed") set({ phase: "stale", error: new ContextPreviewChanged() })
  }
  const close = () => {
    generation++
    binding = undefined
    set({ phase: "closed" })
  }
  return {
    invalidate,
    close,
    dispose() { disposed = true; generation++; binding = undefined },
    async open() {
      if (state.phase === "checking" || state.phase === "submitting") return
      const source = input.capture()
      if (!source) return
      const request = ++generation
      binding = source
      const current = () => !disposed && request === generation && source.isCurrent()
      set({ phase: "loading" })
      try {
        const snapshot = await source.read()
        if (current()) set({ phase: "ready", snapshot })
      } catch (error) {
        if (current()) {
          if (error instanceof ContextPreviewChanged) invalidate()
          else set({ phase: "error", error })
        }
      }
    },
    async confirm() {
      if (!["ready", "error"].includes(state.phase) || !state.snapshot || !binding) return
      const source = binding, snapshot = state.snapshot, request = generation
      const current = () => !disposed && request === generation && source.isCurrent()
      if (!current()) { invalidate(); return }
      set({ phase: "checking", snapshot })
      try {
        const fresh = await source.read()
        if (!current()) return
        if (fresh.revision !== snapshot.revision || fresh.sessionID !== snapshot.sessionID ||
            fresh.directory !== snapshot.directory || fresh.projectID !== snapshot.projectID ||
            fresh.updatedAt !== snapshot.updatedAt || fresh.contextJSON !== snapshot.contextJSON) {
          invalidate()
          return
        }
        // Dispatch only through the originally captured typed owner and Session.
        set({ phase: "submitting", snapshot })
        await source.compact(snapshot)
        if (current()) set({ phase: "admitted", snapshot })
      } catch (error) {
        if (current()) {
          if (error instanceof ContextPreviewChanged) invalidate()
          else set({ phase: "error", snapshot, error })
        }
      }
    },
  }
}

export async function contextReadRevision(value: unknown): Promise<string> {
  const json = JSON.stringify(value) ?? "null"
  // Remote HTTP Web origins may lack SubtleCrypto. Exact contextJSON and
  // metadata comparison above remains authoritative for this client fence.
  return globalThis.crypto?.subtle ? `sha256:${await hash(json)}` : `checksum:${checksum(json)}`
}
