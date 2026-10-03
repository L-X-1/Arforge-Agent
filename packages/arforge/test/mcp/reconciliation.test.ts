import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ReconciliationRegistry, type ReconciliationRequest } from "@arforge-ai/core/runtime/reconciliation"
import {
  createMcpOperationReconciliationLookup,
  createMcpProviderReconciliationLookup,
  createMcpReconciliationAdapter,
  createMcpTaskReconciliationLookup,
  MCP_CHILD_ACTION_RESOURCE,
  MCP_OPERATION_RESOURCE_PREFIX,
  MCP_PROVIDER_RESOURCE_PREFIX,
  MCP_SERVER_RESOURCE_PREFIX,
  MCP_TASK_RESOURCE_PREFIX,
  McpProviderRegistry,
  mcpProviderOperationReference,
  type McpReconciliationSnapshot,
} from "../../src/mcp/reconciliation"

const digest = (character: string) => character.repeat(64)

const request: ReconciliationRequest = {
  actionID: "act_mcp_reconcile",
  actionKind: "mcp",
  actionVersion: "1",
  intentDigest: digest("a"),
  idempotencyKey: "act_mcp_reconcile",
}

function snapshot(
  input: {
    readonly intentDigest?: string
    readonly idempotencyKey?: string
    readonly status?: string
    readonly parentActionID?: string
    readonly resources?: ReadonlyArray<string>
    readonly externalOperation?: unknown
    readonly observation?: unknown
    readonly reconciliation?: unknown
  } = {},
): McpReconciliationSnapshot {
  return {
    action: {
      id: request.actionID,
      intentDigest: input.intentDigest ?? request.intentDigest,
      idempotencyKey: input.idempotencyKey ?? request.idempotencyKey,
      status: input.status ?? "blocked",
      ...(input.parentActionID === undefined ? {} : { parentActionID: input.parentActionID }),
      resources: [...(input.resources ?? [])],
      time: { updated: DateTime.makeUnsafe(1_000) },
    } as never,
    ...(input.observation === undefined ? {} : { observation: input.observation as never }),
    ...(input.reconciliation === undefined ? {} : { reconciliation: input.reconciliation as never }),
    ...(input.externalOperation === undefined ? {} : { externalOperation: input.externalOperation as never }),
  } as McpReconciliationSnapshot
}

