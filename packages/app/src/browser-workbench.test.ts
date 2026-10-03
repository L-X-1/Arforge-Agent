import { expect, test } from "bun:test"
import { shouldAcceptBrowserPageState, toWorkbenchBrowserScope, type BrowserPageState } from "./browser-workbench"
import { ServerScope, SessionRouteKey, SessionStateKey } from "./utils/server-scope"

const page: BrowserPageState = { scope: "server:project:one", pageID: "one", revision: 3, url: "https://example.com/", loading: false, canGoBack: true, canGoForward: false, notice: "" }

test("accepts only snapshots for the current session and exact page generation", () => {
  expect(shouldAcceptBrowserPageState(page, { ...page, revision: 4 }, page.scope)).toBe(true)
  expect(shouldAcceptBrowserPageState(page, page, page.scope)).toBe(true)
  expect(shouldAcceptBrowserPageState(page, { ...page, revision: 2 }, page.scope)).toBe(false)
  expect(shouldAcceptBrowserPageState(page, { ...page, scope: "server:project:two" }, page.scope)).toBe(false)
  expect(shouldAcceptBrowserPageState(page, { ...page, pageID: "reopened" }, page.scope)).toBe(false)
  expect(shouldAcceptBrowserPageState(page, page, "server:project:two")).toBe(false)
  expect(shouldAcceptBrowserPageState(undefined, page, page.scope)).toBe(false)
})

test("serializes the real session-state key without changing its identity", () => {
  const key = SessionStateKey.from(ServerScope.local, SessionRouteKey.fromRoute("workspace-base64", "session-one"))
  expect(key).toContain("\u0000")
  const scope = toWorkbenchBrowserScope(key)
  expect(scope).not.toMatch(/[\u0000-\u001f\u007f]/)
  expect(JSON.parse(scope.slice("session:".length))).toBe(key)
  expect(toWorkbenchBrowserScope(key)).toBe(scope)
})

test("keeps server, workspace and session identities separate after serialization", () => {
  const key = (server: ServerScope, directory: string, sessionID: string) =>
    SessionStateKey.from(server, SessionRouteKey.fromRoute(directory, sessionID))
  const keys = [
    key(ServerScope.local, "workspace-a", "one"),
    key("remote" as ServerScope, "workspace-a", "one"),
    key(ServerScope.local, "workspace-b", "one"),
    key(ServerScope.local, "workspace-a", "two"),
    "local\\u0000workspace-a/one",
    "localworkspace-a/one",
  ]
  expect(new Set(keys.map(toWorkbenchBrowserScope)).size).toBe(keys.length)
  const first = { ...page, scope: toWorkbenchBrowserScope(keys[0]!) }
  expect(shouldAcceptBrowserPageState(first, { ...first, scope: toWorkbenchBrowserScope(keys[1]!) }, first.scope)).toBe(false)
})

test("escapes controls without collapsing literal escapes or Unicode keys", () => {
  const keys = ["a\u0000b", "a\\u0000b", "a\u007fb", "a\\u007fb", "a\nb", 'a"b',
    "a\\b", "\u4e2d\u6587/session", "\ud800/session"]
  for (const key of keys) {
    const scope = toWorkbenchBrowserScope(key)
    expect(scope).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(JSON.parse(scope.slice("session:".length))).toBe(key)
  }
  expect(new Set(keys.map(toWorkbenchBrowserScope)).size).toBe(keys.length)
})

test("does not turn an empty internal key into a valid browser scope", () => {
  for (const key of ["", " ", "\t\n"]) expect(() => toWorkbenchBrowserScope(key)).toThrow()
})
