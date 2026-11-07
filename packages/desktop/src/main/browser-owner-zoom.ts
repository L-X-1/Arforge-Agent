import type { EventEmitter } from "node:events"

// Main-process-only lifecycle signal; never exposed to renderer IPC.
export const browserOwnerZoomWillChange = "arforge-browser-owner-zoom-will-change"

type ZoomOwner = Pick<EventEmitter, "once" | "removeListener" | "emit"> & {
  readonly webContents: { getZoomFactor(): number; setZoomFactor(factor: number): void }
}

const hooks = new WeakMap<ZoomOwner, () => void>()

export function observeWorkbenchBrowserOwnerZoom(owner: ZoomOwner): () => void {
  const existing = hooks.get(owner)
  if (existing) return existing
  const contents = owner.webContents
  const original = contents.setZoomFactor
  // Programmatic setZoomFactor emits neither owner resize nor zoom-changed.
  // Hook the actual writer once, covering public IPC and window zoom controls.
  const guarded = (factor: number) => {
    if (factor !== contents.getZoomFactor()) owner.emit(browserOwnerZoomWillChange)
    original.call(contents, factor)
  }
  contents.setZoomFactor = guarded
  const stop = () => {
    if (hooks.get(owner) !== stop) return
    hooks.delete(owner)
    owner.removeListener("closed", stop)
    // Use the captured contents: owner.webContents is invalid after close.
    if (contents.setZoomFactor === guarded) contents.setZoomFactor = original
  }
  hooks.set(owner, stop)
  owner.once("closed", stop)
  return stop
}
