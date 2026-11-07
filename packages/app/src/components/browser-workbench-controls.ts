import { normalizeWorkbenchBrowserUrl, type BrowserPageCommand } from "@/browser-workbench"

export function canRunBrowserCommand(busy: boolean, action: BrowserPageCommand) {
  return !busy || action.action === "stop"
}

// A retry is read from a Solid store proxy. Electron IPC accepts structured
// clone data, so capture the command's primitive fields before crossing it.
export function browserCommandPayload(command: BrowserPageCommand): BrowserPageCommand {
  return command.action === "navigate"
    ? { action: "navigate", url: normalizeWorkbenchBrowserUrl(command.url) }
    : { action: command.action }
}
