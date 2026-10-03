export * as PluginControl from "./plugin-control"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Context, Effect, Layer, Schema } from "effect"
import * as ActionGateway from "./action-gateway"
import * as ControlClaimIndex from "./runtime/control-claim-index"
import { DurableRun } from "./runtime/durable-run"
import { makeLocationNode } from "./effect/app-node"

export class InvalidPluginControlError extends Schema.TaggedErrorClass<InvalidPluginControlError>()(
  "PluginControl.InvalidPluginControlError",
  { reason: Schema.String },
) {}

export class PluginControlTerminalError extends Schema.TaggedErrorClass<PluginControlTerminalError>()(
  "PluginControl.PluginControlTerminalError",
  { runID: AgentRuntime.RunID, status: AgentRuntime.RunStatus, reason: Schema.String },
) {}

export type Principal = ControlClaimIndex.Principal

export type ExecuteInput<A> = {
  /** Server-derived subject. Renderer input must never be copied here directly. */
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly principal: Principal
  readonly action: string
  readonly operation: string
  readonly payload: unknown
  readonly input: unknown
  readonly claimMaterial?: {
    readonly input: unknown
    readonly payload: unknown
  }
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly authorization: ActionGateway.AuthorizationPlan
  readonly reasonSummary: string
  readonly traceID: string
  readonly mutate: () => Effect.Effect<A, unknown>
  /** Safe, read-only reconstruction after a completed or interrupted mutation. */
  readonly replay: () => Effect.Effect<A, unknown>
  readonly durableResult: {
    readonly encode: (value: A) => unknown
    readonly decode: (value: unknown) => A
  }
}

