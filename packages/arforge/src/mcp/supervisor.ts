import { Effect, Schema } from "effect"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"

/**
 * Process-local MCP connection supervisor.
 *
 * The supervisor is deliberately transport-agnostic. MCP owns the client and
 * the connection lifecycle; this module owns only the state transitions that
 * make reconnect decisions deterministic and stale callbacks harmless.
 */
export const SupervisorPhase = Schema.Literals([
  "idle",
  "connecting",
  "ready",
  "backoff",
  "circuit_open",
  "draining",
  "closed",
] as const).annotate({ identifier: "McpSupervisorPhase" })
export type SupervisorPhase = Schema.Schema.Type<typeof SupervisorPhase>

export const SupervisorHealth = Schema.Literals(["unknown", "healthy", "unhealthy"] as const).annotate({
  identifier: "McpSupervisorHealth",
})
export type SupervisorHealth = Schema.Schema.Type<typeof SupervisorHealth>

export const SupervisorFailure = Schema.Literals([
  "connection_failed",
  "connection_closed",
  "health_check_failed",
  "authentication_required",
  "approval_required",
  "protocol_failed",
  "unknown",
] as const).annotate({ identifier: "McpSupervisorFailure" })
export type SupervisorFailure = Schema.Schema.Type<typeof SupervisorFailure>

/** Safe state persisted for restart recovery. It contains no transport,
 * endpoint, header, prompt, tool definition, or raw error information. */
export const SupervisorCheckpoint = Schema.Struct({
  server: Schema.String,
  desiredGeneration: Schema.Int,
  observedGeneration: Schema.NullOr(Schema.Int),
  phase: SupervisorPhase,
  health: SupervisorHealth,
  failureCount: Schema.Int,
  nextRetryAt: Schema.NullOr(Schema.Int),
  circuitOpenedAt: Schema.NullOr(Schema.Int),
  drainDeadline: Schema.NullOr(Schema.Int),
  lastFailure: Schema.NullOr(SupervisorFailure),
  safeMessage: Schema.String,
  savedAt: Schema.Int,
}).annotate({ identifier: "McpSupervisorCheckpoint" })
export type SupervisorCheckpoint = Schema.Schema.Type<typeof SupervisorCheckpoint>

export const McpSupervisorSnapshot = Schema.Struct({
  server: Schema.String,
  desiredGeneration: Schema.Int,
  observedGeneration: Schema.NullOr(Schema.Int),
  phase: SupervisorPhase,
  health: SupervisorHealth,
  failureCount: Schema.Int,
  nextRetryAt: Schema.NullOr(Schema.Int),
  circuitOpenedAt: Schema.NullOr(Schema.Int),
  drainDeadline: Schema.NullOr(Schema.Int),
  lastFailure: Schema.NullOr(SupervisorFailure),
  safeMessage: Schema.String,
  /** Last committed checkpoint, if this instance restored one. */
  lastKnown: Schema.optional(Schema.NullOr(SupervisorCheckpoint)),
}).annotate({ identifier: "McpSupervisorSnapshot" })
export type McpSupervisorSnapshot = Schema.Schema.Type<typeof McpSupervisorSnapshot>

export type McpSupervisorInvariantContext =
  | { readonly kind: "snapshot"; readonly snapshot: McpSupervisorSnapshot }
  | { readonly kind: "checkpoint"; readonly checkpoint: SupervisorCheckpoint }
  | {
      readonly kind: "catalog-generation"
      readonly snapshot: McpSupervisorSnapshot
      readonly generation: number
    }

export interface SupervisorConfig {
  /** Initial retry delay. */
  readonly baseDelayMs?: number
  /** Hard upper bound for an ordinary retry delay. */
  readonly maxDelayMs?: number
  /** Deterministic jitter ratio in [0, 1]. */
  readonly jitterRatio?: number
  /** Consecutive failures needed to open the circuit. */
  readonly failureThreshold?: number
  /** How long an open circuit remains closed to attempts. */
  readonly cooldownMs?: number
  /** Maximum time allowed for an old client to drain. */
  readonly drainTimeoutMs?: number
}

export const DEFAULT_SUPERVISOR_CONFIG = Object.freeze({
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  failureThreshold: 3,
  cooldownMs: 30_000,
  drainTimeoutMs: 2_000,
}) satisfies Required<SupervisorConfig>

