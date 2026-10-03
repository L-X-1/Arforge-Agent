import { MCP } from "@/mcp"
import { McpControlGateway } from "@/mcp/control-gateway"
import { InstanceStore } from "@/project/instance-store"
import {
  createMcpOperationReconciliationLookup,
  isMcpChildAction,
  registerMcpReconciliationAdapter,
  type McpReconciliationLookup,
  type McpReconciliationSnapshot,
} from "@/mcp/reconciliation"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Location } from "@arforge-ai/core/location"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import {
  ReconciliationRegistry,
  type ReconciliationDecision,
  type ReconciliationRequest,
} from "@arforge-ai/core/runtime/reconciliation"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ForbiddenError, InvalidRequestError, McpServerNotFoundError } from "@arforge-ai/protocol/errors"
import { Api } from "@arforge-ai/server/api"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { response } from "@arforge-ai/server/location"
import { Effect, Exit } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"

const notFound = (error: { readonly name: string }) =>
  new McpServerNotFoundError({
    server: error.name,
    message: `MCP server not found: ${error.name}`,
  })

const mcpCatalogError = (_error: unknown) =>
  new InvalidRequestError({
    kind: "mcp-catalog-control-failed",
    field: "query",
    message:
      "MCP catalog could not be read from the current generation-scoped transport; retry after checking connection and authorization.",
  })

function inLocation<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory: location.directory }, effect)
  })
}

const projectReconciliation = (actionID: string, decision: ReconciliationDecision) => ({
  actionID,
  kind: decision.kind,
  state: decision.state,
  automaticRetryAllowed: decision.automaticRetryAllowed,
  reason: decision.reason,
  evidence: {
    state: decision.evidence.state,
    evidenceDigest: decision.evidence.evidenceDigest,
    source: decision.evidence.source,
    observedAt: decision.evidence.observedAt,
    summary: decision.evidence.summary ?? null,
  },
})

const reconciliationRequest = (input: {
  readonly actionID: string
  readonly intentDigest: string
  readonly idempotencyKey: string
}): ReconciliationRequest => ({
  actionID: input.actionID,
  actionKind: "mcp",
  actionVersion: "1",
  intentDigest: input.intentDigest,
  idempotencyKey: input.idempotencyKey,
})

const registryForSnapshot = (snapshot: McpReconciliationSnapshot | undefined, lookup?: McpReconciliationLookup) =>
  registerMcpReconciliationAdapter(new ReconciliationRegistry(), {
    // Keep the loader in the current request Effect. Running a second Effect
    // root inside Effect.promise would lose a PostgreSQL request principal or
    // transaction; the current MCP adapter is read-only and can reconcile the
    // already loaded immutable snapshot.
    loadAction: () => snapshot,
    ...(lookup ? { lookup } : {}),
  })

const reconcileSnapshot = (
  snapshot: McpReconciliationSnapshot | undefined,
  request: ReconciliationRequest,
  lookup?: McpReconciliationLookup,
) =>
  Effect.promise(() => registryForSnapshot(snapshot, lookup).reconcile(request)).pipe(
    Effect.mapError(
      () =>
        new InvalidRequestError({
          kind: "mcp-reconciliation-invalid",
          field: "query",
          message: "MCP reconciliation input or durable evidence is invalid; manual recovery is required.",
        }),
    ),
  )

