import { describe, expect, test } from "bun:test"
import { RuntimeInvariantRegistry } from "@arforge-ai/core/runtime/invariants"
import { Effect } from "effect"
import {
  assertRuntimeInvariant,
  assertSupervisorSnapshot,
  checkpointProjection,
  mergeSupervisorCheckpoints,
  McpSupervisor,
  McpSupervisorSnapshot,
  registerInvariants,
} from "../../src/mcp/supervisor"

describe("MCP supervisor", () => {
  test("rejects stale generations and performs a ready swap", () => {
    const supervisor = new McpSupervisor("demo", { jitterRatio: 0 }, { random: () => 0.5 })
    const first = supervisor.requestConnect(0)
    const second = supervisor.requestConnect(0)

    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(true)
    expect(supervisor.markReady(first.generation)).toEqual({ kind: "stale", generation: first.generation })
    expect(supervisor.markReady(second.generation)).toEqual({ kind: "ready", generation: second.generation })
    expect(supervisor.snapshot()).toMatchObject({
      phase: "ready",
      health: "healthy",
      desiredGeneration: second.generation,
      observedGeneration: second.generation,
      failureCount: 0,
    })
    const replacement = supervisor.requestConnect(2)
    expect(supervisor.markFailure(second.generation, "late close", 2)).toEqual({
      kind: "stale",
      generation: second.generation,
    })
    expect(supervisor.snapshot().desiredGeneration).toBe(replacement.allowed ? replacement.generation : -1)
  })

  test("uses bounded exponential backoff and opens a crash-loop circuit", () => {
    const supervisor = new McpSupervisor(
      "unstable",
      { baseDelayMs: 100, maxDelayMs: 150, jitterRatio: 0, failureThreshold: 3, cooldownMs: 1_000 },
      { random: () => 0.5 },
    )
    const { generation } = supervisor.requestConnect(0)

    supervisor.markFailure(generation, new Error("socket failed"), 0)
    expect(supervisor.snapshot()).toMatchObject({ phase: "backoff", nextRetryAt: 100, failureCount: 1 })
    expect(supervisor.canAttempt(99)).toBe(false)
    expect(supervisor.requestConnect(99)).toMatchObject({ allowed: false, reason: "backoff", retryAt: 100 })
    expect(supervisor.canAttempt(100)).toBe(true)

    supervisor.markFailure(generation, "connection closed", 100)
    expect(supervisor.snapshot()).toMatchObject({ phase: "backoff", nextRetryAt: 250, failureCount: 2 })
    supervisor.markFailure(generation, "protocol failed", 250)
    expect(supervisor.snapshot()).toMatchObject({ phase: "circuit_open", nextRetryAt: 1_250, failureCount: 3 })

    const blocked = supervisor.requestConnect(1_249)
    expect(blocked).toMatchObject({ allowed: false, reason: "circuit_open", retryAt: 1_250 })
    const allowed = supervisor.requestConnect(1_250)
    expect(allowed).toMatchObject({ allowed: true, generation: generation + 1 })
  })

  test("drain invalidates old callbacks and requires a deadline", () => {
    const supervisor = new McpSupervisor("swap", { drainTimeoutMs: 50 })
    const active = supervisor.requestConnect(0)
    supervisor.markReady(active.generation, 1)
    const replacement = supervisor.beginDrain(10)

    expect(replacement).toBe(active.generation + 1)
    expect(supervisor.snapshot()).toMatchObject({ phase: "draining", drainDeadline: 60 })
    expect(supervisor.markReady(active.generation)).toEqual({ kind: "stale", generation: active.generation })
    expect(supervisor.completeDrain(59)).toBe(false)
    expect(supervisor.completeDrain(60)).toBe(true)
    expect(supervisor.snapshot()).toMatchObject({ phase: "idle", observedGeneration: null, drainDeadline: null })
  })

  test("health updates are generation-scoped and snapshots are redacted", () => {
    const supervisor = new McpSupervisor("safe", { jitterRatio: 0 })
    const attempt = supervisor.requestConnect(0)
    supervisor.markReady(attempt.generation, 1)
    expect(supervisor.markHealthSuccess(attempt.generation + 1)).toEqual({
      kind: "stale",
      generation: attempt.generation + 1,
    })
    supervisor.markFailure(attempt.generation, "https://user:secret@example.test/token", 2)
    const snapshot = supervisor.snapshot()
    expect(snapshot.safeMessage).not.toContain("secret")
    expect(snapshot.safeMessage).not.toContain("example.test")
    expect(snapshot.lastFailure).toBe("connection_failed")
    expect(() => assertSupervisorSnapshot(snapshot)).not.toThrow()
    expect(() => McpSupervisorSnapshot.make(snapshot)).not.toThrow()
    expect(() =>
      assertSupervisorSnapshot({
        ...snapshot,
        safeMessage: "transport failed at https://user:secret@example.test/token",
      }),
    ).toThrow("redacted catalog")
  })

  test("fails closed for impossible persisted retry and lifecycle states", () => {
    const supervisor = new McpSupervisor("invalid")
    const snapshot = supervisor.snapshot()

    expect(() =>
      assertSupervisorSnapshot({
        ...snapshot,
        phase: "backoff",
        health: "unhealthy",
        lastFailure: "connection_failed",
        nextRetryAt: null,
      }),
    ).toThrow("retry timestamp")
    expect(() =>
      assertSupervisorSnapshot({
        ...snapshot,
        phase: "circuit_open",
        health: "unhealthy",
        lastFailure: "connection_failed",
        circuitOpenedAt: 1,
        nextRetryAt: null,
      }),
    ).toThrow("retry timestamp")
    expect(() =>
      assertSupervisorSnapshot({
        ...snapshot,
        phase: "ready",
        health: "healthy",
        observedGeneration: null,
      }),
    ).toThrow("desired healthy generation")
    expect(() => assertSupervisorSnapshot({ ...snapshot, observedGeneration: 0 })).toThrow("observed generation")
  })

  test("restores durable retry memory without resurrecting an old connection", () => {
    const source = new McpSupervisor("restart", { jitterRatio: 0 }, { random: () => 0.5 })
    const generation = source.requestConnect(0)
    source.markReady(generation.generation, 1)
    const checkpoint = source.rememberCheckpoint(10)

    const restored = new McpSupervisor("restart", { jitterRatio: 0 }, { random: () => 0.5 })
    restored.restoreCheckpoint(checkpoint, 20)
    expect(restored.snapshot()).toMatchObject({
      phase: "idle",
      health: "unknown",
      observedGeneration: null,
      lastKnown: { phase: "ready", health: "healthy", savedAt: 10 },
    })
    expect(restored.requestConnect(20)).toEqual({ allowed: true, generation: checkpoint.desiredGeneration + 1 })

    const failing = new McpSupervisor("retry", { baseDelayMs: 100, jitterRatio: 0 }, { random: () => 0.5 })
    const attempt = failing.requestConnect(0)
    failing.markFailure(attempt.generation, "connection closed", 0)
    const retryCheckpoint = failing.rememberCheckpoint(1)
    const retrying = new McpSupervisor("retry", { baseDelayMs: 100, jitterRatio: 0 }, { random: () => 0.5 })
    retrying.restoreCheckpoint(retryCheckpoint, 50)
    expect(retrying.requestConnect(50)).toMatchObject({ allowed: false, reason: "backoff", retryAt: 100 })
  })

  test("keeps snapshot and checkpoint outputs immutable and rejects invalid restore atomically", () => {
    const source = new McpSupervisor("immutable", { jitterRatio: 0 }, { random: () => 0.5 })
    const attempt = source.requestConnect(0)
    source.markReady(attempt.generation, 1)
    const checkpoint = source.rememberCheckpoint(10)
    const exposed = source.snapshot()
    Object.assign(exposed, { safeMessage: "transport failed at https://user:secret@example.test/token" })
    if (exposed.lastKnown)
      Object.assign(exposed.lastKnown, { safeMessage: "transport failed at https://user:secret@example.test/token" })

    expect(source.snapshot()).toMatchObject({
      phase: "ready",
      safeMessage: "MCP server is connected and healthy.",
      lastKnown: { safeMessage: "MCP server is connected and healthy." },
    })

    const restored = new McpSupervisor("immutable", { jitterRatio: 0 }, { random: () => 0.5 })
    const before = restored.snapshot()
    expect(() =>
      restored.restoreCheckpoint(
        {
          ...checkpoint,
          safeMessage: "transport failed at https://user:secret@example.test/token",
        },
        20,
      ),
    ).toThrow("redacted catalog")
    expect(restored.snapshot()).toEqual(before)
    restored.restoreCheckpoint({ ...checkpoint }, 20)
    expect(restored.snapshot()).toMatchObject({ phase: "idle", lastKnown: { savedAt: 10 } })
  })

  test("merges replicated checkpoints by generation and refuses divergent hosts", () => {
    const source = new McpSupervisor("replicated", { jitterRatio: 0 }, { random: () => 0.5 })
    const first = source.requestConnect(0)
    source.markReady(first.generation, 1)
    const ready = source.rememberCheckpoint(10)
    const connecting: typeof ready = {
      ...ready,
      desiredGeneration: ready.desiredGeneration + 1,
      phase: "connecting",
      health: "unknown",
      observedGeneration: ready.observedGeneration,
      failureCount: 0,
      nextRetryAt: null,
      circuitOpenedAt: null,
      drainDeadline: null,
      lastFailure: null,
      safeMessage: "MCP server is connecting or waiting for approval.",
      savedAt: 20,
    }

    expect(mergeSupervisorCheckpoints([ready, connecting])).toMatchObject({
      status: "accepted",
      reason: "highest-generation",
      checkpoint: { desiredGeneration: connecting.desiredGeneration, phase: "connecting" },
    })

    const sameGenerationConflict: typeof ready = {
      ...ready,
      phase: "closed",
      observedGeneration: null,
      health: "unknown",
      safeMessage: "MCP server is stopped.",
      savedAt: 30,
    }
    expect(mergeSupervisorCheckpoints([ready, sameGenerationConflict])).toMatchObject({
      status: "conflict",
      checkpoint: null,
      generation: ready.desiredGeneration,
      candidateCount: 2,
    })

    const restored = new McpSupervisor("replicated", { jitterRatio: 0 }, { random: () => 0.5 })
    expect(restored.restoreCheckpoints([ready, connecting], 30)).toMatchObject({ status: "accepted" })
    expect(restored.snapshot()).toMatchObject({ phase: "idle", lastKnown: { phase: "connecting", savedAt: 20 } })
    expect(restored.restoreCheckpoints([ready, sameGenerationConflict], 30)).toMatchObject({ status: "conflict" })
    expect(restored.snapshot()).toMatchObject({ lastKnown: { phase: "connecting", savedAt: 20 } })

    expect(mergeSupervisorCheckpoints([ready, { ...ready, server: "other" }])).toMatchObject({
      status: "conflict",
      checkpoint: null,
      generation: null,
    })
  })

  test("runs snapshot, checkpoint, and catalog generation checks through the shared registry", async () => {
    const registry = new RuntimeInvariantRegistry()
    registerInvariants(registry)
    const supervisor = new McpSupervisor("registry")
    const attempt = supervisor.requestConnect(0)
    supervisor.markReady(attempt.generation, 1)
    const snapshot = supervisor.snapshot()
    const checkpoint = checkpointProjection(snapshot, 2)

    expect(registry.list("mcp-supervisor").map((invariant) => invariant.key)).toEqual([
      "snapshot",
      "checkpoint",
      "catalog-generation",
    ])
    await expect(
      Effect.runPromise(assertRuntimeInvariant(registry, "snapshot", { kind: "snapshot", snapshot })),
    ).resolves.toBeUndefined()
    await expect(
      Effect.runPromise(assertRuntimeInvariant(registry, "checkpoint", { kind: "checkpoint", checkpoint })),
    ).resolves.toBeUndefined()
    await expect(
      Effect.runPromise(
        assertRuntimeInvariant(registry, "catalog-generation", {
          kind: "catalog-generation",
          snapshot,
          generation: attempt.generation,
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        assertRuntimeInvariant(registry, "catalog-generation", {
          kind: "catalog-generation",
          snapshot,
          generation: attempt.generation - 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" })
    await expect(
      Effect.runPromise(
        assertRuntimeInvariant(registry, "checkpoint", {
          kind: "checkpoint",
          checkpoint: { ...checkpoint, savedAt: -1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "CHECK_FAILED" })
  })
})