export type SupervisorDecision =
  | {
      readonly allowed: true
      readonly generation: number
    }
  | {
      readonly allowed: false
      readonly generation: number
      readonly retryAt: number | null
      readonly reason: "backoff" | "circuit_open" | "draining" | "closed"
    }

export type SupervisorTransition =
  | { readonly kind: "ready"; readonly generation: number }
  | { readonly kind: "stale"; readonly generation: number }
  | { readonly kind: "health"; readonly generation: number; readonly healthy: boolean }

type NormalizedConfig = Required<SupervisorConfig>

const integerAtLeast = (value: number | undefined, fallback: number, minimum: number) => {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value!))
}

const normalizeConfig = (config?: SupervisorConfig): NormalizedConfig => {
  const baseDelayMs = integerAtLeast(config?.baseDelayMs, DEFAULT_SUPERVISOR_CONFIG.baseDelayMs, 1)
  const maxDelayMs = Math.max(
    baseDelayMs,
    integerAtLeast(config?.maxDelayMs, DEFAULT_SUPERVISOR_CONFIG.maxDelayMs, baseDelayMs),
  )
  const jitterRatio = Number.isFinite(config?.jitterRatio)
    ? Math.min(1, Math.max(0, config!.jitterRatio!))
    : DEFAULT_SUPERVISOR_CONFIG.jitterRatio
  const failureThreshold = integerAtLeast(config?.failureThreshold, DEFAULT_SUPERVISOR_CONFIG.failureThreshold, 1)
  const cooldownMs = integerAtLeast(config?.cooldownMs, DEFAULT_SUPERVISOR_CONFIG.cooldownMs, 1)
  const drainTimeoutMs = integerAtLeast(config?.drainTimeoutMs, DEFAULT_SUPERVISOR_CONFIG.drainTimeoutMs, 1)
  return { baseDelayMs, maxDelayMs, jitterRatio, failureThreshold, cooldownMs, drainTimeoutMs }
}

const SAFE_SUPERVISOR_MESSAGES = new Set<string>([
  "MCP server is connected and healthy.",
  "MCP server is connected; health check pending.",
  "MCP server is connecting or waiting for approval.",
  "MCP server is unavailable; retry is available after the backoff window.",
  "MCP server is paused after repeated failures; reconnect is available after cooldown.",
  "MCP server is stopping the previous connection before switching.",
  "MCP server is stopped.",
  "MCP server is waiting to connect.",
] as const)

const safeMessageFor = (phase: SupervisorPhase, health: SupervisorHealth, _nextRetryAt: number | null) => {
  if (phase === "ready" && health === "healthy") return "MCP server is connected and healthy."
  if (phase === "ready") return "MCP server is connected; health check pending."
  if (phase === "connecting") return "MCP server is connecting or waiting for approval."
  if (phase === "backoff") return "MCP server is unavailable; retry is available after the backoff window."
  if (phase === "circuit_open")
    return "MCP server is paused after repeated failures; reconnect is available after cooldown."
  if (phase === "draining") return "MCP server is stopping the previous connection before switching."
  if (phase === "closed") return "MCP server is stopped."
  return "MCP server is waiting to connect."
}

const failureKind = (error: unknown): SupervisorFailure => {
  const text =
    typeof error === "string" ? error.toLowerCase() : error instanceof Error ? error.message.toLowerCase() : ""
  if (text.includes("auth") || text.includes("oauth") || text.includes("client_id")) return "authentication_required"
  if (text.includes("approval") || text.includes("permission") || text.includes("denied") || text.includes("rejected"))
    return "approval_required"
  if (text.includes("health") || text.includes("ping")) return "health_check_failed"
  if (text.includes("protocol") || text.includes("initialize") || text.includes("mcp")) return "protocol_failed"
  if (text.includes("closed") || text.includes("disconnect")) return "connection_closed"
  if (text.length > 0) return "connection_failed"
  return "unknown"
}

/**
 * Invariant checks are intentionally public so tests and startup diagnostics
 * can prove that a snapshot never exposes an impossible combination.
 */
