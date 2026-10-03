import { describe, expect, it } from "bun:test"
import {
  createExternalApiActionClient,
  createExternalApiReconciliationAdapter,
  createMemoryExternalApiActionJournal,
  type ExternalApiActionReceipt,
} from "../../src/runtime/external-api-action"
import { ReconciliationRegistry, type ReconciliationRequest } from "../../src/runtime/reconciliation"

const digest = (character: string) => character.repeat(64)

const policy = {
  allowedSchemes: ["http"] as const,
  allowedHosts: ["api.test"],
  allowedMethods: ["GET", "POST"],
}

const captureError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

const requestFor = (receipt: ExternalApiActionReceipt, intentDigest = receipt.requestDigest): ReconciliationRequest => ({
  actionID: receipt.actionID,
  actionKind: "api",
  actionVersion: "1",
  intentDigest,
  idempotencyKey: receipt.idempotencyKey,
})

const settledClient = async (journal: ReturnType<typeof createMemoryExternalApiActionJournal>) => {
  const client = createExternalApiActionClient({
    policy,
    journal,
    fetch: async () => new Response('{"settled":true,"owner":"alice@example.com"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  })
  return client.execute({
    operationID: "op_reconcile_settled",
    method: "POST",
    url: "http://api.test/publish",
    body: '{"value":"private"}',
    idempotencyKey: "idem_reconcile_settled",
    operationClass: "non-idempotent-write",
    allowedResponseContentTypes: ["application/json"],
    verify: () => true,
  })
}

describe("External API reconciliation adapter", () => {
  it("projects a settled journal receipt as known success without exposing request or response bodies", async () => {
    const journal = createMemoryExternalApiActionJournal()
    const result = await settledClient(journal)
    const registry = new ReconciliationRegistry().register(createExternalApiReconciliationAdapter({ journal }))

    const decision = await registry.reconcile(requestFor(result.receipt))
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
    })
    expect(JSON.stringify(decision)).not.toContain("alice@example.com")
    expect(JSON.stringify(decision)).not.toContain("private")
    expect(JSON.stringify(decision)).not.toContain("http://api.test")
  })

  it("projects a blocked journal receipt as known failure", async () => {
    const journal = createMemoryExternalApiActionJournal()
    const client = createExternalApiActionClient({
      policy,
      journal,
      fetch: async () => new Response("blocked", { status: 500, headers: { "content-type": "text/plain" } }),
    })
    const error = await captureError(
      client.execute({
        operationID: "op_reconcile_blocked",
        method: "GET",
        url: "http://api.test/status",
        idempotencyKey: "idem_reconcile_blocked",
      }),
    )
    const receipt = (error as { readonly receipt?: ExternalApiActionReceipt }).receipt
    expect(receipt?.state).toBe("blocked")
    const registry = new ReconciliationRegistry().register(createExternalApiReconciliationAdapter({ journal }))

    const decision = await registry.reconcile(requestFor(receipt!))
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_failure",
      automaticRetryAllowed: false,
    })
  })

  it("uses a read-only operation lookup after unknown and never authorizes a retry", async () => {
    const journal = createMemoryExternalApiActionJournal()
    let fetchCalls = 0
    let lookupCalls = 0
    const client = createExternalApiActionClient({
      policy,
      journal,
      fetch: async () => {
        fetchCalls += 1
        return new Response('{"accepted":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    const error = await captureError(
      client.execute({
        operationID: "op_reconcile_unknown",
        method: "POST",
        url: "http://api.test/write",
        idempotencyKey: "idem_reconcile_unknown",
        operationClass: "non-idempotent-write",
      }),
    )
    const receipt = (error as { readonly receipt?: ExternalApiActionReceipt }).receipt
    expect(receipt?.state).toBe("recovery_required")
    const registry = new ReconciliationRegistry().register(
      createExternalApiReconciliationAdapter({
        journal,
        lookup: (operationID) => {
          lookupCalls += 1
          expect(operationID).toBe("op_reconcile_unknown")
          return "settled"
        },
      }),
    )

    const decision = await registry.reconcile(requestFor(receipt!))
    expect(decision).toMatchObject({
      kind: "confirmed",
      state: "known_success",
      automaticRetryAllowed: false,
    })
    expect(fetchCalls).toBe(1)
    expect(lookupCalls).toBe(1)
  })

  it("fails closed on intent drift and lookup failure", async () => {
    const journal = createMemoryExternalApiActionJournal()
    const result = await settledClient(journal)
    let lookupCalls = 0
    const adapter = createExternalApiReconciliationAdapter({
      journal,
      lookup: () => {
        lookupCalls += 1
        throw new Error("transport secret must not escape")
      },
    })
    const registry = new ReconciliationRegistry().register(adapter)

    const drifted = await registry.reconcile(requestFor(result.receipt, digest("f")))
    expect(drifted).toMatchObject({ kind: "manual_review", state: "unknown", automaticRetryAllowed: false })
    expect(lookupCalls).toBe(0)

    const unknownJournal = createMemoryExternalApiActionJournal([
      {
        ...result.receipt,
        actionID: "act_api_unknown",
        state: "recovery_required",
        timeUpdated: result.receipt.timeUpdated + 1,
      },
    ])
    const unknownRegistry = new ReconciliationRegistry().register(
      createExternalApiReconciliationAdapter({
        journal: unknownJournal,
        lookup: () => {
          throw new Error("transport secret must not escape")
        },
      }),
    )
    const failedLookup = await unknownRegistry.reconcile(
      requestFor({ ...result.receipt, actionID: "act_api_unknown", state: "recovery_required" }),
    )
    expect(failedLookup).toMatchObject({
      kind: "manual_review",
      state: "unknown",
      automaticRetryAllowed: false,
      adapterFailure: true,
    })
    expect(failedLookup.reason).not.toContain("transport secret")
  })
})
