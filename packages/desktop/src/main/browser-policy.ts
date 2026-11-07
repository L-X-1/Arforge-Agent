import { normalizeWorkbenchBrowserUrl } from "@arforge-ai/app/browser-workbench"
export { normalizeWorkbenchBrowserUrl } from "@arforge-ai/app/browser-workbench"

export function requireWorkbenchBrowserOrigin(value: unknown, allowedOrigins: ReadonlySet<string>): string {
  const url = normalizeWorkbenchBrowserUrl(value)
  if (!allowedOrigins.has(new URL(url).origin)) {
    throw new TypeError("This origin has not been opened explicitly. Use the Address menu to open it first.")
  }
  return url
}

export function workbenchBrowserPreferences(partition: string) {
  if (!/^arforge-browser-[a-zA-Z0-9-]+$/.test(partition)) throw new TypeError("An ephemeral browser partition is required")
  return {
    partition,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    plugins: false,
    devTools: false,
    disableDialogs: true,
    spellcheck: false,
    autoplayPolicy: "user-gesture-required",
  } as const
}
