import { describe, expect, test } from "bun:test"
import { ServerConnection } from "../../src/context/server"
import * as copies from "./v5-owned-lifecycle-copies/boundary-fixture"
import { fixture, mockGlobal, mockServer } from "./v5-owned-lifecycle-jobs-tasks/sdk-fixture"

describe("Owned lifecycle fixture repairs", () => {
  test("copy boundary retains the actual server identity owner", () => {
    expect(copies.ServerConnection).toBe(ServerConnection)
    expect(copies.RECENTLY_CLOSED_DISPLAY_LIMIT).toBeGreaterThan(0)
    const server = copies.useServer().current
    expect(copies.useGlobal().ensureServerCtx().sdk.server).toBe(server)
    expect(ServerConnection.key(server)).toContain("isolated-copy.invalid")
  })

  test("real OperationsApi reads explicit empty history and pending permissions", async () => {
    const api = mockGlobal.ensureServerCtx(mockServer.current).sdk.operationsApi
    const sessionID = fixture.state.sessionID
    expect(await api.sessions.history({ sessionID, limit: 100, after: 0 })).toEqual({ data: [], hasMore: false })
    expect(await api.permissions.list({ sessionID })).toEqual([])
    const snapshot = fixture.snapshot()
    expect(snapshot.violations).toEqual([])
    expect(snapshot.calls.map(call => ({ method: call.method, path: call.path, action: call.action }))).toEqual([
      { method: "GET", path: `/api/session/${sessionID}/history`, action: "wait:history" },
      { method: "GET", path: `/api/session/${sessionID}/permission`, action: "wait:permissions" },
    ])
  })

  test("the new reads never fabricate a successful permission decision", async () => {
    const api = mockGlobal.ensureServerCtx(mockServer.current).sdk.operationsApi
    const sessionID = fixture.state.sessionID
    await expect(api.permissions.reply({ sessionID, requestID: "per_unissued", reply: "once" })).rejects.toThrow()
    expect(fixture.snapshot().calls.every(call => call.method === "GET")).toBe(true)
    expect(fixture.snapshot().violations).toEqual([
      `Unexpected automation request POST /api/session/${sessionID}/permission/per_unissued/reply`,
    ])
  })
})
