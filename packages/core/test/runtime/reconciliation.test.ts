import { describe, expect, test } from "bun:test"
import {
  ReconciliationRegistry,
  type ReconciliationRequest,
} from "../../src/runtime/reconciliation"

const digest = (character: string) => character.repeat(64)

const request: ReconciliationRequest = {
  actionID: "act_reconcile_1",
  actionKind: "mcp",
  actionVersion: "1",
  intentDigest: digest("a"),
  idempotencyKey: "idem-reconcile-1",
}

const evidence = (state: "known_success" | "known_failure" | "unknown", source = "mcp") => ({
  state,
  evidenceDigest: digest(state === "known_success" ? "b" : state === "known_failure" ? "c" : "d"),
  source,
  observedAt: 1,
  summary: state === "unknown" ? "operation lookup did not find a durable result" : `operation is ${state}`,
})

describe("ReconciliationRegistry", () => {
  test("validates adapter identity, keeps one owner, and exposes a frozen catalog", () => {
    const registry = new ReconciliationRegistry()
    registry.register({ actionKind: "mcp", actionVersion: "1", inspect: () => evidence("unknown") })
    expect(registry.list()).toHaveLength(1)
    expect(() => registry.register({ actionKind: "mcp", actionVersion: "1", inspect: () => evidence("unknown") })).toThrow(
      /already registered/,
    )
  })

  test("inspects through the registered adapter and never exposes raw request payloads", async () => {
    const seen: ReconciliationRequest[] = []
    const registry = new ReconciliationRegistry()
    registry.register({
      actionKind: "api",
      actionVersion: "1",
      inspect: (input) => {
        seen.push(input)
        return evidence("known_success", "api")
      },
    })

    const result = await registry.inspect({ ...request, actionKind: "api" })
    expect(result).toMatchObject({ state: "known_success", source: "api" })
    expect(seen[0]).toEqual({
      actionID: request.actionID,
      actionKind: "api",
      actionVersion: request.actionVersion,
      intentDigest: request.intentDigest,
      idempotencyKey: request.idempotencyKey,
    })
  })

  test("confirms known state without running a second query and never authorizes retry", async () => {
    let followUps = 0
    const registry = new ReconciliationRegistry()
    registry.register({
      actionKind: "file",
      actionVersion: "1",
      inspect: () => evidence("known_failure", "file"),
      reconcile: () => {
        followUps += 1
        return evidence("known_success", "file")
      },
    })

    const decision = await registry.reconcile({ ...request, actionKind: "file" })
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_failure",
      automaticRetryAllowed: false,
    })
    expect(followUps).toBe(0)
  })

  test("uses a second read-only query after unknown and confirms a known success", async () => {
    let followUps = 0
    const registry = new ReconciliationRegistry()
    registry.register({
      actionKind: "mcp",
      actionVersion: "1",
      inspect: () => evidence("unknown"),
      reconcile: (_input, initial) => {
        followUps += 1
        expect(initial.state).toBe("unknown")
        return evidence("known_success")
      },
    })

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
      reason: "reconcile confirmed known_success; no retry was executed.",
    })
    expect(followUps).toBe(1)
  })

  test("keeps unknown state in manual review when no adapter or no second query exists", async () => {
    const registry = new ReconciliationRegistry()
    const missing = await registry.reconcile(request)
    expect(missing).toMatchObject({ kind: "manual_review", state: "unknown", automaticRetryAllowed: false })
    expect(missing.reason).toContain("manual review")

    registry.register({ actionKind: "mcp", actionVersion: "1", inspect: () => evidence("unknown") })
    const noFollowUp = await registry.reconcile(request)
    expect(noFollowUp).toMatchObject({ kind: "manual_review", state: "unknown", automaticRetryAllowed: false })
    expect(noFollowUp.reason).toContain("no second read-only")
  })

  test("does not hide a failed follow-up query and keeps retry forbidden", async () => {
    const registry = new ReconciliationRegistry()
    registry.register({
      actionKind: "api",
      actionVersion: "1",
      inspect: () => evidence("unknown", "api"),
      reconcile: () => Promise.reject(new Error("transport details must not escape")),
    })

    const decision = await registry.reconcile({ ...request, actionKind: "api" })
    expect(decision).toMatchObject({
      kind: "manual_review",
      state: "unknown",
      automaticRetryAllowed: false,
      adapterFailure: true,
    })
    expect(decision.reason).not.toContain("transport details")
  })

  test("fails closed for invalid request and evidence contracts", async () => {
    const registry = new ReconciliationRegistry()
    registry.register({ actionKind: "mcp", actionVersion: "1", inspect: () => evidence("unknown") })
    await expect(registry.inspect({ ...request, intentDigest: "not-a-digest" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    const invalid = new ReconciliationRegistry()
    invalid.register({
      actionKind: "mcp",
      actionVersion: "1",
      inspect: () => ({ ...evidence("unknown"), source: "not safe source" }),
    })
    await expect(invalid.inspect(request)).rejects.toMatchObject({ code: "INVALID_EVIDENCE" })
  })
})
