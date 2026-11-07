import { describe, expect, test } from "bun:test"
import { sessionIDFromRoutePath, settingsReturnTarget, settingsRoute } from "./settings-dialog-context"

describe("settings dialog route context", () => {
  test("extracts a session ID from canonical and legacy routes", () => {
    expect(sessionIDFromRoutePath("/server/c2lkZWNhcg/session/ses_live-1")).toBe("ses_live-1")
    expect(sessionIDFromRoutePath("/workspace/session/ses_live-2")).toBe("ses_live-2")
  })

  test("fails closed for non-session or malformed paths", () => {
    expect(sessionIDFromRoutePath("/")).toBeUndefined()
    expect(sessionIDFromRoutePath("/server/c2lkZWNhcg/session/")).toBeUndefined()
    expect(sessionIDFromRoutePath("/server/c2lkZWNhcg/session/%E0%A4%A")).toBeUndefined()
    expect(sessionIDFromRoutePath("/server/c2lkZWNhcg/session/%20%20")).toBeUndefined()
  })

  test("preserves and encodes the originating Session in one settings route", () => {
    expect(settingsRoute()).toBe("/settings")
    expect(settingsRoute("  ")).toBe("/settings")
    expect(settingsRoute("ses_live-1")).toBe("/settings?sessionID=ses_live-1")
    expect(settingsRoute("ses/live ?#")).toBe("/settings?sessionID=ses%2Flive%20%3F%23")
  })

  test("retains the canonical server route and a draft without accepting external return paths", () => {
    const origin = "/server/c2lkZWNhcg/session/ses_live-1"
    const query = new URL(settingsRoute("ses_live-1", origin), "https://local.test").searchParams
    expect(query.get("sessionID")).toBe("ses_live-1")
    expect(query.get("returnTo")).toBe(origin)
    expect(settingsReturnTarget("https://outside.test/session/ses_live-1")).toBeUndefined()
    expect(settingsReturnTarget("//outside.test/session/ses_live-1")).toBeUndefined()
    expect(settingsReturnTarget("/new-session?draftId=local-draft&token=private")).toBe("/new-session?draftId=local-draft")
    expect(settingsRoute("different-session", origin)).toBe("/settings?sessionID=different-session")
  })
})
