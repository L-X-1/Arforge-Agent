import { describe, expect, test } from "bun:test"
import { createOperationsApiForServer } from "./server"
import type { AuditVerify, RuntimeInsightPage } from "@arforge-ai/protocol/groups/runtime-insight"
import { ClientError } from "@arforge-ai/sdk-next/remote"

function snapshot(): typeof RuntimeInsightPage.Type {
  return {
    access: {
      role: "member",
      canReviewMutation: true,
      canRollbackMutation: false,
      canMaintainArtifacts: false,
      canRecordMcpEvidence: false,
    },
    contextLayers: [],
    routing: [],
    verifications: [],
    audit: [],
    auditDropped: 0,
    auditVerify: { valid: true, count: 2, headHash: "original-head", issue: null },
    runs: [],
    durableRuns: [],
    durableActions: [],
    recalls: [],
  }
}

function setup(body: unknown, status = 200) {
  const requests: Request[] = []
  const api = createOperationsApiForServer({
    server: { url: "http://localhost:4096", username: "fixture", password: "fixture-only" },
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init))
        return Response.json(body, { status })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  return { api, requests }
}

describe("runtime insight JSON boundary", () => {
  test("retains finite values, original audit hashes and legacy verification without scope", async () => {
    const body = snapshot()
    const { api } = setup(body)
    expect(await api.runtimeInsight.snapshot()).toEqual(body)
    const { api: verify } = setup(body.auditVerify)
    const result = await verify.runtimeInsight.auditVerify()
    expect(result).toEqual(body.auditVerify)
    expect(result.scope).toBeUndefined()
  })

  test("decodes canonical numeric JSON values without replacing them with zero", async () => {
    const { api } = setup({
      ...snapshot(),
      auditDropped: "Infinity",
      runs: [
        {
          runID: "run_owned",
          sessionID: "ses_owned",
          status: "completed",
          startedAt: "-Infinity",
          finishedAt: "NaN",
          lastSeq: 17,
          error: null,
        },
      ],
    })
    const result = await api.runtimeInsight.snapshot()
    expect(result.auditDropped).toBe(Infinity)
    expect(result.runs[0]?.startedAt).toBe(-Infinity)
    expect(result.runs[0]?.finishedAt).toBeNaN()
    expect(result.runs[0]?.lastSeq).toBe(17)
  })

  test("preserves principal verification and does not rehash or widen its count", async () => {
    const body: typeof AuditVerify.Type = {
      valid: false,
      count: 3,
      headHash: "visible-original-head",
      issue: "record hash mismatch",
      scope: "principal-records",
    }
    const { api } = setup(body)
    expect(await api.runtimeInsight.auditVerify()).toEqual(body)
  })

  test("forwards workspace, directory, limit, authentication and cancellation", async () => {
    const { api, requests } = setup(snapshot())
    const controller = new AbortController()
    await api.runtimeInsight.snapshot(
      { location: { directory: "E:/owned workspace", workspace: "workspace_owned" }, limit: "17" },
      { signal: controller.signal },
    )
    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.pathname).toBe("/api/runtime-insight/snapshot")
    expect(url.searchParams.get("location[directory]")).toBe("E:/owned workspace")
    expect(url.searchParams.get("location[workspace]")).toBe("workspace_owned")
    expect(url.searchParams.get("limit")).toBe("17")
    expect(request.headers.get("Authorization")).toBe(`Basic ${btoa("fixture:fixture-only")}`)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  test("invalid successful payload fails closed with a payload-free error", async () => {
    const { api } = setup({ ...snapshot(), auditVerify: { count: "private-invalid-value" } })
    await expect(api.runtimeInsight.snapshot()).rejects.toThrow("Invalid runtime insight response")
    try {
      await api.runtimeInsight.snapshot()
    } catch (error) {
      expect(String(error)).not.toContain("private-invalid-value")
      expect(error instanceof Error && error.cause).toBeUndefined()
    }
  })

  test("preserves HTTP errors instead of reporting a decoding error or empty success", async () => {
    const { api } = setup({ error: "ForbiddenError", message: "fixture access denied" }, 403)
    try {
      await api.runtimeInsight.auditVerify()
      throw new Error("unexpected success")
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError)
      expect(error instanceof ClientError && error.reason).toBe("UnexpectedStatus")
    }
  })
})
