export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@arforge-ai/llm"
import { ActionGateway } from "../action-gateway"
import { Context, Effect, Layer, Ref, Schema, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import {
  Tool,
  definition,
  effects,
  Failure as ToolFailure,
  permission,
  settle,
  validateName,
  RegistrationError,
  decodeInput,
  effectDeclaration,
  executionMetadata,
  resolveExecutionMetadata,
  hasPostprocessing,
  postprocess,
  type AnyTool,
} from "./tool"
import { ToolMetadataError } from "./metadata"
import { run as runToolPipeline, ToolPipelineError } from "./pipeline"
import { make as makeToolScheduler } from "./scheduler"
import { BuiltInToolManifest, makeToolManifest, type ToolCatalogEntry, type ToolManifest } from "./effect-catalog"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { DeferredTools } from "./deferred"
import { RuntimeInsight } from "../runtime/insight"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { LocationMutation } from "../location-mutation"
import {
  scopedEgress,
  scopedPermission,
  staticPlanRequests,
  isReservedBuiltInName,
  type PlanRequest,
} from "./authorization-plan"
import { canonicalHash } from "../util/canonical-hash"
import { Egress } from "../egress"
import * as RuntimeInvariants from "../runtime/invariants"
import { StructuredOutput } from "./structured-output"
import { TurnToolCarrier } from "./turn-carrier"

export type MaterializeOptions = {
  /** Include ordinary registered tools. False is used at the agent step limit. */
  readonly includeRegistered?: boolean
  /** Canonical untrusted tools for this Session request only; never mutate Location registrations. */
  readonly externalTools?: Readonly<Record<string, AnyTool>>
  /** Turn-local schema; it is compiled into the same canonical registry snapshot. */
  readonly structuredOutput?: Readonly<Record<string, unknown>>
  /** Canonical Core tool for deterministic scheduled-task execution. */
  readonly scheduledTaskTool?: AnyTool
  /** Same task implementation, but normal run-bound model-call identity. */
  readonly modelTaskTool?: AnyTool
  /** Fixed-name compatibility carrier for one user-attached file read. */
  readonly userAttachmentRead?: TurnToolCarrier.UserAttachmentRead
  /** Audited mature desktop definitions for one legacy provider turn. */
  readonly legacySessionTools?: TurnToolCarrier.LegacySessionTools
}

export type ExecuteInput = {
  /** Per-invocation handoff; this is not a registry or persistent result owner. */
  readonly interruptedOutput?: Ref.Ref<ToolOutputStore.BoundResult | undefined>
  readonly runID?: AgentRuntime.RunID
  readonly stepID?: AgentRuntime.StepID
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    sessionID?: SessionSchema.ID,
    options?: MaterializeOptions,
  ) => Effect.Effect<
    Materialization,
    StructuredOutput.InvalidSchemaError | TurnToolCarrier.InvalidCarrierError | RegistrationError
  >
  readonly discover: (input: {
    readonly sessionID: SessionSchema.ID
    readonly query: string
    readonly limit: number
  }) => Effect.Effect<
    {
      readonly tools: ReadonlyArray<{
        readonly name: string
        readonly description: string
        readonly inputSchema: Readonly<Record<string, unknown>>
        readonly outputSchema?: Readonly<Record<string, unknown>>
      }>
      readonly activated: ReadonlyArray<string>
    },
    DiscoverError
  >
  /** Read-only effect declaration inventory used by the generated audit. */
  readonly catalog: () => Effect.Effect<ReadonlyArray<ToolCatalogEntry>>
  /**
   * External registration. Untrusted callers can only obtain this API: it
   * rejects reserved built-in names and any name with an active trusted
   * built-in registration, so startup order or tool name can never hijack a
   * built-in.
   */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
  /**
   * Waits for every scheduler-admitted tool execution in this Location to
   * release. Older callers may omit this optional seam; the canonical
   * registry always supplies it.
   */
  readonly quiesce?: (timeoutMs?: number) => Effect.Effect<import("./scheduler").Quiescence, never>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  /** Storage-safe managed receipts; outputPaths is compatibility-only. */
  readonly artifactRefs?: ReadonlyArray<AgentRuntime.OpaqueArtifactRef>
  readonly outputPaths?: ReadonlyArray<string>
}

type PipelinePending = { readonly output: ToolOutput } | Settlement

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ToolRegistry") {}

/**
 * Module-private registry bundle: the public registry projection plus the
 * trusted built-in registration path. Never exported — the tag and its shape
 * are invisible outside this module. `ToolRegistry.Service` projects only
 * the public operations and external `register`; the trusted register is
 * reachable only through the `Tools.BuiltIns` projection installed by
 * `builtInsNode` into explicitly wired core built-in nodes. This protects
 * normal untrusted registration paths and runtime composition wiring; it is
 * not process isolation against arbitrary hostile in-process code that
 * imports and composes `builtInsNode` itself.
 */