export const assertSupervisorSnapshot = (snapshot: McpSupervisorSnapshot): void => {
  if (snapshot.server.trim() === "") throw new Error("MCP supervisor server name is required")
  if (!SAFE_SUPERVISOR_MESSAGES.has(snapshot.safeMessage))
    throw new Error("MCP supervisor safe message is not from the redacted catalog")
  const nonNegativeInteger = (value: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid MCP supervisor ${label}`)
  }
  nonNegativeInteger(snapshot.desiredGeneration, "desired generation")
  nonNegativeInteger(snapshot.failureCount, "failure counter")
  if (snapshot.observedGeneration !== null) {
    nonNegativeInteger(snapshot.observedGeneration, "observed generation")
    if (snapshot.observedGeneration > snapshot.desiredGeneration)
      throw new Error("Observed MCP generation cannot exceed desired generation")
  }
  for (const [value, label] of [
    [snapshot.nextRetryAt, "retry timestamp"],
    [snapshot.circuitOpenedAt, "circuit timestamp"],
    [snapshot.drainDeadline, "drain deadline"],
  ] as const) {
    if (value !== null) nonNegativeInteger(value, label)
  }
  if (snapshot.phase === "circuit_open") {
    if (snapshot.circuitOpenedAt === null) throw new Error("Open MCP circuit must have an opening timestamp")
    if (snapshot.nextRetryAt === null) throw new Error("Open MCP circuit must have a retry timestamp")
    if (snapshot.health !== "unhealthy") throw new Error("Open MCP circuit must be unhealthy")
    if (snapshot.lastFailure === null) throw new Error("Open MCP circuit must retain its failure kind")
  } else if (snapshot.circuitOpenedAt !== null) {
    throw new Error("Only an open MCP circuit may expose circuitOpenedAt")
  }
  if (snapshot.phase === "backoff") {
    if (snapshot.nextRetryAt === null) throw new Error("MCP backoff must have a retry timestamp")
    if (snapshot.health !== "unhealthy") throw new Error("MCP backoff must be unhealthy")
    if (snapshot.lastFailure === null) throw new Error("MCP backoff must retain its failure kind")
  } else if (snapshot.phase !== "circuit_open" && snapshot.nextRetryAt !== null) {
    throw new Error("Only a retrying MCP supervisor may expose nextRetryAt")
  }
  if (snapshot.phase === "draining" && snapshot.drainDeadline === null)
    throw new Error("Draining MCP supervisor must have a deadline")
  if (snapshot.phase !== "draining" && snapshot.drainDeadline !== null)
    throw new Error("Only a draining MCP supervisor may expose drainDeadline")
  if (snapshot.phase === "ready") {
    if (snapshot.health !== "healthy" || snapshot.observedGeneration !== snapshot.desiredGeneration)
      throw new Error("Ready MCP supervisor must observe its desired healthy generation")
  } else if (snapshot.health === "healthy") {
    throw new Error("Only a ready MCP supervisor may be healthy")
  }
  if ((snapshot.phase === "idle" || snapshot.phase === "closed") && snapshot.observedGeneration !== null)
    throw new Error("Idle or closed MCP supervisor cannot retain an observed generation")
  if (
    (snapshot.phase === "idle" ||
      snapshot.phase === "connecting" ||
      snapshot.phase === "draining" ||
      snapshot.phase === "closed") &&
    snapshot.health !== "unknown"
  )
    throw new Error("Inactive MCP supervisor must have unknown health")
  const lastKnown = snapshot.lastKnown
  if (lastKnown != null) {
    if (lastKnown.server !== snapshot.server) throw new Error("MCP checkpoint server mismatch")
    assertSupervisorCheckpoint(lastKnown)
  }
}

/** Validate a persisted supervisor checkpoint before it can influence a live
 * instance. The checkpoint's save time is part of the persistence contract,
 * but never part of the live generation state. */
export const assertSupervisorCheckpoint = (checkpoint: SupervisorCheckpoint): void => {
  if (!Number.isSafeInteger(checkpoint.savedAt) || checkpoint.savedAt < 0)
    throw new Error("MCP supervisor checkpoint savedAt is invalid")
  const { savedAt: _savedAt, ...snapshot } = checkpoint
  assertSupervisorSnapshot({ ...snapshot, lastKnown: null })
}

const cloneCheckpoint = (checkpoint: SupervisorCheckpoint): SupervisorCheckpoint => ({ ...checkpoint })

const cloneSnapshot = (snapshot: McpSupervisorSnapshot): McpSupervisorSnapshot => ({
  ...snapshot,
  lastKnown:
    snapshot.lastKnown === undefined || snapshot.lastKnown === null
      ? snapshot.lastKnown
      : cloneCheckpoint(snapshot.lastKnown),
})

const checkpointStateKey = (checkpoint: SupervisorCheckpoint): string =>
  JSON.stringify([
    checkpoint.server,
    checkpoint.desiredGeneration,
    checkpoint.observedGeneration,
    checkpoint.phase,
    checkpoint.health,
    checkpoint.failureCount,
    checkpoint.nextRetryAt,
    checkpoint.circuitOpenedAt,
    checkpoint.drainDeadline,
    checkpoint.lastFailure,
    checkpoint.safeMessage,
  ] satisfies readonly [
    string,
    number,
    number | null,
    SupervisorPhase,
    SupervisorHealth,
    number,
    number | null,
    number | null,
    number | null,
    SupervisorFailure | null,
    string,
  ])

/**
 * Deterministically merge checkpoint replicas from more than one host. A
 * higher desired generation wins; replicas at that generation must describe
 * the exact same state or the result is a conflict. A conflict never selects
 * a winner, preventing clock skew or divergent hosts from resurrecting a
 * connection. The function is pure so a future distributed store can adopt it
 * without creating a second supervisor state machine.
 */
export type SupervisorCheckpointMerge =
  | { readonly status: "empty"; readonly checkpoint: null }
  | {
      readonly status: "accepted"
      readonly checkpoint: SupervisorCheckpoint
      readonly reason: "highest-generation" | "latest-saved" | "identical"
    }
  | {
      readonly status: "conflict"
      readonly checkpoint: null
      readonly server: string
      readonly generation: number | null
      readonly candidateCount: number
    }

export const mergeSupervisorCheckpoints = (checkpoints: readonly SupervisorCheckpoint[]): SupervisorCheckpointMerge => {
  if (checkpoints.length === 0) return { status: "empty", checkpoint: null }
  for (const checkpoint of checkpoints) assertSupervisorCheckpoint(checkpoint)

  const server = checkpoints[0]!.server
  if (checkpoints.some((checkpoint) => checkpoint.server !== server))
    return { status: "conflict", checkpoint: null, server, generation: null, candidateCount: checkpoints.length }

  const generation = Math.max(...checkpoints.map((checkpoint) => checkpoint.desiredGeneration))
  const candidates = checkpoints.filter((checkpoint) => checkpoint.desiredGeneration === generation)
  const signatures = new Set(candidates.map(checkpointStateKey))
  if (signatures.size !== 1)
    return { status: "conflict", checkpoint: null, server, generation, candidateCount: candidates.length }

  const checkpoint = candidates.reduce((latest, candidate) => (candidate.savedAt > latest.savedAt ? candidate : latest))
  return {
    status: "accepted",
    checkpoint,
    reason:
      candidates.length === 1
        ? "highest-generation"
        : candidates.every((candidate) => candidate.savedAt === checkpoint.savedAt)
          ? "identical"
          : "latest-saved",
  }
}

/** Register MCP lifecycle checks into the shared Core diagnostics registry. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (!registry.get("mcp-supervisor", "snapshot", "1"))
    registry.register({
      owner: "mcp-supervisor",
      key: "snapshot",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as McpSupervisorInvariantContext).kind !== "snapshot"
          )
            throw new Error("MCP supervisor snapshot invariant context is invalid")
          assertSupervisorSnapshot(
            (context as Extract<McpSupervisorInvariantContext, { readonly kind: "snapshot" }>).snapshot,
          )
        }),
    })
  if (!registry.get("mcp-supervisor", "checkpoint", "1"))
    registry.register({
      owner: "mcp-supervisor",
      key: "checkpoint",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as McpSupervisorInvariantContext).kind !== "checkpoint"
          )
            throw new Error("MCP supervisor checkpoint invariant context is invalid")
          const checkpoint = (context as Extract<McpSupervisorInvariantContext, { readonly kind: "checkpoint" }>)
            .checkpoint
          assertSupervisorCheckpoint(checkpoint)
        }),
    })
  if (!registry.get("mcp-supervisor", "catalog-generation", "1"))
    registry.register({
      owner: "mcp-supervisor",
      key: "catalog-generation",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as McpSupervisorInvariantContext).kind !== "catalog-generation"
          )
            throw new Error("MCP catalog generation invariant context is invalid")
          const value = context as Extract<McpSupervisorInvariantContext, { readonly kind: "catalog-generation" }>
          assertSupervisorSnapshot(value.snapshot)
          if (
            value.snapshot.phase !== "ready" ||
            value.snapshot.observedGeneration !== value.generation ||
            value.snapshot.desiredGeneration !== value.generation
          )
            throw new Error("stale MCP generation cannot publish catalog capabilities")
        }),
    })
}

const runtimeInvariantMode = (): RuntimeInvariants.InvariantMode =>
  process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"

export const assertRuntimeInvariant = (
  registry: RuntimeInvariants.RuntimeInvariantRegistry,
  key: "snapshot" | "checkpoint" | "catalog-generation",
  context: McpSupervisorInvariantContext,
) => registry.assert(context, { owner: "mcp-supervisor", key, mode: runtimeInvariantMode() }).pipe(Effect.asVoid)

/** Fields used to compare/persist checkpoints; excludes the previous
 * checkpoint so remembering a checkpoint cannot itself create a new digest. */
export const checkpointProjection = (snapshot: McpSupervisorSnapshot, savedAt: number): SupervisorCheckpoint => ({
  server: snapshot.server,
  desiredGeneration: snapshot.desiredGeneration,
  observedGeneration: snapshot.observedGeneration,
  phase: snapshot.phase,
  health: snapshot.health,
  failureCount: snapshot.failureCount,
  nextRetryAt: snapshot.nextRetryAt,
  circuitOpenedAt: snapshot.circuitOpenedAt,
  drainDeadline: snapshot.drainDeadline,
  lastFailure: snapshot.lastFailure,
  safeMessage: snapshot.safeMessage,
  savedAt,
})

/**
 * Deterministic state machine used by MCP. `now` and `random` are injectable
 * so retry/circuit behavior can be tested without sleeping or flaky timing.
 */
export class McpSupervisor {
  readonly server: string
  readonly config: NormalizedConfig
  private readonly random: () => number
  private state: McpSupervisorSnapshot

  constructor(server: string, config?: SupervisorConfig, options?: { readonly random?: () => number }) {
    if (!server.trim()) throw new Error("MCP supervisor server name is required")
    this.server = server
    this.config = normalizeConfig(config)
    this.random = options?.random ?? Math.random
    this.state = {
      server,
      desiredGeneration: 0,
      observedGeneration: null,
      phase: "idle",
      health: "unknown",
      failureCount: 0,
      nextRetryAt: null,
      circuitOpenedAt: null,
      drainDeadline: null,
      lastFailure: null,
      safeMessage: safeMessageFor("idle", "unknown", null),
      lastKnown: null,
    }
    assertSupervisorSnapshot(this.state)
  }

  snapshot(): McpSupervisorSnapshot {
    return cloneSnapshot(this.state)
  }

  /** Restore retry/circuit memory without claiming that an old transport is
   * still alive. The checkpoint remains visible as `lastKnown`; the live
   * state starts idle or in its still-active retry window. */
  restoreCheckpoint(checkpoint: SupervisorCheckpoint, now = Date.now()): void {
    if (checkpoint.server !== this.server) throw new Error("MCP checkpoint server mismatch")
    assertSupervisorCheckpoint(checkpoint)
    const storedCheckpoint = cloneCheckpoint(checkpoint)
    const retryActive =
      (storedCheckpoint.phase === "backoff" || storedCheckpoint.phase === "circuit_open") &&
      storedCheckpoint.nextRetryAt !== null &&
      storedCheckpoint.nextRetryAt > now
    const phase: SupervisorPhase = retryActive ? storedCheckpoint.phase : "idle"
    const health: SupervisorHealth = retryActive ? "unhealthy" : "unknown"
    this.state = {
      server: this.server,
      desiredGeneration: storedCheckpoint.desiredGeneration,
      observedGeneration: null,
      phase,
      health,
      failureCount: retryActive ? storedCheckpoint.failureCount : 0,
      nextRetryAt: retryActive ? storedCheckpoint.nextRetryAt : null,
      circuitOpenedAt: phase === "circuit_open" ? storedCheckpoint.circuitOpenedAt : null,
      drainDeadline: null,
      lastFailure: retryActive ? storedCheckpoint.lastFailure : null,
      safeMessage: safeMessageFor(phase, health, retryActive ? storedCheckpoint.nextRetryAt : null),
      lastKnown: storedCheckpoint,
    }
    assertSupervisorSnapshot(this.state)
  }

  /** Restore from replicated checkpoints without choosing a divergent host. */
  restoreCheckpoints(checkpoints: readonly SupervisorCheckpoint[], now = Date.now()): SupervisorCheckpointMerge {
    const merged = mergeSupervisorCheckpoints(checkpoints)
    if (merged.status === "accepted") this.restoreCheckpoint(merged.checkpoint, now)
    return merged
  }

  /** Mark a successfully committed projection as the last known checkpoint. */
  rememberCheckpoint(savedAt = Date.now()): SupervisorCheckpoint {
    const checkpoint = checkpointProjection(this.state, savedAt)
    assertSupervisorCheckpoint(checkpoint)
    const storedCheckpoint = cloneCheckpoint(checkpoint)
    this.state = { ...this.state, lastKnown: storedCheckpoint }
    assertSupervisorSnapshot(this.state)
    return cloneCheckpoint(storedCheckpoint)
  }

  /** Start a new desired generation, invalidating all older callbacks. */
  requestConnect(now = Date.now()): SupervisorDecision {
    if (this.state.phase === "draining") {
      return {
        allowed: false,
        generation: this.state.desiredGeneration,
        retryAt: this.state.drainDeadline,
        reason: "draining",
      }
    }
    if (this.state.phase === "closed") {
      return { allowed: false, generation: this.state.desiredGeneration, retryAt: null, reason: "closed" }
    }
    if (this.state.phase === "backoff") {
      const retryAt = this.state.nextRetryAt
      if (retryAt !== null && now < retryAt)
        return { allowed: false, generation: this.state.desiredGeneration, retryAt, reason: "backoff" }
    }
    if (this.state.phase === "circuit_open") {
      const retryAt = this.state.nextRetryAt
      if (retryAt !== null && now < retryAt)
        return { allowed: false, generation: this.state.desiredGeneration, retryAt, reason: "circuit_open" }
      this.state = {
        ...this.state,
        phase: "connecting",
        health: "unknown",
        nextRetryAt: null,
        circuitOpenedAt: null,
        desiredGeneration: this.state.desiredGeneration + 1,
        safeMessage: safeMessageFor("connecting", "unknown", null),
      }
      assertSupervisorSnapshot(this.state)
      return { allowed: true, generation: this.state.desiredGeneration }
    }
    this.state = {
      ...this.state,
      phase: "connecting",
      health: "unknown",
      nextRetryAt: null,
      drainDeadline: null,
      desiredGeneration: this.state.desiredGeneration + 1,
      safeMessage: safeMessageFor("connecting", "unknown", null),
    }
    assertSupervisorSnapshot(this.state)
    return { allowed: true, generation: this.state.desiredGeneration }
  }

  /** Whether an automatic retry may be attempted at this instant. */
  canAttempt(now = Date.now()): boolean {
    if (this.state.phase === "backoff" || this.state.phase === "circuit_open")
      return this.state.nextRetryAt !== null && now >= this.state.nextRetryAt
    return this.state.phase === "idle"
  }

  /** Accept only the current desired generation; stale clients can never win. */
  markReady(generation: number, now = Date.now()): SupervisorTransition {
    if (generation !== this.state.desiredGeneration) return { kind: "stale", generation }
    this.state = {
      ...this.state,
      phase: "ready",
      health: "healthy",
      observedGeneration: generation,
      failureCount: 0,
      nextRetryAt: null,
      circuitOpenedAt: null,
      drainDeadline: null,
      lastFailure: null,
      safeMessage: safeMessageFor("ready", "healthy", null),
    }
    void now
    assertSupervisorSnapshot(this.state)
    return { kind: "ready", generation }
  }

  markHealthSuccess(generation: number, _now = Date.now()): SupervisorTransition {
    if (generation !== this.state.observedGeneration || this.state.phase !== "ready")
      return { kind: "stale", generation }
    this.state = {
      ...this.state,
      health: "healthy",
      lastFailure: null,
      safeMessage: safeMessageFor("ready", "healthy", null),
    }
    assertSupervisorSnapshot(this.state)
    return { kind: "health", generation, healthy: true }
  }

  markFailure(generation: number, error?: unknown, now = Date.now()): SupervisorTransition {
    // A failure is allowed to mutate the state only for the currently desired
    // generation. In particular, an old client's late `onclose` must not
    // poison a newer connecting generation even while observedGeneration
    // still points at that old client.
    if (generation !== this.state.desiredGeneration) return { kind: "stale", generation }
    const failureCount = this.state.failureCount + 1
    const lastFailure = failureKind(error)
    if (failureCount >= this.config.failureThreshold) {
      const nextRetryAt = now + this.config.cooldownMs
      this.state = {
        ...this.state,
        phase: "circuit_open",
        health: "unhealthy",
        failureCount,
        nextRetryAt,
        circuitOpenedAt: now,
        drainDeadline: null,
        lastFailure,
        safeMessage: safeMessageFor("circuit_open", "unhealthy", nextRetryAt),
      }
    } else {
      const exponential = Math.min(this.config.maxDelayMs, this.config.baseDelayMs * 2 ** (failureCount - 1))
      const random = Math.min(1, Math.max(0, this.random()))
      const jittered = Math.round(exponential * (1 + (random * 2 - 1) * this.config.jitterRatio))
      const delay = Math.min(this.config.maxDelayMs, Math.max(1, jittered))
      const nextRetryAt = now + delay
      this.state = {
        ...this.state,
        phase: "backoff",
        health: "unhealthy",
        failureCount,
        nextRetryAt,
        circuitOpenedAt: null,
        drainDeadline: null,
        lastFailure,
        safeMessage: safeMessageFor("backoff", "unhealthy", nextRetryAt),
      }
    }
    assertSupervisorSnapshot(this.state)
    return { kind: "health", generation, healthy: false }
  }

  /** Invalidate the active client while allowing a replacement generation. */
  beginDrain(now = Date.now()): number {
    const generation = this.state.desiredGeneration + 1
    const drainDeadline = now + this.config.drainTimeoutMs
    this.state = {
      ...this.state,
      desiredGeneration: generation,
      phase: "draining",
      health: "unknown",
      drainDeadline,
      nextRetryAt: null,
      circuitOpenedAt: null,
      safeMessage: safeMessageFor("draining", "unknown", null),
    }
    assertSupervisorSnapshot(this.state)
    return generation
  }

  completeDrain(now = Date.now()): boolean {
    if (this.state.phase !== "draining") return false
    if (this.state.drainDeadline !== null && now < this.state.drainDeadline) return false
    this.state = {
      ...this.state,
      phase: "idle",
      health: "unknown",
      observedGeneration: null,
      drainDeadline: null,
      safeMessage: safeMessageFor("idle", "unknown", null),
    }
    assertSupervisorSnapshot(this.state)
    return true
  }

  /** Explicit disconnect/teardown. A later connect must be an intentional call. */
  close(): void {
    this.state = {
      ...this.state,
      desiredGeneration: this.state.desiredGeneration + 1,
      phase: "closed",
      health: "unknown",
      observedGeneration: null,
      nextRetryAt: null,
      circuitOpenedAt: null,
      drainDeadline: null,
      safeMessage: safeMessageFor("closed", "unknown", null),
    }
    assertSupervisorSnapshot(this.state)
  }

  /** Explicit disable returns to idle and clears failure memory. */
  disable(): void {
    this.state = {
      ...this.state,
      desiredGeneration: this.state.desiredGeneration + 1,
      phase: "idle",
      health: "unknown",
      observedGeneration: null,
      failureCount: 0,
      nextRetryAt: null,
      circuitOpenedAt: null,
      drainDeadline: null,
      lastFailure: null,
      safeMessage: safeMessageFor("idle", "unknown", null),
    }
    assertSupervisorSnapshot(this.state)
  }
}

export const supervisorEventData = (snapshot: McpSupervisorSnapshot) => ({
  server: snapshot.server,
  desiredGeneration: snapshot.desiredGeneration,
  observedGeneration: snapshot.observedGeneration,
  phase: snapshot.phase,
  health: snapshot.health,
  failureCount: snapshot.failureCount,
  nextRetryAt: snapshot.nextRetryAt,
  safeMessage: snapshot.safeMessage,
})
