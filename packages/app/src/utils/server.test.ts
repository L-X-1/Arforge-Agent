import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createOperationsApiForServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to arforge", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "arforge", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("arforge:secret"))
  })
})

describe("operations API", () => {
  test("keeps the generated operations client distinct from the mature compatibility client", () => {
    const api = createOperationsApiForServer({
      server: { url: "http://localhost:4096" },
    })

    expect(api.sessions.get).toBeFunction()
    expect(api.goals.list).toBeFunction()
    expect(api.scheduledPrompts.list).toBeFunction()
    expect(api.tasks.list).toBeFunction()
    expect(api.agentCapabilities.list).toBeFunction()
    expect(api.controlledSessions.revert).toBeFunction()
  })

  test("sends controlled session revert through the authenticated server adapter", async () => {
    let captured: Request | undefined
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = input instanceof Request ? input : new Request(input, init)
        return Response.json({
          runID: "run_1",
          actionID: "act_1",
          requestID: "cpr_1",
          operation: "session.revert",
          phase: "waiting_for_confirmation",
          recovery: "awaiting_authorization",
          canApprove: true,
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const api = createOperationsApiForServer({
      server: { url: "http://localhost:4096", username: "operator", password: "secret" },
      fetch: fetcher,
    })

    const result = await api.controlledSessions.revert({
      sessionID: "ses /1",
      directory: "C:\\workspace",
      workspace: "ws_1",
      requestID: "cpr_1",
      messageID: "msg_1",
    })

    const url = new URL(captured?.url ?? "")
    expect(result).toMatchObject({ operation: "session.revert", phase: "waiting_for_confirmation" })
    expect(url.pathname).toBe("/experimental/session/ses%20%2F1/revert")
    expect(url.searchParams.get("directory")).toBe("C:\\workspace")
    expect(url.searchParams.get("workspace")).toBe("ws_1")
    expect(captured?.headers.get("authorization")).toBe(`Basic ${btoa("operator:secret")}`)
    expect(await captured?.clone().json()).toEqual({ requestID: "cpr_1", messageID: "msg_1" })
  })

  test("surfaces the nested server explanation when a controlled session request is rejected", async () => {
    const fetcher = Object.assign(
      async () =>
        Response.json(
          { name: "WorktreeApiError", data: { message: "The session changed; review it and try again." } },
          { status: 409 },
        ),
      { preconnect: globalThis.fetch.preconnect },
    )
    const api = createOperationsApiForServer({ server: { url: "http://localhost:4096" }, fetch: fetcher })

    await expect(
      api.controlledSessions.revert({
        sessionID: "ses_1",
        directory: "C:\\workspace",
        requestID: "cpr_1",
        messageID: "msg_1",
      }),
    ).rejects.toThrow("The session changed; review it and try again.")
  })

  test("sends the desktop repository-scale request through the generated Server contract", async () => {
    let captured: Request | undefined
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = input instanceof Request ? input : new Request(input, init)
        return Response.json({
          location: { directory: "C:\\workspace" },
          data: {
            schema_version: 1,
            root: "C:\\workspace",
            budget: { max_files: 5000, suffixes: [".ts"] },
            scan: {
              total: 1,
              added: 1,
              changed: 0,
              unchanged: 0,
              removed: 0,
              incremental: false,
              scan_time_ms: 2,
              truncated: false,
              total_files_estimate: 1,
              code_files_estimate: 1,
            },
            suffix_counts: { ".ts": 1 },
            largest_files: [{ path: "index.ts", suffix: ".ts", bytes: 12 }],
            search: {
              query: "needle",
              total: 1,
              items: [
                {
                  path: "index.ts",
                  line: 1,
                  score: 1,
                  matched_terms: ["needle"],
                  preview: "const needle = true",
                },
              ],
              searched_files: 1,
              truncated: false,
            },
            recommendations: ["Repository scan is within budget."],
          },
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const api = createOperationsApiForServer({
      server: { url: "http://localhost:4096" },
      fetch: fetcher,
    })

    const result = await api.agentCapabilities.repoScale({
      location: { directory: "C:\\workspace" },
      path: ".",
      query: "needle",
      maxFiles: 5_000,
      limit: 20,
    })

    expect(result.data.scan.total).toBe(1)
    expect(captured?.method).toBe("POST")
    expect(new URL(captured?.url ?? "").pathname).toBe("/api/agent-capabilities/repository-scale")
    expect(await captured?.clone().json()).toEqual({
      path: ".",
      query: "needle",
      maxFiles: 5_000,
      limit: 20,
    })
  })

  test("sends typed run-list and run-report requests through the generated Server contract", async () => {
    const captured: Request[] = []
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        captured.push(request)
        const path = new URL(request.url).pathname
        if (path.endsWith("/run-report")) {
          return Response.json({
            location: { directory: "C:\\workspace" },
            data: {
              schema_version: 1,
              found: false,
              run_id: "run-404",
              report: null,
            },
          })
        }
        return Response.json({
          location: { directory: "C:\\workspace" },
          data: {
            schema_version: 1,
            count: 1,
            items: [
              {
                run_id: "run-001",
                created: "2026-07-27 10:00:00",
                has_transaction: true,
                has_trace: true,
                has_messages: true,
                changed_files: 1,
                trace_events: 2,
                messages_count: 3,
                answer_preview: "done",
              },
            ],
          },
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    const api = createOperationsApiForServer({
      server: { url: "http://localhost:4096" },
      fetch: fetcher,
    })

    const list = await api.agentCapabilities.runList({
      location: { directory: "C:\\workspace" },
      limit: 50,
    })
    const report = await api.agentCapabilities.runReport({
      location: { directory: "C:\\workspace" },
      runID: "run-404",
    })

    expect(list.data.count).toBe(1)
    expect(report.data.found).toBe(false)
    expect(captured.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/agent-capabilities/runs",
      "/api/agent-capabilities/run-report",
    ])
    expect(new URL(captured[0]?.url ?? "").searchParams.get("limit")).toBe("50")
    expect(new URL(captured[1]?.url ?? "").searchParams.get("runID")).toBe("run-404")
  })
})
