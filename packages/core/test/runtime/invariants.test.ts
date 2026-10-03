import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  RuntimeInvariantError,
  RuntimeInvariantRegistry,
  assertActionResultConsistent,
  assertContiguousSequence,
  assertDelegatedAuthoritySubset,
  assertExactRequestDigest,
  assertFreshEpoch,
  assertLifecycleClosed,
  assertPolicyMonotonic,
  assertSettlementRecoveryInvariant,
  assertToolPairsClosed,
} from "@arforge-ai/core/runtime/invariants"

const digest = "a".repeat(64)

describe("RuntimeInvariantRegistry", () => {
  it("runs owner-scoped invariants in development/test and reports sibling failures", async () => {
    const registry = new RuntimeInvariantRegistry()
    registry
      .register({
        owner: "session",
        key: "event-sequence",
        version: "1",
        cost: "cheap",
        check: () => Effect.void,
      })
      .register({
        owner: "session",
        key: "request-digest",
        version: "1",
        cost: "expensive",
        check: () => Effect.fail(new Error("request payload is not exposed")),
      })
      .register({
        owner: "session",
        key: "sync-throw",
        version: "1",
        cost: "normal",
        check: () => {
          throw new Error("synchronous invariant failure")
        },
      })
      .register({
        owner: "tool",
        key: "not-selected",
        version: "1",
        cost: "cheap",
        check: () => Effect.fail(new Error("must not execute")),
      })

    const report = await Effect.runPromise(registry.run({}, { mode: "test", owner: "session" }))
    expect(report).toMatchObject({ checked: 3, skipped: 0, passed: 1, failed: 2, passedAll: false })
    expect(report.results[1]).toMatchObject({ key: "request-digest", status: "failed" })
    expect(report.results[2]).toMatchObject({ key: "sync-throw", status: "failed" })
    const targeted = await Effect.runPromise(
      registry.run({}, { mode: "test", owner: "session", key: "event-sequence" }),
    )
    expect(targeted).toMatchObject({ checked: 1, passed: 1, failed: 0, passedAll: true })
    await expect(Effect.runPromise(registry.assert({}, { mode: "test", owner: "session" }))).rejects.toMatchObject({
      code: "CHECK_FAILED",
    })
  })

  it("samples production checks deterministically while retaining cheap checks", async () => {
    const registry = new RuntimeInvariantRegistry()
    registry
      .register({ owner: "runtime", key: "cheap", version: "1", cost: "cheap", check: () => Effect.void })
      .register({
        owner: "runtime",
        key: "sampled",
        version: "1",
        cost: "expensive",
        sampleRate: 0.5,
        check: () => Effect.fail(new Error("sampled failure")),
      })
    const skipped = await Effect.runPromise(registry.run({}, { mode: "production", random: () => 0.9 }))
    expect(skipped).toMatchObject({ checked: 1, skipped: 1, passed: 1, failed: 0, passedAll: true })
    const failed = await Effect.runPromise(registry.run({}, { mode: "production", random: () => 0.1 }))
    expect(failed).toMatchObject({ checked: 2, skipped: 0, passed: 1, failed: 1, passedAll: false })
  })

  it("rejects duplicate registrations and refuses owner disposal with leaked resources", () => {
    const registry = new RuntimeInvariantRegistry()
    registry.register({ owner: "provider", key: "epoch", version: "1", cost: "cheap", check: () => Effect.void })
    expect(() =>
      registry.register({ owner: "provider", key: "epoch", version: "1", cost: "cheap", check: () => Effect.void }),
    ).toThrow(RuntimeInvariantError)
    const lease = registry.track("provider", "provider-listener")
    expect(() => registry.disposeOwner("provider")).toThrow(/provider-listener/)
    lease.release()
    expect(registry.disposeOwner("provider")).toMatchObject({ owner: "provider", removedInvariants: 1 })
    expect(registry.list("provider")).toEqual([])
  })
})

describe("first runtime invariant checks", () => {
  it("protects sequence, lifecycle, request, epoch, policy, authority and tool pairs", () => {
    expect(() => assertContiguousSequence([{ seq: 1 }, { seq: 2 }, { seq: 3 }])).not.toThrow()
    expect(() => assertContiguousSequence([{ seq: 1 }, { seq: 3 }])).toThrow()
    expect(() => assertLifecycleClosed([{ id: "turn-1", status: "completed" }], new Set(["completed"]))).not.toThrow()
    expect(() => assertLifecycleClosed([{ id: "turn-1", status: "running" }], new Set(["completed"]))).toThrow()
    expect(() => assertExactRequestDigest(digest, digest)).not.toThrow()
    expect(() => assertExactRequestDigest(digest, "b".repeat(64))).toThrow()
    expect(() => assertFreshEpoch(2, 2, true)).not.toThrow()
    expect(() => assertFreshEpoch(1, 2, true)).toThrow()
    expect(() => assertPolicyMonotonic("allow", "deny", ["allow", "confirm", "deny"])).not.toThrow()
    expect(() => assertPolicyMonotonic("deny", "allow", ["allow", "confirm", "deny"])).toThrow()
    expect(() => assertDelegatedAuthoritySubset(new Set(["read", "write"]), new Set(["read"]))).not.toThrow()
    expect(() => assertDelegatedAuthoritySubset(new Set(["read"]), new Set(["write"]))).toThrow()
    expect(() =>
      assertToolPairsClosed([
        { type: "call", callID: "c1" },
        { type: "result", callID: "c1" },
      ]),
    ).not.toThrow()
    expect(() => assertToolPairsClosed([{ type: "call", callID: "c1" }])).toThrow()
  })

  it("requires durable action/result agreement", () => {
    expect(() =>
      assertActionResultConsistent({
        actionStatus: "settled",
        observationStatus: "succeeded",
        modelResultStatus: "succeeded",
      }),
    ).not.toThrow()
    expect(() => assertActionResultConsistent({ actionStatus: "settled" })).toThrow()
    expect(() =>
      assertActionResultConsistent({
        actionStatus: "settled",
        observationStatus: "failed",
        modelResultStatus: "succeeded",
      }),
    ).toThrow()
    expect(() => assertActionResultConsistent({ actionStatus: "executing", modelResultStatus: "succeeded" })).toThrow()
  })

  it("keeps settlement recovery ordered, conflict-safe, and provider-inert", () => {
    expect(() =>
      assertSettlementRecoveryInvariant({
        deterministic: true,
        providerExecutionAllowed: false,
        next: ["admission-evidence", "child-result"],
        missing: ["admission-evidence", "child-result"],
        conflicts: [],
        complete: false,
      }),
    ).not.toThrow()
    expect(() =>
      assertSettlementRecoveryInvariant({
        deterministic: true,
        providerExecutionAllowed: false,
        next: ["child-result", "admission-evidence"],
        missing: ["child-result", "admission-evidence"],
        conflicts: [],
        complete: false,
      }),
    ).toThrow(/Evidence → result → budget order/)
    expect(() =>
      assertSettlementRecoveryInvariant({
        deterministic: true,
        providerExecutionAllowed: false,
        next: ["child-result"],
        missing: ["child-result"],
        conflicts: ["digest drift"],
        complete: false,
      }),
    ).toThrow(/cannot schedule owner writes/)
    expect(() =>
      assertSettlementRecoveryInvariant({
        deterministic: true,
        providerExecutionAllowed: true,
        next: [],
        missing: [],
        conflicts: [],
        complete: true,
      }),
    ).toThrow(/cannot authorize provider execution/)
  })
})
