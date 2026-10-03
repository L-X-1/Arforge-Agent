import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { ControlClaimIndex } from "@arforge-ai/core/runtime"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpControlSubject } from "@/control-plane/http-control-subject"
import { InstanceState } from "@/effect/instance-state"
import type { MCP } from "./index"

/**
 * Read-only MCP catalogue operations still cross an external transport. This
 * adapter gives HTTP/CLI the same control-plane Action/Gateway identity as
 * other non-session operations without teaching those surfaces a second
 * permission or persistence owner.
 */
export type Input = {
  readonly mcp: Pick<MCP.Interface, "status" | "health" | "declaredScope" | "catalog">
  readonly principal: ControlPrincipal.Principal
  readonly requestID: AgentRuntime.ControlPlaneRequestID
}

const ACTION = "mcp.catalog.read"
const RESOURCE = "mcp:catalog"
const CONTROL_LEASE_TTL_MS = 120_000
const CONTROL_MAX_DURATION_MS = 60_000

const semantics = (input: {
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly externalServices: ReadonlyArray<string>
}) =>
  AgentRuntime.EffectSemantics.make({
    riskTier: "L1",
    authority: "automatic",
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "not_applicable",
    filesystemScope: [],
    networkScope: [...input.networkScope],
    secretScope: [...input.secretScope],
    externalServices: [...input.externalServices],
    expectedArtifacts: [],
    successCriteria: ["MCP catalog returned one generation-fenced snapshot"],
  })

const uniqueSorted = (values: ReadonlyArray<string>) => [...new Set(values.filter(Boolean))].sort()

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: CONTROL_MAX_DURATION_MS,
  // DurableRun treats a zero ceiling as already exhausted. Catalog reads do
  // not accrue model cost, so one positive sentinel keeps the single attempt
  // admissible without creating a spend allowance.
  maxCostMicros: 1,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

type CatalogScope = {
  readonly server: string
  readonly generation: number | null
  readonly endpoint: string
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly externalServices: ReadonlyArray<string>
}

const scopeMaterial = (scopes: ReadonlyArray<CatalogScope>, requestID: AgentRuntime.ControlPlaneRequestID) => ({
  version: 1,
  operation: ACTION,
  /** Every invocation has a distinct immutable control claim and receipt. */
  requestID,
  servers: scopes.map((scope) => ({
    server: scope.server,
    generation: scope.generation,
    endpoint: scope.endpoint,
    networkScope: scope.networkScope,
    secretScope: scope.secretScope,
    externalServices: scope.externalServices,
  })),
})

const sameScopes = (left: ReadonlyArray<CatalogScope>, right: ReadonlyArray<CatalogScope>) =>
  JSON.stringify(left) === JSON.stringify(right)

const controlFailureReason = (error: unknown) => {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { readonly reason?: unknown }).reason
    if (typeof reason === "string" && reason.length > 0) return reason.slice(0, 2_000)
  }
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 2_000)
  return "MCP catalog control action failed"
}

/**
 * Execute one fresh user-facing catalogue read through the existing durable
 * control Action Gateway. A new request ID is intentionally supplied by each
 * HTTP/CLI invocation; the Action remains durably inspectable, while a later
 * invocation does not silently replay a stale catalogue after tools/list
 * notifications on the same MCP generation.
 */
