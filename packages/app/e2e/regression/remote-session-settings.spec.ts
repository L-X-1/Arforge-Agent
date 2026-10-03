import { base64Encode } from "@arforge-ai/core/util/encode"
import { expect, test, type Page, type Route } from "@playwright/test"
import { installSseTransport } from "../utils/sse-transport"
import { currentSession } from "../utils/mock-server"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const directoryA = "C:/server-a"
const directoryB = "/home/server-b"
const sessionA = session("ses_server_a", directoryA, "Server A session")
const childSessionA = { ...session("ses_server_a_child", directoryA, "Server A child session"), parentID: sessionA.id }
const sessionB = session("ses_server_b", directoryB, "Server B session")

test("session settings use the remote server context", async ({ page }) => {
  const permissionRequests: string[] = []
  await mockServers(page, permissionRequests)
  await configureServers(page)

  await page.goto(`/server/${base64Encode(serverB)}/session/${sessionB.id}`)
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")

  const dialog = page.locator(".settings-v2-dialog")
  const autoAccept = dialog.locator('[data-action="settings-auto-accept-permissions"]')
  const input = autoAccept.getByRole("switch")
  await expect(autoAccept).toBeVisible()
  await expect(input).toBeEnabled()
  permissionRequests.length = 0
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(input).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverB && requestDirectory(url) === directoryB
      }),
    )
    .toBe(true)
  expect(permissionRequests.every((request) => new URL(request).origin === serverB)).toBe(true)

  await dialog.getByRole("tab", { name: "Models" }).click()
  await expect(dialog.getByRole("switch", { name: "Server B Model" })).toBeEnabled()
  await expect(dialog.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
})

test("auto-accept responds for an unfocused server session", async ({ page }) => {
  const permissionRequests: string[] = []
  const permissionResponses: PermissionResponse[] = []
  const transport = await installSseTransport<{ directory: string; payload: Record<string, unknown> }>(page, {
    server: serverA,
    retry: 20,
  })
  await mockServers(page, permissionRequests, permissionResponses)
  await configureServers(page, [
    { type: "session", server: serverA, sessionId: sessionA.id },
    { type: "session", server: serverB, sessionId: sessionB.id },
  ])

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/server/${base64Encode(serverA)}/session/${sessionA.id}`)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()
  await page.keyboard.press("Control+,")
  const autoAccept = page.locator(".settings-v2-dialog").locator('[data-action="settings-auto-accept-permissions"]')
  await autoAccept.locator('[data-slot="switch-control"]').click()
  await expect(autoAccept.getByRole("switch")).toBeChecked()
  await expect
    .poll(() =>
      permissionRequests.some((request) => {
        const url = new URL(request)
        return url.origin === serverA && requestDirectory(url) === directoryA
      }),
    )
    .toBe(true)
  await page.keyboard.press("Escape")

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`).click()
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  await transport.waitForConnection()

  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a",
      type: "permission.asked",
      properties: {
        id: "permission-background-a",
        sessionID: sessionA.id,
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
      },
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: directoryA,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { response: "once" },
      },
    ])

  await transport.send({
    directory: directoryA,
    payload: {
      id: "event-permission-background-a-child",
      type: "permission.asked",
      properties: {
        id: "permission-background-a-child",
        sessionID: childSessionA.id,
        permission: "bash",
        patterns: ["git diff"],
        metadata: {},
        always: [],
      },
    },
  })

  await expect
    .poll(() => permissionResponses)
    .toEqual([
      {
        origin: serverA,
        directory: directoryA,
        sessionID: sessionA.id,
        permissionID: "permission-background-a",
        body: { response: "once" },
      },
      {
        origin: serverA,
        directory: directoryA,
        sessionID: childSessionA.id,
        permissionID: "permission-background-a-child",
        body: { response: "once" },
      },
    ])
})

type PermissionResponse = {
  origin: string
  directory?: string
  sessionID: string
  permissionID: string
  body: unknown
}

