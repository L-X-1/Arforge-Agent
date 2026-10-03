const credentialKeys = new Set([
  "api_key", "apikey", "access_token", "authorization", "auth_token", "cookie",
  "password", "passwd", "secret", "session", "token",
])

export function normalizeWorkbenchBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Browser address must be a bounded HTTP(S) URL")
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new TypeError("Enter a complete HTTP(S) address")
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new TypeError("Only HTTP(S) addresses are supported")
  }
  if (url.username || url.password) throw new TypeError("Browser addresses must not contain inline credentials")
  for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const key of parameters.keys()) {
      if (credentialKeys.has(key.toLowerCase())) throw new TypeError("Browser addresses must not carry credentials")
    }
  }
  return url.href
}

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
