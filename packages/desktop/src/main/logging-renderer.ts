import type { WebContentsConsoleMessageEventParams } from "electron"
import type { LogMessage } from "electron-log"
import { redactPreviewResourceURLs } from "./preview-resource-url"

type ConsoleEvent = Pick<WebContentsConsoleMessageEventParams, "level" | "message">
type ConsoleListener = (event: ConsoleEvent) => void

export interface RendererConsoleSource {
  isDestroyed(): boolean
  on(event: "console-message", listener: ConsoleListener): unknown
  once(event: "destroyed", listener: () => void): unknown
  removeListener(event: "console-message", listener: ConsoleListener): unknown
  removeListener(event: "destroyed", listener: () => void): unknown
}

type CreatedListener = (event: unknown, contents: RendererConsoleSource) => void
interface RendererConsoleApp {
  on(event: "web-contents-created", listener: CreatedListener): unknown
  removeListener(event: "web-contents-created", listener: CreatedListener): unknown
}

export function captureRendererConsole(input: {
  app: RendererConsoleApp
  contents: () => readonly RendererConsoleSource[]
  write: (message: LogMessage) => void
}) {
  const attached = new Map<RendererConsoleSource, () => void>()
  let disposed = false

  const attach = (contents: RendererConsoleSource) => {
    if (disposed || contents.isDestroyed() || attached.has(contents)) return
    // Electron 42 reads console fields from this single event object. Keeping
    // additional callback parameters would opt back into its deprecated API.
    const onMessage: ConsoleListener = (event) => {
      input.write({
        date: new Date(),
        data: [redactPreviewResourceURLs(event.message)],
        level: event.level === "warning" ? "warn" : event.level,
        variables: { processType: "renderer" },
      })
    }
    const detach = () => {
      contents.removeListener("console-message", onMessage)
      contents.removeListener("destroyed", detach)
      attached.delete(contents)
    }
    attached.set(contents, detach)
    contents.on("console-message", onMessage)
    contents.once("destroyed", detach)
  }

  const onCreated: CreatedListener = (_event, contents) => attach(contents)
  input.app.on("web-contents-created", onCreated)
  input.contents().forEach(attach)

  return () => {
    if (disposed) return
    disposed = true
    input.app.removeListener("web-contents-created", onCreated)
    for (const detach of attached.values()) detach()
  }
}