export const catalog = Effect.fn("MCP.controlCatalog")(function* (input: Input) {
  const instance = yield* InstanceState.context
  const locations = yield* LocationServiceMap.Service
  const locationLayer = Layer.unwrap(
    Effect.succeed(locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))),
  )
  const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, locationLayer)
  const status = yield* inLocation(input.mcp.status())
  const health = yield* inLocation(input.mcp.health())
  const servers = Object.entries(status)
    .filter(([, value]) => value.status === "connected")
    .map(([name]) => name)
    .toSorted((left, right) => left.localeCompare(right))

  const scopes: CatalogScope[] = []
  for (const server of servers) {
    const declared = yield* inLocation(input.mcp.declaredScope(server))
    if (!declared)
      return yield* Effect.fail(
        new Error(`MCP catalog control scope resolution failed for ${server}: no protected transport scope`),
      )
    const snapshot = health[server]
    scopes.push({
      server,
      generation: snapshot?.observedGeneration ?? null,
      endpoint: declared.endpoint,
      networkScope: uniqueSorted(declared.networkScope),
      secretScope: uniqueSorted(declared.secretScope),
      externalServices: uniqueSorted(declared.externalServices),
    })
  }

  const networkScope = uniqueSorted(scopes.flatMap((scope) => scope.networkScope))
  const secretScope = uniqueSorted(scopes.flatMap((scope) => scope.secretScope))
  const externalServices = uniqueSorted(scopes.flatMap((scope) => [scope.server, ...scope.externalServices]))
  const resources = uniqueSorted([
    RESOURCE,
    ...scopes.flatMap((scope) => [
      `mcp:server:${scope.server}`,
      `transport:${scope.endpoint}`,
      ...scope.networkScope,
      ...scope.secretScope,
      ...scope.externalServices,
    ]),
  ])
  const material = scopeMaterial(scopes, input.requestID)
  const inputDigest = canonicalHash(material)
  if (!inputDigest)
    return yield* Effect.fail(new Error("MCP catalog control input could not be canonically identified"))

  const subject = HttpControlSubject.make({
    directory: instance.directory,
    projectID: instance.project.id,
    action: ACTION,
    requestID: input.requestID,
    principal: input.principal,
  })
  const actionID = ActionGateway.stableControlPlaneActionID({
    subject,
    name: ACTION,
    resources,
    inputDigest,
    policyVersion: ActionGateway.POLICY_VERSION,
  })
  const authorization = ActionGateway.canonicalPlan({
    requests: [{ action: ACTION, resources }],
    metadata: {
      source: "mcp-control-gateway",
      operation: ACTION,
      servers,
      generations: scopes.map((scope) => ({ server: scope.server, generation: scope.generation })),
    },
  })
  const gatewayBase = {
    kind: "control-plane" as const,
    controlPlane: subject,
    name: ACTION,
    resources,
    semantics: semantics({ networkScope, secretScope, externalServices }),
    reasonSummary: "读取 MCP generation-scoped catalog",
    initiator: "user" as const,
    traceID: `control:${subject.id}:${subject.requestID}`,
  }

  // ActionGateway deliberately requires every automatic control projection
  // to be attached to a durable ControlRun. Claim and execute a short-lived
  // one-shot run here instead of weakening that invariant or creating a
  // second permission owner for HTTP/CLI catalogue reads.
  const claims = yield* inLocation(ControlClaimIndex.Service)
  const claimed = yield* inLocation(
    claims
      .claim({
        subject,
        gateway: gatewayBase,
        authorization,
        input: material,
        operation: { kind: ACTION, payload: material },
        claimMaterial: { input: material, payload: material },
        run: {
          initiator: "user",
          authority: "automatic",
          riskTier: "L1",
          reasonSummary: gatewayBase.reasonSummary,
          budget,
          traceID: gatewayBase.traceID,
          visibility: "details",
        },
      })
      .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, input.principal)),
  )

  const durable = yield* inLocation(DurableRun.Service)
  const runID = claimed.snapshot.run.id
  const ownerID = `mcp-catalog:${input.requestID}`
  const leased = yield* durable.acquireControlLease({ runID, ownerID, ttlMs: CONTROL_LEASE_TTL_MS })
  const capability = leased.capability
  let runSettled = false
  let leaseReleased = false
  const releaseLease = (reason: string) =>
    Effect.suspend(() => {
      if (leaseReleased) return Effect.void
      leaseReleased = true
      return durable.releaseControlLease(capability, { runID, reason }).pipe(Effect.ignore)
    })
  const failRun = (reason: string) =>
    Effect.gen(function* () {
      const current = yield* durable.validateControlLease(capability).pipe(Effect.exit)
      if (Exit.isFailure(current)) {
        runSettled = true
        return
      }
      if (current.value.run.status === "running" && current.value.activeAttempt) {
        yield* durable
          .finishControlAttempt(capability, {
            runID,
            attempt: current.value.activeAttempt.attempt,
            outcome: "failed",
            durationMs: 0,
            costMicros: 0,
            tokens: 0,
          })
          .pipe(Effect.ignore)
      }
      const after = yield* durable.validateControlLease(capability).pipe(Effect.exit)
      if (Exit.isSuccess(after)) {
        // A claim starts in draft, which intentionally cannot jump directly
        // to failed. Best-effort preflight first, then converge every other
        // non-terminal state to failed. The lease is still released below if
        // the durable store itself is unavailable.
        if (after.value.run.status === "draft") {
          yield* durable
            .transitionControl(capability, { runID, to: "preflight", reason: "MCP catalog control cleanup" })
            .pipe(Effect.ignore)
        }
        const latest = yield* durable.validateControlLease(capability).pipe(Effect.exit)
        if (Exit.isSuccess(latest) && !["completed", "failed", "cancelled"].includes(latest.value.run.status)) {
          yield* durable.transitionControl(capability, { runID, to: "failed", reason }).pipe(Effect.ignore)
        }
      }
      runSettled = true
    })

  const run = Effect.gen(function* () {
    yield* durable.transitionControl(capability, { runID, to: "preflight", reason: "MCP catalog control preflight" })
    yield* durable.transitionControl(capability, { runID, to: "queued", reason: "MCP catalog queued" })
    yield* durable.transitionControl(capability, { runID, to: "running", reason: "MCP catalog started" })
    const started = yield* durable.beginControlAttempt(capability, { runID })
    const attempt = started.activeAttempt?.attempt
    if (attempt === undefined)
      return yield* Effect.fail(new Error("MCP catalog control run did not record an execution attempt"))

    const gateway = yield* inLocation(ActionGateway.Service)
    const action: ActionGateway.Input = {
      ...gatewayBase,
      actionID,
      inputDigest,
      runID,
      runLease: capability,
      // The run has entered its execution phase before this synchronous helper
      // invokes the gateway. This flag is the existing recovery handoff, not a
      // caller-controlled bypass: the opaque lease and frozen run binding are
      // still checked by ActionGateway before the MCP transport is touched.
      allowControlRecovery: true,
    }
    const executed = yield* Effect.exit(
      gateway.execute(action, {
        authorization,
        execute: () =>
          Effect.gen(function* () {
            const snapshot = yield* inLocation(input.mcp.catalog())
            const postStatus = yield* inLocation(input.mcp.status())
            const postServers = Object.entries(postStatus)
              .filter(([, value]) => value.status === "connected")
              .map(([name]) => name)
              .toSorted((left, right) => left.localeCompare(right))
            if (JSON.stringify(postServers) !== JSON.stringify(servers))
              return yield* Effect.fail(new Error("MCP catalog scope changed while the control action was running"))
            const postScopes: CatalogScope[] = []
            for (const server of postServers) {
              const declared = yield* inLocation(input.mcp.declaredScope(server))
              const healthSnapshot = (yield* inLocation(input.mcp.health()))[server]
              if (!declared) return yield* Effect.fail(new Error(`MCP catalog scope disappeared for ${server}`))
              postScopes.push({
                server,
                generation: healthSnapshot?.observedGeneration ?? null,
                endpoint: declared.endpoint,
                networkScope: uniqueSorted(declared.networkScope),
                secretScope: uniqueSorted(declared.secretScope),
                externalServices: uniqueSorted(declared.externalServices),
              })
            }
            if (!sameScopes(scopes, postScopes))
              return yield* Effect.fail(
                new Error("MCP catalog transport scope changed while the control action was running"),
              )
            return snapshot
          }),
        durableResult: {
          encode: (value) => value,
          decode: (value) => value as MCP.CatalogSnapshot,
        },
        successSummary: (snapshot) => `MCP catalog returned ${snapshot.capabilities.length} capabilities`,
      }),
    )

    const outcome = Exit.isSuccess(executed) ? "completed" : "failed"
    yield* durable.finishControlAttempt(capability, {
      runID,
      attempt,
      outcome,
      durationMs: 0,
      costMicros: 0,
      tokens: 0,
    })
    yield* durable.transitionControl(capability, {
      runID,
      to: outcome === "completed" ? "completed" : "failed",
      reason: outcome === "completed" ? "MCP catalog settled" : "MCP catalog failed",
    })
    runSettled = true

    if (Exit.isFailure(executed)) return yield* Effect.failCause(executed.cause)
    return executed.value
  }).pipe(
    Effect.catchCause((cause) =>
      failRun(controlFailureReason(Cause.squash(cause))).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        if (!runSettled) yield* failRun("MCP catalog control action aborted before settlement")
        yield* releaseLease("MCP catalog control finished")
      }),
    ),
  )

  return yield* run
})

export * as McpControlGateway from "./control-gateway"
