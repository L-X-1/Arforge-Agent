// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

const PUBLIC_AUTH_PATHS = new Map<string, ReadonlySet<string>>([
  ["GET", new Set(["/auth/config", "/auth/session"])],
  [
    "POST",
    new Set([
      "/auth/register",
      "/auth/verify-email",
      "/auth/forgot-password",
      "/auth/reset-password",
      "/auth/login",
      "/auth/logout",
      "/auth/logout-all",
    ]),
  ],
])

export function isPublicUIPath(method: string, pathname: string) {
  if (method === "GET" && PUBLIC_UI_PATHS.has(pathname)) return true
  return PUBLIC_AUTH_PATHS.get(method)?.has(pathname) ?? false
}
