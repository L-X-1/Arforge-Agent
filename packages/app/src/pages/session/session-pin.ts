import { createEffect, onCleanup } from "solid-js"

type SessionPins = {
  pin(sessionID: string): void
  unpin(sessionID: string): void
}

export function createSessionPin(session: () => SessionPins, sessionID: () => string | undefined) {
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    const pinned = session()
    pinned.pin(id)
    // Resolving a reactive provider during disposal can re-enter its owner.
    // Release the exact registry that acquired this pin instead.
    onCleanup(() => pinned.unpin(id))
  })
}