export const mcpV2Handlers = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const operationLookupForRequest = Effect.gen(function* () {
      // ReconciliationRegistry is promise-based, while MCP.lookupTask is an
      // Effect that needs the current location/instance context. Capture the
      // request context explicitly instead of starting an unbound runtime.
      const context = yield* Effect.context()
      return createMcpOperationReconciliationLookup({
        ...(mcp.lookupTask
          ? {
              lookupTask: (reference) =>
                Effect.runPromise(mcp.lookupTask!(reference.server, reference.taskID).pipe(Effect.provide(context))),
            }
          : {}),
        // Non-`tasks` vendor providers are opt-in. The standard MCP service
        // does not guess a vendor endpoint; an embedding host may provide a
        // read-only lookup contract without exposing transport or payloads.
        ...(mcp.lookupExternalOperation
          ? {
              providers: {
                get:
                  (provider: string) =>
                  (reference: { readonly server: string; readonly provider: string; readonly operationID: string }) =>
                    reference.provider !== provider
                      ? Promise.resolve(undefined)
                      : Effect.runPromise(
                          mcp.lookupExternalOperation!(reference.server, provider, reference.operationID).pipe(
                            Effect.provide(context),
                          ),
                        ),
              },
            }
          : {}),
      })
    })

    return handlers
      .handle(
        "mcp.list",
        Effect.fn("McpV2.list")(function* () {
          return yield* response(
            inLocation(mcp.status()).pipe(
              Effect.map((status) => Object.entries(status).map(([name, value]) => ({ name, status: value }))),
            ),
          )
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn("McpV2.resourceCatalog")(function* () {
          const identity = yield* IdentityContext.Current
          return yield* response(
            inLocation(
              McpControlGateway.catalog({
                mcp,
                principal: { tenantID: identity.tenantID, userID: identity.userID },
                requestID: AgentRuntime.ControlPlaneRequestID.create(),
              }),
            ).pipe(
              Effect.mapError(mcpCatalogError),
              Effect.map(({ resources, resourceTemplates: templates }) => ({
                resources: Object.values(resources).map(({ client, ...resource }) => ({
                  ...resource,
                  server: client,
                })),
                templates: Object.values(templates).map(({ client, ...template }) => ({
                  ...template,
                  server: client,
                })),
              })),
            ),
          )
        }),
      )
      .handle(
        "mcp.capabilities",
        Effect.fn("McpV2.capabilities")(function* () {
          const identity = yield* IdentityContext.Current
          return yield* response(
            inLocation(
              McpControlGateway.catalog({
                mcp,
                principal: { tenantID: identity.tenantID, userID: identity.userID },
                requestID: AgentRuntime.ControlPlaneRequestID.create(),
              }),
            ).pipe(
              Effect.mapError(mcpCatalogError),
              Effect.map((snapshot) => snapshot.capabilities),
            ),
          )
        }),
      )
      .handle(
        "mcp.action.reconciliation",
        Effect.fn("McpV2.actionReconciliation")(function* ({ params, query }) {
          return yield* response(
            inLocation(
              Effect.gen(function* () {
                const actions = yield* DurableAction.Service
                const loaded = yield* actions.load(AgentRuntime.ActionID.make(params.actionID)).pipe(Effect.exit)
                const snapshot = Exit.isSuccess(loaded) ? loaded.value : undefined
                const operationLookup = yield* operationLookupForRequest
                const decision = yield* reconcileSnapshot(
                  snapshot,
                  reconciliationRequest({
                    actionID: params.actionID,
                    intentDigest: query.intentDigest,
                    idempotencyKey: query.idempotencyKey,
                  }),
                  operationLookup,
                )
                return projectReconciliation(params.actionID, decision)
              }),
            ),
          )
        }),
      )
      .handle(
        "mcp.action.reconciliationRecord",
        Effect.fn("McpV2.actionReconciliationRecord")(function* ({ params, query, payload }) {
          return yield* response(
            inLocation(
              Effect.gen(function* () {
                const principal = yield* IdentityContext.Current
                if (principal.role === "member")
                  return yield* new ForbiddenError({
                    message: "Recording MCP reconciliation evidence requires an owner/admin operator.",
                  })

                const actions = yield* DurableAction.Service
                const actionID = AgentRuntime.ActionID.make(params.actionID)
                const snapshot = yield* actions.load(actionID).pipe(
                  Effect.catchTag(
                    "DurableAction.NotFoundError",
                    () =>
                      new InvalidRequestError({
                        kind: "durable-action-not-found",
                        field: "actionID",
                        message: "The requested MCP durable action was not found in this workspace.",
                      }),
                  ),
                  Effect.catchTag(
                    "DurableAction.CorruptHistoryError",
                    () =>
                      new InvalidRequestError({
                        kind: "durable-action-history-corrupt",
                        field: "actionID",
                        message:
                          "The MCP durable action history failed integrity validation; manual recovery is required.",
                      }),
                  ),
                )
                if (!isMcpChildAction(snapshot))
                  return yield* new InvalidRequestError({
                    kind: "mcp-reconciliation-unsupported-action",
                    field: "actionID",
                    message: "Only a marked MCP child action can receive MCP reconciliation evidence.",
                  })

                const request = reconciliationRequest({
                  actionID: params.actionID,
                  intentDigest: query.intentDigest,
                  idempotencyKey: query.idempotencyKey,
                })
                const operationLookup = yield* operationLookupForRequest
                const decision = yield* reconcileSnapshot(snapshot, request, operationLookup)
                if (decision.evidence.evidenceDigest !== payload.expectedEvidenceDigest)
                  return yield* new InvalidRequestError({
                    kind: "mcp-reconciliation-stale-evidence",
                    field: "expectedEvidenceDigest",
                    message: "The confirmation is based on stale MCP evidence; inspect again before recording it.",
                  })

                // The read-only projection above may race with a concurrent
                // observation or reconciliation event. Re-load and project
                // once more immediately before the write so a confirmation
                // cannot append evidence derived from an obsolete snapshot.
                const refreshed = yield* actions.load(actionID).pipe(
                  Effect.catchTag(
                    "DurableAction.NotFoundError",
                    () =>
                      new InvalidRequestError({
                        kind: "mcp-reconciliation-stale-evidence",
                        field: "actionID",
                        message: "The MCP durable action changed while it was being confirmed; inspect it again.",
                      }),
                  ),
                  Effect.catchTag(
                    "DurableAction.CorruptHistoryError",
                    () =>
                      new InvalidRequestError({
                        kind: "mcp-reconciliation-stale-evidence",
                        field: "actionID",
                        message: "The MCP durable action changed while it was being confirmed; inspect it again.",
                      }),
                  ),
                )
                if (!isMcpChildAction(refreshed))
                  return yield* new InvalidRequestError({
                    kind: "mcp-reconciliation-unsupported-action",
                    field: "actionID",
                    message: "Only a marked MCP child action can receive MCP reconciliation evidence.",
                  })
                const freshDecision = yield* reconcileSnapshot(refreshed, request, operationLookup)
                if (
                  freshDecision.evidence.evidenceDigest !== payload.expectedEvidenceDigest ||
                  freshDecision.evidence.evidenceDigest !== decision.evidence.evidenceDigest
                )
                  return yield* new InvalidRequestError({
                    kind: "mcp-reconciliation-stale-evidence",
                    field: "expectedEvidenceDigest",
                    message:
                      "The MCP evidence changed while it was being confirmed; inspect it again before recording.",
                  })

                const gateway = yield* ActionGateway.Service
                const recorded = yield* gateway.reconcile(request, freshDecision).pipe(
                  Effect.mapError(
                    () =>
                      new InvalidRequestError({
                        kind: "mcp-reconciliation-write-rejected",
                        field: "payload",
                        message:
                          "MCP reconciliation evidence could not be recorded; the durable identity or history changed.",
                      }),
                  ),
                )
                return projectReconciliation(params.actionID, recorded)
              }),
            ),
          )
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn("McpV2.connect")(function* ({ params }) {
          yield* inLocation(mcp.connect(params.server)).pipe(Effect.mapError(notFound))
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn("McpV2.disconnect")(function* ({ params }) {
          yield* inLocation(mcp.disconnect(params.server)).pipe(Effect.mapError(notFound))
        }),
      )
  }),
)