async function configureServers(page: Page, tabs: { type: "session"; server: string; sessionId: string }[] = []) {
  await page.addInitScript(
    ({ serverB, tabs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("arforge.global.dat:server", JSON.stringify({ list: [serverB] }))
      localStorage.setItem("arforge.window.browser.dat:tabs", JSON.stringify(tabs))
    },
    { serverB, tabs },
  )
}

async function mockServers(page: Page, permissionRequests: string[], permissionResponses: PermissionResponse[] = []) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: corsHeaders(route) })
    if (url.pathname === "/auth/session") return json(route, { authenticated: true, mode: "private" })
    if (url.origin !== serverA && url.origin !== serverB) return route.fallback()
    const remote = url.origin === serverB
    const directory = remote ? directoryB : directoryA
    const sessions = remote ? [sessionB] : [sessionA, childSessionA]
    const requestedDirectory = requestDirectory(url, route.request().headers())
    const permissionReply = url.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)
    if (route.request().method() === "POST" && permissionReply) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestedDirectory ?? directory,
        sessionID: permissionReply[1]!,
        permissionID: permissionReply[2]!,
        body: normalizePermissionBody(route.request().postDataJSON()),
      })
      return json(route, { location: { directory }, data: true })
    }
    const response = url.pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (route.request().method() === "POST" && response) {
      permissionResponses.push({
        origin: url.origin,
        directory: requestedDirectory ?? undefined,
        sessionID: response[1]!,
        permissionID: response[2]!,
        body: normalizePermissionBody(route.request().postDataJSON()),
      })
      return json(route, true)
    }
    if (requestedDirectory && requestedDirectory !== directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event")
      return sse(route)
    // Exercise the current v2 transport; v1 legacy servers are covered by the
    // compatibility tests and use a different response envelope.
    if (url.pathname === "/global/health") return json(route, {}, 404)
    if (url.pathname === "/api/provider")
      return json(route, { location: { directory }, data: [v2Provider(remote ? "server-b" : "server-a")] })
    if (url.pathname === "/api/model")
      return json(route, { location: { directory }, data: [v2Model(remote ? "server-b" : "server-a")] })
    if (url.pathname === "/api/agent") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/model/default") return json(route, { data: null })
    if (["/api/command", "/api/reference", "/api/question/request"].includes(url.pathname))
      return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/permission/request") {
      permissionRequests.push(url.toString())
      return json(route, { location: { directory }, data: [] })
    }
    if (url.pathname === "/api/mcp") return json(route, { location: { directory }, data: [] })
    if (url.pathname === "/api/mcp/resource")
      return json(route, { location: { directory }, data: { resources: [], templates: [] } })
    if (url.pathname === "/api/project") {
      return json(route, [
        {
          id: remote ? sessionB.projectID : "project-server-a",
          worktree: directory,
          vcs: "git",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
      ])
    }
    if (url.pathname === "/api/project/current")
      return json(route, { id: remote ? sessionB.projectID : "project-server-a", directory })
    if (url.pathname === "/api/session") return json(route, { data: sessions.map(currentSession), cursor: {} })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    // The v1 compatibility path uses the SDK's legacy `/session` endpoint,
    // whose response is a raw v2-shaped session array (the `/api` endpoint
    // above is the v2 promise-client envelope).
    if (url.pathname === "/session") return json(route, sessions)
    const currentSessionInfo = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
    if (currentSessionInfo) return json(route, { data: currentSession(currentSessionInfo) })
    if (sessions.some((session) => url.pathname === `/api/session/${session.id}/message`))
      return json(route, { data: [], cursor: {} })
    const current = sessions.find((session) => url.pathname === `/session/${session.id}`)
    if (current) return json(route, current)
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (/^\/session\/[^/]+\/message$/.test(url.pathname)) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (url.pathname === "/permission") {
      permissionRequests.push(url.toString())
      return json(route, [])
    }
    if (["/skill", "/command", "/lsp", "/formatter", "/question", "/vcs/diff", "/pty/shells"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/provider") return json(route, provider(remote ? "server-b" : "server-a"))
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: remote ? sessionB.projectID : "project-server-a",
        worktree: directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: directory,
        config: directory,
        worktree: directory,
        directory,
        home: directory,
      })
    if (url.pathname === "/api/path")
      return json(route, { state: directory, config: directory, worktree: directory, directory, home: directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    if (url.pathname === "/api/vcs")
      return json(route, { location: { directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/pty/shells") return json(route, { location: { directory }, data: [] })
    return json(route, {})
  })
}

function requestDirectory(url: URL, headers?: Record<string, string>) {
  const header = headers?.["x-arforge-directory"]
  if (header) {
    try {
      return decodeURIComponent(header)
    } catch {
      return header
    }
  }
  return url.searchParams.get("directory") ?? url.searchParams.get("location[directory]")
}

function normalizePermissionBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const value = body as Record<string, unknown>
  return "reply" in value && !("response" in value) ? { response: value.reply } : body
}

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

function provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    all: [
      {
        id,
        name: `${name} Provider`,
        models: {
          [id]: {
            id,
            name: `${name} Model`,
            family: id,
            release_date: "2026-01-01",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: [id],
    default: { providerID: id, modelID: id },
  }
}

function v2Provider(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    id,
    name: `${name} Provider`,
    api: { type: "native", settings: {} },
    request: { headers: {}, body: {} },
  }
}

function v2Model(id: string) {
  const name = id === "server-b" ? "Server B" : "Server A"
  return {
    id,
    providerID: id,
    family: id,
    name: `${name} Model`,
    api: { id, type: "native", settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: Date.parse("2026-01-01") },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 16_000 },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(route),
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", headers: corsHeaders(route), body: ": ok\n\n" })
}

function corsHeaders(route: Route) {
  const origin = route.request().headers().origin
  return {
    "access-control-allow-origin": origin ?? "*",
    ...(origin ? { "access-control-allow-credentials": "true", vary: "Origin" } : {}),
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      route.request().headers()["access-control-request-headers"] ?? "authorization,content-type,x-arforge-directory",
  }
}
