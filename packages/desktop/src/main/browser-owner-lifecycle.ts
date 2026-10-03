import type { EventEmitter } from "node:events"

type EventSource = Pick<EventEmitter, "on" | "once" | "removeListener">

export function observeWorkbenchBrowserOwner(
  owner: EventSource & { readonly webContents: EventSource },
  callbacks: { suspend: () => void; dispose: () => void },
): () => void {
  // The native owner's webContents getter is invalid after its closed event.
  // Keep the original emitter for listener cleanup, not the destroyed owner.
  const contents = owner.webContents
  const { suspend, dispose } = callbacks
  const navigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean) => {
    if (main && !inPlace) dispose()
  }
  owner.on("resize", suspend)
  owner.on("blur", suspend)
  owner.on("minimize", suspend)
  owner.once("closed", dispose)
  contents.on("did-start-navigation", navigation)
  contents.once("render-process-gone", dispose)
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    owner.removeListener("resize", suspend)
    owner.removeListener("blur", suspend)
    owner.removeListener("minimize", suspend)
    owner.removeListener("closed", dispose)
    contents.removeListener("did-start-navigation", navigation)
    contents.removeListener("render-process-gone", dispose)
  }
}