type Bundle = {
  readonly register: Interface["register"]
  readonly trustedRegister: (
    tools: Readonly<Record<string, AnyTool>>,
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
  readonly materialize: Interface["materialize"]
  readonly discover: Interface["discover"]
  readonly catalog: Interface["catalog"]
}
class BundleTag extends Context.Service<BundleTag, Bundle>()("@arforge/v2/ToolRegistry.Bundle") {}

export class DiscoverError extends Schema.TaggedErrorClass<DiscoverError>()("ToolRegistry.DiscoverError", {
  message: Schema.String,
}) {}

const registryLayer = Layer.effect(
  BundleTag,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const deferred = yield* DeferredTools.Service
    const gateway = yield* ActionGateway.Service
    const invariants = yield* RuntimeInvariants.Service
    // A registry lifetime owns one bounded lane shared by every registered
    // source. Old tools default to `exclusive`, while an explicit safe/keyed
    // declaration opts into bounded parallelism after metadata resolution.
    const scheduler = makeToolScheduler()
    const permissions = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service
    type Registration = {
      readonly identity: object
      readonly tool: AnyTool
      readonly trusted: boolean
      readonly coordinatesChildren?: boolean
      readonly carrier?: "structured-output" | "scheduled-task" | "user-attachment-read" | "legacy-session-tool"
      readonly authorization?: TurnToolCarrier.LegacySessionAuthorizationResolver
    }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()
    // Runtime-issued, closure-owned built-in provenance: minted per registry
    // instance and validated by WeakSet membership. The mint and the token
    // never appear in any export; the BuiltIns service is the only carrier.
    const builtInCapability: object = {}
    const trustedCapabilities = new WeakSet<object>()
    trustedCapabilities.add(builtInCapability)

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised?: object,
      transient?: Registration,
    ) {
      const registration =
        transient ?? local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      // Trusted scope derivation is bound to provenance, never the tool name:
      // only registry-owned built-in registrations carry the trusted flag.
      const trusted = "trusted" in registration && registration.trusted === true
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      RuntimeInsight.auditRecord({
        actor: "agent",
        action: "tool.execute.start",
        resource: input.call.name,
        metadata: {
          sessionID: input.sessionID,
          agent: input.agent,
          assistantMessageID: input.assistantMessageID,
          toolCallID: input.call.id,
        },
      })
      const context: Tool.Context = {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        // Fail-closed default: a tool body that runs without a
        // gateway-authenticated capability is denied before any side effect.
        permission: {
          assert: () =>
            Effect.fail(
              new Tool.ToolAuthorizationFailure(
                "",
                [],
                "No gateway authorization capability is bound to this tool call",
                [],
              ),
            ),
        },
        egress: Egress.deny(),
      }
      const semanticsResult = yield* effects(registration.tool, input.call).pipe(
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            message: error instanceof ToolFailure ? error.message : String(error),
          }),
          onSuccess: (semantics) => ({ ok: true as const, semantics }),
        }),
      )
      if (!semanticsResult.ok) {
        // Invalid input returns a tool error before any permission request or
        // action execution; it is never reinterpreted as an undeclared L3.
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: "invalid input",
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return { result: { type: "error" as const, value: semanticsResult.message } }
      }
      const effectiveSemantics = semanticsResult.semantics
      // Canonical hash of the complete decoded input; the gateway binds it
      // into the durable intent fingerprint so changed content for the same
      // action identity fails closed. Non-canonicalizable inputs fail closed
      // before any permission request or attempt.
      const decodedResult = yield* decodeInput(registration.tool, input.call).pipe(
        Effect.match({
          onFailure: (error) => ({
            ok: false as const,
            message: error instanceof ToolFailure ? error.message : String(error),
          }),
          onSuccess: (decoded) => ({ ok: true as const, decoded }),
        }),
      )
      if (!decodedResult.ok) {
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: "invalid input",
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return { result: { type: "error" as const, value: decodedResult.message } }
      }
      const inputDigest = canonicalHash(decodedResult.decoded)
      if (!inputDigest) {
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: "non-canonicalizable input",
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return {
          result: {
            type: "error" as const,
            value: `Preflight blocked: the tool input is not canonically hashable and cannot be executed`,
          },
        }
      }
      // Scheduled subtasks existed before run-bound Action IDs. Their durable
      // proposal is session/message/call-bound, while runID remains part of
      // the intent and child lineage. Both the Core-native tool and the
      // legacy carrier preserve that exact identity so an upgrade cannot mint
      // a duplicate child action for already scheduled work.
      const scheduledTaskRegistration = "carrier" in registration && registration.carrier === "scheduled-task"
      const actionID = ActionGateway.stableActionID({
        ...context,
        ...(input.runID && !scheduledTaskRegistration ? { runID: input.runID } : {}),
      })
      const permissionAction = permission(registration.tool, input.call.name)
      const staticOutcome = yield* staticPlanRequests({
        toolName: input.call.name,
        permissionAction,
        semantics: effectiveSemantics,
        rawInput: (input.call.input ?? {}) as Readonly<Record<string, unknown>>,
        trusted,
        resolve: (target, kind) =>
          mutation.resolve({ path: target, kind }).pipe(
            Effect.map((resolved) => ({
              resource: resolved.resource,
              ...(resolved.externalDirectory ? { external: resolved.externalDirectory.resource } : {}),
            })),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
      })
      const legacyAuthorizationResolver =
        "authorization" in registration && typeof registration.authorization === "function"
          ? (registration.authorization as TurnToolCarrier.LegacySessionAuthorizationResolver)
          : undefined
      const legacyAuthorization = legacyAuthorizationResolver
        ? yield* legacyAuthorizationResolver({
            name: input.call.name,
            input: (input.call.input ?? {}) as Readonly<Record<string, unknown>>,
            semantics: effectiveSemantics,
          })
        : undefined
      if (!legacyAuthorization && staticOutcome.kind === "blocked") {
        // A known leaf tool whose scope cannot be derived statically is
        // blocked before any PermissionV2 request or execution attempt.
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: staticOutcome.reason,
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return { result: { type: "error" as const, value: `Preflight blocked: ${staticOutcome.reason}` } }
      }
      const isScopedOrHuman = effectiveSemantics.riskTier === "L2" || effectiveSemantics.riskTier === "L3"
      // A fallback is an unknown third-party route only when its provenance
      // is untrusted. The finite legacy-session allowlist is trusted by its
      // opaque carrier and supplies its exact mature authorization plan; it
      // must retain the built-in L2/L3 semantics during migration instead of
      // being mislabeled as a fresh external L3 tool.
      const isUnknownTool = staticOutcome.kind === "fallback" && !trusted
      const requests: ReadonlyArray<PlanRequest> = legacyAuthorization
        ? legacyAuthorization.requests
        : staticOutcome.kind === "requests"
          ? staticOutcome.requests
          : // Separate fail-closed policy for unknown third-party tools: an
            // explicit L3 wildcard grant, never mixed into known tool scopes.
            [{ action: permissionAction, resources: ["*"] }]
      // A known automatic tool that resolves an external_directory request is
      // not automatic authorized data: it is elevated to L2 scoped
      // authorization with both exact requests so the user approves the
      // external boundary. external_directory is never carried as an
      // automatic (L0/L1) scope.
      const elevateToScoped =
        !isUnknownTool &&
        !isScopedOrHuman &&
        staticOutcome.kind === "requests" &&
        requests.some((request) => request.action === "external_directory")
      // An unknown third-party tool is forced to conservative fresh L3 human
      // approval regardless of the tier it declares, so a self-declared
      // L0/L1 or L2 claim can never escape the fail-closed fallback policy,
      // and a crash can never replay a claimed "safe" third-party effect.
      // Declared scopes remain audit metadata only.
      const finalSemantics = isUnknownTool
        ? AgentRuntime.EffectSemantics.make({
            ...effectiveSemantics,
            riskTier: "L3",
            authority: "human",
            idempotency: "non_idempotent",
            retryability: "never",
            reversibility: "irreversible",
          })
        : elevateToScoped
          ? AgentRuntime.EffectSemantics.make({
              ...effectiveSemantics,
              riskTier: "L2",
              authority: "scoped_grant",
            })
          : effectiveSemantics
      let toolExecutionMetadata: ReturnType<typeof resolveExecutionMetadata>
      try {
        // Resolve once, after schema decoding and final policy elevation, so
        // a dynamic resource key cannot drift between preflight and execute.
        toolExecutionMetadata = resolveExecutionMetadata(
          registration.tool,
          decodedResult.decoded,
          context,
          finalSemantics,
        )
      } catch (error) {
        const reason = error instanceof ToolMetadataError ? error.message : String(error)
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: "invalid execution metadata",
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return { result: { type: "error" as const, value: `Preflight blocked: ${reason}` } }
      }
      if (toolExecutionMetadata.timeoutMode === "detached") {
        RuntimeInsight.auditRecord({
          actor: "agent",
          action: "tool.execute.end",
          resource: input.call.name,
          reason: "unsupported detached timeout mode",
          metadata: { sessionID: input.sessionID, toolCallID: input.call.id, status: "error" },
        })
        return {
          result: {
            type: "error" as const,
            value: "Preflight blocked: detached tool execution is not enabled by the current durable executor",
          },
        }
      }
      const authorization = legacyAuthorization
        ? legacyAuthorization
        : isUnknownTool || elevateToScoped || isScopedOrHuman
          ? {
              requests,
              metadata: scheduledTaskRegistration
                ? {
                    // Compatibility fingerprint for scheduled SubtaskPart
                    // actions created by the mature prompt before this fixed
                    // carrier entered the canonical registry. Authorization
                    // requests remain the same exact subagent scope.
                    source: "action-gateway-preflight",
                    tool: TurnToolCarrier.scheduledTaskName,
                    riskTier: finalSemantics.riskTier,
                  }
                : {
                    riskTier: finalSemantics.riskTier,
                    authority: finalSemantics.authority,
                    filesystemScope: finalSemantics.filesystemScope,
                    networkScope: finalSemantics.networkScope,
                    secretScope: finalSemantics.secretScope,
                    externalServices: finalSemantics.externalServices,
                  },
            }
          : undefined
      const scheduledTaskResources = [
        ...new Set([
          ...finalSemantics.filesystemScope,
          ...finalSemantics.networkScope,
          ...finalSemantics.secretScope,
          ...finalSemantics.externalServices,
        ]),
      ].filter(Boolean)
      const legacySessionCarrier = "carrier" in registration && registration.carrier === "legacy-session-tool"
      const actionResources =
        scheduledTaskRegistration || legacySessionCarrier
          ? scheduledTaskResources.length > 0
            ? scheduledTaskResources
            : [scheduledTaskRegistration ? TurnToolCarrier.scheduledTaskName : input.call.name]
          : [
              ...new Set([
                ...requests.flatMap((request) => request.resources).filter((resource) => resource.length > 0),
                // Resource keys are intent identity material, not a second
                // permission request. The prefix keeps them distinct from host
                // paths and makes the binding visible in ActionGateway history.
                ...(toolExecutionMetadata.resourceKey ? [`tool-resource:${toolExecutionMetadata.resourceKey}`] : []),
              ]),
            ]
      // Known automatic (L0/L1) built-ins carry a trusted noninteractive
      // preflight derived by this registry; the leaf authorizer verifies
      // against it and never invokes PermissionV2 again.
      const automaticRequests = !authorization ? requests : undefined
      const pending = yield* runToolPipeline<
        { readonly name: string; readonly registration: typeof registration },
        { readonly name: string; readonly registration: typeof registration; readonly advertised: boolean },
        {
          readonly name: string
          readonly registration: typeof registration
          readonly advertised: boolean
          readonly semantics: AgentRuntime.EffectSemantics
          readonly metadata: ReturnType<typeof resolveExecutionMetadata>
          readonly authorization: typeof authorization
        },
        {
          readonly name: string
          readonly registration: typeof registration
          readonly advertised: boolean
          readonly semantics: AgentRuntime.EffectSemantics
          readonly metadata: ReturnType<typeof resolveExecutionMetadata>
          readonly authorization: typeof authorization
        },
        PipelinePending,
        Settlement,
        Settlement,
        Settlement,
        ToolOutputStore.Error
      >({
        invariants,
        // These values make the preflight facts explicit to every stage. The
        // actual registration lookup and permission plan still live here in
        // ToolRegistry; the pipeline does not create a second registry.
        resolve: () => Effect.succeed({ name: input.call.name, registration }),
        visibility: (resolved) => Effect.succeed({ ...resolved, advertised: advertised !== undefined }),
        policy: (visible) =>
          Effect.succeed({
            ...visible,
            semantics: finalSemantics,
            metadata: toolExecutionMetadata,
            authorization,
          }),
        pre: (policy) => Effect.succeed(policy),
        around: (_prepared, next) => next(),
        postInExecute: true,
        execute: (_prepared, post) =>
          scheduler.run({
            metadata: toolExecutionMetadata,
            coordinatesChildren: "coordinatesChildren" in registration && registration.coordinatesChildren === true,
            effect: gateway
              .execute<ToolOutput, ToolFailure, never>(
                {
                  actionID,
                  ...(input.runID ? { runID: input.runID } : {}),
                  ...(input.stepID ? { stepID: input.stepID } : {}),
                  ...context,
                  name: input.call.name,
                  resources: actionResources,
                  semantics: finalSemantics,
                  reasonSummary: scheduledTaskRegistration
                    ? `执行预排子任务 ${String((decodedResult.decoded as { description?: unknown }).description ?? "")}`
                    : legacySessionCarrier
                      ? `执行工具 ${input.call.name}；风险等级 ${finalSemantics.riskTier}`
                      : `Execute tool ${input.call.name}`,
                  ...(scheduledTaskRegistration || legacySessionCarrier
                    ? { initiator: "agent" as const, traceID: input.runID ?? actionID }
                    : {}),
                  inputDigest,
                },
                {
                  ...(authorization ? { authorization } : {}),
                  ...(hasPostprocessing(registration.tool)
                    ? {
                        afterSuccessMode: "projection" as const,
                        afterSuccess: (output: ToolOutput) =>
                          post({ output }).pipe(
                            Effect.map((processed) => {
                              if (!("output" in processed) || !processed.output)
                                throw new Error("Tool postprocessing did not return an output")
                              return processed.output
                            }),
                          ),
                      }
                    : {}),
                  execute: (capability, executionContext) =>
                    Effect.gen(function* () {
                      const abort = new AbortController()
                      // ActionGateway may alias a provider replay to the
                      // original durable action during recovery. Bind every
                      // leaf/child check to the action identity carried by the
                      // verified capability so recovery does not compare the
                      // old grant with the new provider message identity.
                      let effectiveActionID = actionID
                      try {
                        effectiveActionID = ActionGateway.capabilityGrant(capability)?.actionID ?? actionID
                      } catch {
                        // The gateway still performs the authoritative
                        // capability validation; retain the presented ID for
                        // compatibility gateways that expose no grant.
                      }
                      let authority: AgentRuntime.Authority | undefined
                      let partialOutput: ToolOutput | undefined
                      try {
                        authority = ActionGateway.capabilityAuthority(capability)
                      } catch {
                        // Compatibility gateways may not expose a runtime
                        // capability. Never infer or upgrade authority.
                      }
                      return yield* settle(registration.tool, input.call, {
                        ...context,
                        abort: abort.signal,
                        ...(input.interruptedOutput
                          ? {
                              retainPartialOutput: (output: ToolOutput) =>
                                Effect.sync(() => {
                                  partialOutput = output
                                }),
                            }
                          : {}),
                        ...(executionContext?.reportProgress
                          ? { reportProgress: executionContext.reportProgress }
                          : {}),
                        childActions: {
                          parentActionID: effectiveActionID,
                          ...(input.runID ? { parentRunID: input.runID } : {}),
                          ...(authority ? { authority } : {}),
                          execute: gateway.execute,
                          recordMutationIntent: gateway.recordMutationIntent,
                        },
                        permission: scopedPermission({
                          capability,
                          expectedActionID: effectiveActionID,
                          automaticRequests,
                        }),
                        egress:
                          legacySessionCarrier &&
                          input.call.name === "bash" &&
                          typeof (decodedResult.decoded as { command?: unknown }).command === "string"
                            ? scopedEgress({
                                capability,
                                expectedActionID: effectiveActionID,
                                automaticRequests,
                                action: permissionAction,
                                networkScope: [
                                  `process:${(decodedResult.decoded as { command: string }).command.trim()}`,
                                ],
                                secretScope: [],
                                allowedMethods: ["GET"],
                              })
                            : input.call.name === "webfetch" || input.call.name === "websearch"
                              ? scopedEgress({
                                  capability,
                                  expectedActionID: effectiveActionID,
                                  automaticRequests,
                                  action: permissionAction,
                                  networkScope: finalSemantics.networkScope,
                                  secretScope: finalSemantics.secretScope,
                                  allowedMethods: input.call.name === "webfetch" ? ["GET"] : ["POST"],
                                })
                              : Egress.deny(),
                      }).pipe(
                        Effect.onInterrupt(() =>
                          Effect.gen(function* () {
                            abort.abort("canonical tool execution interrupted")
                            if (partialOutput && input.interruptedOutput) {
                              const bounded = yield* resources
                                .bound({ sessionID: input.sessionID, toolCallID: input.call.id, output: partialOutput })
                                .pipe(Effect.orDie)
                              yield* Ref.set(input.interruptedOutput, bounded)
                            }
                          }),
                        ),
                      )
                    }),
                  successSummary: () =>
                    scheduledTaskRegistration
                      ? `子任务 ${String((decodedResult.decoded as { description?: unknown }).description ?? "")} 已完成`
                      : legacySessionCarrier
                        ? `${input.call.name} 已返回经过校验的结果`
                        : `${input.call.name} returned a validated result`,
                  durableResult: {
                    encode: (value) => value,
                    decode: (value) => value as ToolOutput,
                  },
                },
              )
              .pipe(
                Effect.map((output) => ({ output })),
                Effect.catchTag("ActionGateway.BlockedError", (error) =>
                  Effect.succeed({ result: { type: "error" as const, value: error.reason } }),
                ),
                Effect.catchTag("ActionGateway.AlreadySettledError", (error) =>
                  Effect.succeed({
                    result: {
                      type: "error" as const,
                      value: `Action already completed and was not repeated: ${error.summary}`,
                    },
                  }),
                ),
                Effect.catchTag("ActionGateway.RecoveryRequiredError", (error) =>
                  Effect.succeed({ result: { type: "error" as const, value: error.reason } }),
                ),
                Effect.catchTag("ActionGateway.PostProcessingError", (error) =>
                  Effect.succeed({ result: { type: "error" as const, value: error.reason } }),
                ),
                Effect.catchTag("ActionGateway.ActionInProgressError", () =>
                  Effect.succeed({
                    result: {
                      type: "error" as const,
                      value: "Action is already in progress and was not executed by a second worker.",
                    },
                  }),
                ),
                Effect.catchTag("DurableAction.CorruptHistoryError", (error) =>
                  Effect.succeed({
                    result: {
                      type: "error" as const,
                      value: `Durable action history failed integrity validation: ${error.reason}`,
                    },
                  }),
                ),
                Effect.catchTag("ActionGateway.ActionIntentMismatchError", (error) =>
                  Effect.succeed({ result: { type: "error" as const, value: error.reason } }),
                ),
                Effect.catchTag("ActionGateway.InvalidSubjectError", (error) =>
                  Effect.succeed({ result: { type: "error" as const, value: error.reason } }),
                ),
                Effect.catchTag("LLM.ToolFailure", (failure) =>
                  Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
                ),
              ),
          }),
        post: (_prepared, result) =>
          "output" in result && result.output !== undefined
            ? postprocess(registration.tool, input.call, result.output, context).pipe(
                Effect.map((output) => ({ output })),
                Effect.orDie,
              )
            : Effect.succeed(result),
        normalize: (pendingResult) => {
          if ("result" in pendingResult) return Effect.succeed(pendingResult)
          return resources
            .bound({ sessionID: input.sessionID, toolCallID: input.call.id, output: pendingResult.output })
            .pipe(
              Effect.map((bounded) => {
                const result = ToolOutput.toResultValue(bounded.output)
                if (result.type === "error")
                  return bounded.outputPaths.length > 0
                    ? {
                        result,
                        outputPaths: bounded.outputPaths,
                        ...(bounded.artifactRefs === undefined ? {} : { artifactRefs: bounded.artifactRefs }),
                      }
                    : {
                        result,
                        ...(bounded.artifactRefs === undefined ? {} : { artifactRefs: bounded.artifactRefs }),
                      }
                return bounded.outputPaths.length > 0
                  ? {
                      result,
                      output: bounded.output,
                      outputPaths: bounded.outputPaths,
                      ...(bounded.artifactRefs === undefined ? {} : { artifactRefs: bounded.artifactRefs }),
                    }
                  : {
                      result,
                      output: bounded.output,
                      ...(bounded.artifactRefs === undefined ? {} : { artifactRefs: bounded.artifactRefs }),
                    }
              }),
              Effect.tapError(() =>
                Effect.sync(() => {
                  // Retention failure aborts the settlement (the caller still
                  // receives the typed StorageError), but it must not leave the
                  // observability lifecycle open because normalize never reaches
                  // the normal finalize stage.
                  RuntimeInsight.auditRecord({
                    actor: "agent",
                    action: "tool.execute.end",
                    resource: input.call.name,
                    reason: "output retention failure",
                    metadata: {
                      sessionID: input.sessionID,
                      toolCallID: input.call.id,
                      status: "error",
                      concurrency: toolExecutionMetadata.concurrency,
                      sideEffect: toolExecutionMetadata.sideEffect,
                      timeoutMode: toolExecutionMetadata.timeoutMode,
                      outputPolicy: toolExecutionMetadata.outputPolicy,
                    },
                  })
                }),
              ),
            )
        },
        finalize: (settlement) =>
          Effect.sync(() => {
            RuntimeInsight.auditRecord({
              actor: "agent",
              action: "tool.execute.end",
              resource: input.call.name,
              reason: "result" in settlement && settlement.result.type === "error" ? "error" : "success",
              metadata: {
                sessionID: input.sessionID,
                toolCallID: input.call.id,
                status: "result" in settlement ? settlement.result.type : "success",
                concurrency: toolExecutionMetadata.concurrency,
                sideEffect: toolExecutionMetadata.sideEffect,
                timeoutMode: toolExecutionMetadata.timeoutMode,
                outputPolicy: toolExecutionMetadata.outputPolicy,
                ...(toolExecutionMetadata.resourceKey
                  ? { resourceKeyDigest: canonicalHash(toolExecutionMetadata.resourceKey) }
                  : {}),
              },
            })
          }).pipe(Effect.as(settlement)),
        settle: (settlement) => Effect.succeed(settlement),
      }).pipe(
        Effect.catchIf(
          (error): error is ToolPipelineError => error instanceof ToolPipelineError,
          (error) => Effect.succeed({ result: { type: "error" as const, value: error.message } }),
        ),
      )
      return pending
    })

    const registerBuiltIns = Effect.fn("ToolRegistry.registerBuiltIns")(function* (
      capability: object,
      tools: Readonly<Record<string, AnyTool>>,
    ) {
      // Forged provenance fails closed before any state is touched: the
      // minted capability is closure-owned and never exportable.
      if (!trustedCapabilities.has(capability))
        return yield* new RegistrationError({
          name: Object.keys(tools)[0] ?? "",
          message: "Invalid built-in registration capability: trusted built-in provenance cannot be forged",
        })
      const entries = Object.entries(tools)
      if (entries.length === 0) return
      yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
      // The trusted carrier may only mint trust for declared built-in names:
      // a name outside the exhaustive reserved set fails closed so a trusted
      // carrier can never accidentally mint trust for undeclared tools.
      for (const [name] of entries) {
        if (TurnToolCarrier.isName(name))
          return yield* new RegistrationError({
            name,
            message: `The name ${name} is reserved for an opaque per-turn carrier and cannot be registered`,
          })
        if (!isReservedBuiltInName(name))
          return yield* new RegistrationError({
            name,
            message: `The name ${name} is not a declared built-in and cannot be trusted-registered`,
          })
      }
      // Deterministic fail-closed: a second trusted registration of the
      // same built-in name is rejected before any state is mutated.
      for (const [name] of entries) {
        const active = local.get(name)?.some((entry) => entry.registration.trusted) ?? false
        if (active)
          return yield* new RegistrationError({
            name,
            message: `The trusted built-in tool ${name} is already registered and cannot be registered twice`,
          })
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const token = {}
          for (const [name, tool] of entries) {
            // A trusted built-in supersedes any earlier external entry of
            // the same name: the external entry is purged so its finalizer
            // can never remove or reveal around the trusted built-in.
            const prior = local.get(name)?.filter((entry) => entry.registration.trusted) ?? []
            local.set(name, [...prior, { token, registration: { identity: {}, tool, trusted: true } }])
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const [name] of entries) {
                const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                if (registrations.length > 0) local.set(name, registrations)
                else local.delete(name)
              }
            }),
          )
        }),
      )
    })

    // The trusted register is the token-gated path bound to the closure-owned
    // capability; the token itself never leaves this closure.
    const trustedRegister = (tools: Readonly<Record<string, AnyTool>>) => registerBuiltIns(builtInCapability, tools)

    return BundleTag.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        // Untrusted registrations can never claim a reserved built-in name
        // (no name-based static/automatic scope inheritance) and can never
        // overlay an active trusted built-in (no startup-order hijacking).
        for (const [name] of entries) {
          const overlaysTrusted = local.get(name)?.some((entry) => entry.registration.trusted) ?? false
          if (isReservedBuiltInName(name) || overlaysTrusted)
            return yield* new RegistrationError({
              name,
              message: `The built-in tool ${name} is reserved and cannot be registered by an external tool`,
            })
        }
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [
                ...(local.get(name) ?? []),
                { token, registration: { identity: {}, tool, trusted: false } },
              ])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      trustedRegister,
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = [], sessionID, options = {}) {
        const externalSessionID = options.externalTools ? sessionID : undefined
        if (sessionID) yield* deferred.setPermissions(sessionID, permissions)
        const registrations = new Map<string, Registration>()
        if (options.includeRegistered !== false) {
          for (const [name, registration] of applications.entries())
            registrations.set(name, { ...registration, trusted: false })
          for (const [name, entries] of local) {
            const registration = entries.at(-1)?.registration
            if (registration) registrations.set(name, registration)
          }
          for (const [name, registration] of registrations)
            if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
          for (const [name] of registrations) if (!deferred.visible(sessionID, name)) registrations.delete(name)
        }
        const transient = new Map<string, Registration>()
        if (options.externalTools && options.includeRegistered !== false) {
          const entries = Object.entries(options.externalTools)
          if (entries.length > 0 && !sessionID)
            return yield* new RegistrationError({
              name: entries[0]![0],
              message: "External tool snapshots require a Session identity",
            })
          for (const [name, tool] of entries) {
            yield* validateName(name)
            if (
              isReservedBuiltInName(name) ||
              TurnToolCarrier.isName(name) ||
              local.has(name) ||
              applications.entries().has(name)
            )
              return yield* new RegistrationError({
                name,
                message: `External snapshot cannot replace a registered or reserved tool: ${name}`,
              })
            if (whollyDisabled(permission(tool, name), permissions)) continue
            const registration: Registration = { identity: {}, tool, trusted: false }
            transient.set(name, registration)
            registrations.set(name, registration)
          }
        }
        if (options.modelTaskTool && !whollyDisabled(permission(options.modelTaskTool, "task"), permissions)) {
          const registration: Registration = {
            identity: {},
            tool: options.modelTaskTool,
            trusted: true,
            coordinatesChildren: true,
          }
          transient.set("task", registration)
          registrations.set("task", registration)
        }
        if (options.structuredOutput) {
          const prepared = yield* Effect.try({
            try: () => StructuredOutput.prepare(options.structuredOutput!),
            catch: (error) =>
              error instanceof StructuredOutput.InvalidSchemaError
                ? error
                : new StructuredOutput.InvalidSchemaError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
          })
          const registration: Registration = {
            identity: {},
            tool: prepared.tool,
            trusted: true,
            carrier: "structured-output",
          }
          transient.set(StructuredOutput.name, registration)
          registrations.set(StructuredOutput.name, registration)
        }
        if ("scheduledTask" in options)
          return yield* new TurnToolCarrier.InvalidCarrierError({
            carrier: "scheduled-task-retired-use-scheduledTaskTool",
          })
        if (options.scheduledTaskTool) {
          const registration: Registration = {
            identity: {},
            tool: options.scheduledTaskTool,
            trusted: true,
            carrier: "scheduled-task",
            coordinatesChildren: true,
          }
          transient.set(TurnToolCarrier.scheduledTaskName, registration)
          registrations.set(TurnToolCarrier.scheduledTaskName, registration)
        }
        if (options.userAttachmentRead) {
          const tool = yield* Effect.try({
            try: () => TurnToolCarrier.userAttachmentReadTool(options.userAttachmentRead!),
            catch: (error) =>
              error instanceof TurnToolCarrier.InvalidCarrierError
                ? error
                : new TurnToolCarrier.InvalidCarrierError({ carrier: "user-attachment-read" }),
          })
          const registration: Registration = {
            identity: {},
            tool,
            trusted: true,
            carrier: "user-attachment-read",
          }
          transient.set(TurnToolCarrier.userAttachmentReadName, registration)
          registrations.set(TurnToolCarrier.userAttachmentReadName, registration)
        }
        if (options.legacySessionTools) {
          const entries = yield* Effect.try({
            try: () => TurnToolCarrier.legacySessionToolEntries(options.legacySessionTools!),
            catch: (error) =>
              error instanceof TurnToolCarrier.InvalidCarrierError
                ? error
                : new TurnToolCarrier.InvalidCarrierError({ carrier: "legacy-session-tools" }),
          })
          for (const entry of entries) {
            if ((!entry.trusted && isReservedBuiltInName(entry.name)) || transient.has(entry.name))
              return yield* new TurnToolCarrier.InvalidCarrierError({ carrier: "legacy-session-tools" })
            const registration: Registration = {
              identity: {},
              tool: entry.tool,
              trusted: entry.trusted,
              carrier: "legacy-session-tool",
              authorization: entry.authorization,
            }
            transient.set(entry.name, registration)
            registrations.set(entry.name, registration)
          }
        }
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          quiesce: scheduler.quiesce,
          settle: (input) => {
            if (externalSessionID && input.sessionID !== externalSessionID)
              return Effect.succeed({
                result: { type: "error", value: "Tool snapshot belongs to a different Session" },
              })
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity, transient.get(input.call.name))
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
      discover: Effect.fn("ToolRegistry.discover")(function* (input) {
        if (!deferred.enabled()) return yield* new DiscoverError({ message: "Deferred tool loading is disabled" })
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), deferred.permissions(input.sessionID)))
            registrations.delete(name)
        const exact = input.query.startsWith("select:")
          ? input.query
              .slice("select:".length)
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean)
          : undefined
        const terms = exact
          ? []
          : input.query
              .toLowerCase()
              .split(/\s+/)
              .map((term) => ({ required: term.startsWith("+"), value: term.replace(/^\+/, "") }))
              .filter((term) => term.value.length > 0)
        const matches = Array.from(registrations, ([name, registration]) => {
          const tool = definition(name, registration.tool)
          const text = `${name} ${tool.description}`.toLowerCase()
          if (name === "tool_search") return
          if (exact && !exact.includes(name)) return
          if (terms.some((term) => term.required && !text.includes(term.value))) return
          if (!exact && terms.length > 0 && !terms.some((term) => text.includes(term.value))) return
          const score = exact
            ? exact.indexOf(name)
            : terms.reduce(
                (total, term) =>
                  total +
                  (name === term.value
                    ? 100
                    : name.startsWith(term.value)
                      ? 50
                      : name.includes(term.value)
                        ? 25
                        : text.includes(term.value)
                          ? 5
                          : 0),
                0,
              )
          return {
            name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            score,
          }
        })
          .filter(
            (
              match,
            ): match is {
              name: string
              description: string
              inputSchema: Readonly<Record<string, unknown>>
              outputSchema: Readonly<Record<string, unknown>> | undefined
              score: number
            } => match !== undefined,
          )
          .toSorted((a, b) => b.score - a.score || a.name.localeCompare(b.name))
          .slice(0, input.limit)
        if (exact && matches.length !== exact.length)
          return yield* new DiscoverError({ message: "One or more selected tools are unavailable" })
        yield* deferred.activate(
          input.sessionID,
          matches.map((match) => match.name),
        )
        return {
          tools: matches.map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
          })),
          activated: matches.map((match) => match.name),
        }
      }),
      catalog: Effect.fn("ToolRegistry.catalog")(function* () {
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        return Array.from(registrations, ([name, registration]) => {
          const manifest: ToolManifest =
            BuiltInToolManifest[name] ??
            makeToolManifest(name, {
              operation: "unclassified.external-tool",
              deadlineMs: 1,
              recovery: "manual",
              externalOperation: true,
              networkEgress: "input_declared",
              secretScope: "input_scoped",
            })
          const toolDefinition = definition(name, registration.tool)
          const schemaDigest = canonicalHash({
            inputSchema: toolDefinition.inputSchema,
            outputSchema: toolDefinition.outputSchema,
          })
          const metadata = executionMetadata(registration.tool)
          return {
            ...manifest,
            ...(schemaDigest ? { schemaDigest } : {}),
            ...(metadata.concurrency ? { concurrency: metadata.concurrency } : {}),
            ...(metadata.sideEffect ? { sideEffect: metadata.sideEffect } : {}),
            ...(metadata.timeoutMode ? { timeoutMode: metadata.timeoutMode } : {}),
            ...(metadata.outputPolicy ? { outputPolicy: metadata.outputPolicy } : {}),
            ...(typeof metadata.resourceKey === "string" ? { resourceKey: metadata.resourceKey } : {}),
            ...(metadata.idempotency ? { idempotency: metadata.idempotency } : {}),
            effectDeclaration: effectDeclaration(registration.tool),
          }
        }).sort((left, right) => left.name.localeCompare(right.name))
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  BundleTag.use((bundle) => Effect.succeed(Tools.Service.of({ register: bundle.register }))),
).pipe(Layer.provideMerge(registryLayer))

const publicLayer = Layer.effect(
  Service,
  BundleTag.use((bundle) =>
    Effect.succeed(
      Service.of({
        register: bundle.register,
        materialize: bundle.materialize,
        discover: bundle.discover,
        catalog: bundle.catalog,
      }),
    ),
  ),
).pipe(Layer.provideMerge(registryLayer))

const builtInsLayer = Layer.effect(
  Tools.BuiltIns,
  BundleTag.use((bundle) => Effect.succeed(Tools.BuiltIns.of({ register: bundle.trustedRegister }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer: publicLayer,
  deps: [
    ApplicationTools.node,
    ToolOutputStore.node,
    DeferredTools.node,
    ActionGateway.node,
    RuntimeInvariants.node,
    PermissionV2.node,
    LocationMutation.node,
  ],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [
    ApplicationTools.node,
    ToolOutputStore.node,
    DeferredTools.node,
    ActionGateway.node,
    RuntimeInvariants.node,
    PermissionV2.node,
    LocationMutation.node,
  ],
})

/**
 * Trusted built-in registration view, installed only by the runtime
 * composition root into explicitly wired core built-in nodes (their `deps`).
 * The implementation is the closure-bound trusted register from the
 * module-private registry bundle; the token-gated capability minted inside
 * the registry layer never leaves that closure and is not exported. This
 * guards normal untrusted registration paths and composition wiring; it is
 * not process isolation against arbitrary hostile in-process code that
 * composes this node itself.
 */
export const builtInsNode = makeLocationNode({
  service: Tools.BuiltIns,
  layer: builtInsLayer,
  deps: [
    ApplicationTools.node,
    ToolOutputStore.node,
    DeferredTools.node,
    ActionGateway.node,
    RuntimeInvariants.node,
    PermissionV2.node,
    LocationMutation.node,
  ],
})