export interface Interface {
  readonly execute: <A>(input: ExecuteInput<A>) => Effect.Effect<A, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PluginControl") {}

const CONTROL_LEASE_TTL_MS = 30_000
const CONTROL_MAX_DURATION_MS = 15 * 60_000

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: CONTROL_MAX_DURATION_MS,
  maxCostMicros: 1,
  maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const controlRunInput = <A>(input: ExecuteInput<A>): ControlClaimIndex.ClaimInput => ({
  subject: input.subject,
  gateway: {
    kind: "control-plane",
    name: input.action,
    resources: [...input.resources],
    semantics: input.semantics,
    reasonSummary: input.reasonSummary,
    initiator: "user",
    traceID: input.traceID,
  },
  authorization: input.authorization,
  input: input.input,
  operation: { kind: input.operation, payload: input.payload },
  ...(input.claimMaterial ? { claimMaterial: input.claimMaterial } : {}),
  run: {
    initiator: "user",
    authority: "human",
    riskTier: "L3",
    reasonSummary: input.reasonSummary,
    budget,
    traceID: input.traceID,
    visibility: "audit",
  },
})

const actionInput = <A>(
  input: ExecuteInput<A>,
  snapshot: DurableRun.ControlSnapshot,
  lease: DurableRun.RunLeaseCapability,
) => ({
  kind: "control-plane" as const,
  controlPlane: snapshot.run.subject,
  actionID: snapshot.run.operation.actionID,
  runID: snapshot.run.id,
  name: input.action,
  resources: [...snapshot.run.operation.resources],
  semantics: snapshot.run.operation.semantics,
  reasonSummary: snapshot.run.reasonSummary,
  initiator: snapshot.run.initiator,
  traceID: snapshot.run.traceID,
  inputDigest: snapshot.run.operation.inputDigest,
  runLease: lease,
})

const transitionAfterAction = (input: {
  readonly runs: DurableRun.Interface
  readonly lease: DurableRun.RunLeaseCapability
  readonly runID: AgentRuntime.RunID
  readonly status: AgentRuntime.RunStatus
}) =>
  Effect.gen(function* () {
    let current = input.status
    if (current === "awaiting_authorization") {
      yield* input.runs.transitionControl(input.lease, {
        runID: input.runID,
        to: "queued",
        reason: "Plugin management action was authorized and queued",
      })
      current = "queued"
    }
    if (current === "queued" || current === "recovering") {
      yield* input.runs.transitionControl(input.lease, {
        runID: input.runID,
        to: "running",
        reason: "Plugin management action executing through ActionGateway",
      })
      current = "running"
    }
    if (current === "running") {
      yield* input.runs.transitionControl(input.lease, {
        runID: input.runID,
        to: "verifying",
        reason: "Plugin management result is being verified",
      })
      current = "verifying"
    }
    if (current === "verifying") {
      yield* input.runs.transitionControl(input.lease, {
        runID: input.runID,
        to: "completed",
        reason: "Plugin management action committed and verified",
      })
    }
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const claims = yield* ControlClaimIndex.Service
    const gateway = yield* ActionGateway.Service
    const runs = yield* DurableRun.Service

    const execute = Effect.fn("PluginControl.execute")(function* <A>(input: ExecuteInput<A>) {
      if (input.subject.type !== "control-plane")
        return yield* new InvalidPluginControlError({ reason: "Plugin management requires a control-plane subject." })
      if (input.semantics.riskTier !== "L3" || input.semantics.authority !== "human")
        return yield* new InvalidPluginControlError({
          reason: "Plugin management actions require fresh L3 human approval.",
        })
      if (input.authorization.requests.length === 0)
        return yield* new InvalidPluginControlError({
          reason: "Plugin management actions require a bounded authorization plan.",
        })

      const claimed = yield* claims
        .claim(controlRunInput(input))
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, input.principal))
      const claimedRun = claimed.snapshot.run
      if (claimedRun.status === "completed") return yield* input.replay()
      if (["failed", "cancelled", "paused"].includes(claimedRun.status))
        return yield* new PluginControlTerminalError({
          runID: claimedRun.id,
          status: claimedRun.status,
          reason: "The durable plugin management run is not retryable from its current state.",
        })

      const leased = yield* runs.acquireControlLease({
        runID: claimedRun.id,
        ownerID: `plugin-control:${input.principal.tenantID}:${input.principal.userID}`,
        ttlMs: CONTROL_LEASE_TTL_MS,
      })
      return yield* Effect.gen(function* () {
        let current = leased.snapshot
        if (current.run.status === "draft") {
          current = yield* runs.transitionControl(leased.capability, {
            runID: current.run.id,
            to: "preflight",
            reason: "Plugin management action entered durable preflight",
          })
          current = yield* runs.transitionControl(leased.capability, {
            runID: current.run.id,
            to: "awaiting_authorization",
            reason: "Plugin management action awaits fresh human approval",
          })
        }
        if (current.run.status === "running" || current.run.status === "verifying") {
          const replayed = yield* input.replay()
          yield* transitionAfterAction({
            runs,
            lease: leased.capability,
            runID: current.run.id,
            status: current.run.status,
          })
          return replayed
        }
        if (!["awaiting_authorization", "queued", "recovering"].includes(current.run.status))
          return yield* new PluginControlTerminalError({
            runID: current.run.id,
            status: current.run.status,
            reason: "The durable plugin management run cannot enter execution from its current state.",
          })

        const result = yield* gateway.execute(actionInput(input, current, leased.capability), {
          authorization: input.authorization,
          execute: () => input.mutate(),
          successSummary: () => `Plugin management action ${input.operation} committed`,
          durableResult: input.durableResult,
        })
        yield* transitionAfterAction({
          runs,
          lease: leased.capability,
          runID: current.run.id,
          status: current.run.status,
        })
        return result
      }).pipe(
        Effect.ensuring(
          runs
            .releaseControlLease(leased.capability, {
              runID: claimedRun.id,
              reason: "Plugin management worker finished",
            })
            .pipe(Effect.ignore),
        ),
      )
    })

    return Service.of({ execute })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ControlClaimIndex.node, ActionGateway.node, DurableRun.node],
})