describe("MCP read-only reconciliation adapter", () => {
  test("projects an existing durable success without exposing payloads", async () => {
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            status: "settled",
            observation: {
              id: "obs_mcp_success",
              status: "succeeded",
              observedAt: DateTime.makeUnsafe(2_000),
            },
          }),
      }),
    )

    const evidence = await registry.inspect(request)
    expect(evidence).toMatchObject({
      state: "known_success",
      source: "mcp-durable-action",
      observedAt: 2_000,
    })
    expect(JSON.stringify(evidence)).not.toContain("secret")
  })

  test("projects a durable failure and a prior reconciliation using the same identity", async () => {
    const failed = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            status: "blocked",
            observation: {
              id: "obs_mcp_failure",
              status: "failed",
              observedAt: DateTime.makeUnsafe(3_000),
            },
          }),
      }),
    )
    expect(await failed.inspect(request)).toMatchObject({ state: "known_failure", observedAt: 3_000 })

    const prior = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            reconciliation: {
              actionID: request.actionID,
              intentDigest: request.intentDigest,
              idempotencyKey: request.idempotencyKey,
              state: "known_failure",
              evidenceDigest: digest("b"),
              source: "mcp-lookup",
              observedAt: DateTime.makeUnsafe(4_000),
              summary: "read-only lookup confirmed the server rejected the call",
              automaticRetryAllowed: false,
            },
          }),
      }),
    )
    expect(await prior.inspect(request)).toMatchObject({
      state: "known_failure",
      evidenceDigest: digest("b"),
      source: "mcp-lookup",
      observedAt: 4_000,
    })
  })

  test("returns unknown without a retry capability when no durable observation exists", async () => {
    let lookupCalls = 0
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () => snapshot(),
        lookup: async () => {
          lookupCalls += 1
          return {
            state: "known_success",
            evidenceDigest: digest("c"),
            source: "mcp-lookup",
            observedAt: 5_000,
          }
        },
      }),
    )

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({ kind: "confirmed", state: "known_success", automaticRetryAllowed: false })
    expect(lookupCalls).toBe(1)
    expect(decision.reason).toContain("no retry")
  })

  test("does not call a lookup after durable identity drift", async () => {
    let lookupCalls = 0
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () => snapshot({ intentDigest: digest("d") }),
        lookup: async () => {
          lookupCalls += 1
          return { state: "known_success", evidenceDigest: digest("e"), source: "mcp-lookup", observedAt: 6_000 }
        },
      }),
    )

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({ kind: "manual_review", state: "unknown", automaticRetryAllowed: false })
    expect(lookupCalls).toBe(0)
  })

  test("contains lookup failure and keeps the result unknown", async () => {
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () => snapshot(),
        lookup: async () => {
          throw new Error("private transport details")
        },
      }),
    )

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({
      kind: "manual_review",
      state: "unknown",
      automaticRetryAllowed: false,
      adapterFailure: true,
    })
    expect(decision.reason).not.toContain("private transport details")
  })

  test("uses the official MCP task status lookup without fetching a task payload", async () => {
    const calls: Array<{ readonly server: string; readonly taskID: string }> = []
    const lookup = createMcpTaskReconciliationLookup({
      now: () => 8_000,
      lookupTask: async (reference) => {
        calls.push(reference)
        return { status: "completed", observedAt: 7_000 }
      },
    })
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            parentActionID: "act_parent",
            resources: [
              MCP_CHILD_ACTION_RESOURCE,
              `${MCP_SERVER_RESOURCE_PREFIX}billing`,
              `${MCP_TASK_RESOURCE_PREFIX}task-42`,
            ],
          }),
        lookup,
      }),
    )

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
      evidence: { source: "mcp-server-task", observedAt: 7_000 },
    })
    expect(calls).toEqual([{ server: "billing", taskID: "task-42" }])
    expect(JSON.stringify(decision)).not.toContain("task-42")
    expect(decision.reason).toContain("no retry")
  })

  test("maps a working or malformed server task to bounded unknown evidence", async () => {
    let calls = 0
    const lookup = createMcpTaskReconciliationLookup({
      now: () => 9_000,
      lookupTask: async () => {
        calls += 1
        return { status: "working", observedAt: 8_500 }
      },
    })
    const working = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            parentActionID: "act_parent",
            resources: [
              MCP_CHILD_ACTION_RESOURCE,
              `${MCP_SERVER_RESOURCE_PREFIX}billing`,
              `${MCP_TASK_RESOURCE_PREFIX}task-43`,
            ],
          }),
        lookup,
      }),
    )
    const decision = await working.reconcile(request)
    expect(decision).toMatchObject({ kind: "manual_review", state: "unknown", automaticRetryAllowed: false })
    expect(decision.evidence.observedAt).toBe(8_500)
    expect(calls).toBe(1)

    const malformed = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            parentActionID: "act_parent",
            resources: [
              MCP_CHILD_ACTION_RESOURCE,
              `${MCP_SERVER_RESOURCE_PREFIX}billing`,
              `${MCP_TASK_RESOURCE_PREFIX}task with spaces`,
            ],
          }),
        lookup,
      }),
    )
    const malformedDecision = await malformed.reconcile(request)
    expect(malformedDecision).toMatchObject({ state: "unknown", kind: "manual_review" })
    expect(calls).toBe(1)
  })

  test("uses an automatically persisted taskCreated binding when no task resource marker exists", async () => {
    const calls: Array<{ readonly server: string; readonly taskID: string }> = []
    const lookup = createMcpTaskReconciliationLookup({
      now: () => 10_000,
      lookupTask: async (reference) => {
        calls.push(reference)
        return { status: "completed", observedAt: 9_500 }
      },
    })
    const registry = new ReconciliationRegistry().register(
      createMcpReconciliationAdapter({
        loadAction: async () =>
          snapshot({
            parentActionID: "act_parent",
            resources: [MCP_CHILD_ACTION_RESOURCE, `${MCP_SERVER_RESOURCE_PREFIX}billing`],
            externalOperation: {
              version: 1,
              kind: "mcp_task",
              server: "billing",
              operation: "charge",
              taskID: "task-auto-42",
              boundAt: DateTime.makeUnsafe(8_000),
            },
          }),
        lookup,
      }),
    )

    const decision = await registry.reconcile(request)
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
      evidence: { source: "mcp-server-task", observedAt: 9_500 },
    })
    expect(calls).toEqual([{ server: "billing", taskID: "task-auto-42" }])
    expect(JSON.stringify(decision)).not.toContain("task-auto-42")
  })

  test("requires explicit vendor markers and returns unavailable when no provider contract exists", async () => {
    const vendorSnapshot = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_PROVIDER_RESOURCE_PREFIX}stripe`,
        `${MCP_OPERATION_RESOURCE_PREFIX}op-42`,
      ],
    })
    expect(mcpProviderOperationReference(vendorSnapshot)).toEqual({
      server: "billing",
      provider: "stripe",
      operationID: "op-42",
    })

    const lookup = createMcpOperationReconciliationLookup({ now: () => 11_000 })
    const decision = await new ReconciliationRegistry()
      .register(createMcpReconciliationAdapter({ loadAction: async () => vendorSnapshot, lookup }))
      .reconcile(request)
    expect(decision).toMatchObject({
      kind: "manual_review",
      state: "unknown",
      automaticRetryAllowed: false,
      evidence: { source: "mcp-provider" },
    })
    expect(decision.evidence.summary).toContain("provider contract is unavailable")
  })

  test("uses only the registered vendor provider and never exposes the operation reference", async () => {
    const calls: Array<Record<string, string>> = []
    const providers = new McpProviderRegistry().register("stripe", async (reference) => {
      calls.push(reference)
      return { status: "completed", observedAt: 10_500 }
    })
    const lookup = createMcpProviderReconciliationLookup({ providers, now: () => 12_000 })
    const vendorSnapshot = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_PROVIDER_RESOURCE_PREFIX}stripe`,
        `${MCP_OPERATION_RESOURCE_PREFIX}op-43`,
      ],
    })
    const decision = await new ReconciliationRegistry()
      .register(createMcpReconciliationAdapter({ loadAction: async () => vendorSnapshot, lookup }))
      .reconcile(request)
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
      evidence: { source: "mcp-provider", observedAt: 10_500 },
    })
    expect(calls).toEqual([{ server: "billing", provider: "stripe", operationID: "op-43" }])
    expect(JSON.stringify(decision)).not.toContain("op-43")
  })

  test("contains malformed vendor provider status as unknown", async () => {
    const providers = new McpProviderRegistry().register("stripe", async () => ({ status: "done" as never }))
    const lookup = createMcpProviderReconciliationLookup({ providers, now: () => 13_000 })
    const vendorSnapshot = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_PROVIDER_RESOURCE_PREFIX}stripe`,
        `${MCP_OPERATION_RESOURCE_PREFIX}op-46`,
      ],
    })
    const evidence = await lookup(request, vendorSnapshot)
    expect(evidence).toMatchObject({ state: "unknown", source: "mcp-provider" })
    expect(evidence.summary).toContain("invalid status")
  })

  test("rejects mixed or ambiguous vendor markers and keeps task dispatch separate", async () => {
    const mixed = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_PROVIDER_RESOURCE_PREFIX}stripe`,
        `${MCP_OPERATION_RESOURCE_PREFIX}op-44`,
        `${MCP_TASK_RESOURCE_PREFIX}task-44`,
      ],
    })
    expect(mcpProviderOperationReference(mixed)).toBeUndefined()

    const calls: string[] = []
    const task = createMcpTaskReconciliationLookup({
      lookupTask: async (reference) => {
        calls.push(`task:${reference.taskID}`)
        return { status: "completed", observedAt: 10_600 }
      },
    })
    const provider = createMcpOperationReconciliationLookup({
      lookupTask: async (reference) => {
        calls.push(`task:${reference.taskID}`)
        return { status: "completed", observedAt: 10_600 }
      },
      providers: new McpProviderRegistry().register("stripe", async () => {
        calls.push("vendor")
        return { status: "completed", observedAt: 10_700 }
      }),
    })
    const taskSnapshot = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_TASK_RESOURCE_PREFIX}task-45`,
        `${MCP_PROVIDER_RESOURCE_PREFIX}stripe`,
        `${MCP_OPERATION_RESOURCE_PREFIX}op-45`,
      ],
    })
    // A mixed task/vendor snapshot is never routed to the vendor contract.
    expect(await provider(request, taskSnapshot)).toMatchObject({ state: "unknown" })
    expect(calls).toEqual([])
    expect(await task(request, taskSnapshot)).toMatchObject({ state: "unknown" })
    const pureTaskSnapshot = snapshot({
      parentActionID: "act_parent",
      resources: [
        MCP_CHILD_ACTION_RESOURCE,
        `${MCP_SERVER_RESOURCE_PREFIX}billing`,
        `${MCP_TASK_RESOURCE_PREFIX}task-45`,
      ],
    })
    expect(await task(request, pureTaskSnapshot)).toMatchObject({ state: "known_success" })
    expect(calls).toEqual(["task:task-45"])
  })
})
