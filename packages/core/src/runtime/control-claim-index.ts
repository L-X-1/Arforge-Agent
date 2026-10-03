import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, eq } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import * as ActionGateway from "../action-gateway"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { canonicalHash } from "../util/canonical-hash"
import { ControlPrincipal } from "./control-principal"
import { DurableRun } from "./durable-run"
import { ControlRunClaimTable, ControlRunRequestAliasTable } from "./control-claim-index.sql"

/**
 * Request identity is intentionally a Context reference rather than a value
 * captured by the Layer. A long-lived location layer can therefore never
 * reuse the tenant/user of the request that constructed it.
 */
export type Principal = ControlPrincipal.Principal
export const CurrentPrincipal = Context.Reference<Principal | undefined>("@arforge/v2/ControlClaimIndex/principal", {
  defaultValue: () => undefined,
})

export class MissingPrincipalError extends Schema.TaggedErrorClass<MissingPrincipalError>()(
  "ControlClaimIndex.MissingPrincipalError",
  {},
) {}

export class InvalidClaimMaterialError extends Schema.TaggedErrorClass<InvalidClaimMaterialError>()(
  "ControlClaimIndex.InvalidClaimMaterialError",
  { reason: Schema.String },
) {}

export class ClaimConflictError extends Schema.TaggedErrorClass<ClaimConflictError>()(
  "ControlClaimIndex.ClaimConflictError",
  { reason: Schema.String },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ControlClaimIndex.NotFoundError", {
  requestID: AgentRuntime.ControlPlaneRequestID,
}) {}

type ControlGatewayInput = Omit<
  Extract<ActionGateway.Input, { readonly kind: "control-plane" }>,
  "actionID" | "runID" | "inputDigest" | "controlPlane"
>

/**
 * Raw, server-built material only. In particular this surface deliberately
 * has no action/run/operation IDs and no digest or generation knobs.
 */
export type ClaimInput = {
  readonly subject: AgentRuntime.ControlPlaneSubject
  readonly gateway: ControlGatewayInput
  readonly authorization: ActionGateway.AuthorizationPlan
  readonly input: unknown
  readonly operation: {
    readonly kind: string
    readonly payload: unknown
  }
  /**
   * Optional server-frozen, request-independent material used only for the
   * canonical claim binding. The durable operation above remains the exact
   * presented execution snapshot (and may therefore contain requestID-bound
   * reservation paths). This value must be constructed by a trusted server
   * adapter; it is never persisted as executable operation payload.
   */
  readonly claimMaterial?: {
    readonly input: unknown
    readonly payload: unknown
  }
  readonly run: {
    readonly initiator: AgentRuntime.Initiator
    readonly authority: AgentRuntime.Authority
    readonly riskTier: AgentRuntime.RiskTier
    readonly reasonSummary: string
    readonly budget: AgentRuntime.Budget
    readonly traceID: string
    readonly parentTraceID?: string
    readonly visibility: AgentRuntime.Visibility
    readonly goalID?: AgentRuntime.ControlRun["goalID"]
    readonly taskID?: AgentRuntime.ControlRun["taskID"]
  }
}

export type ClaimResult = {
  readonly kind: "claimed" | "existing"
  readonly snapshot: DurableRun.ControlSnapshot
  readonly presentedRequestID: AgentRuntime.ControlPlaneRequestID
}

type Derived = {
  readonly principal: Principal
  readonly input: ClaimInput
  readonly inputDigest: string
  readonly payloadDigest: string
  readonly actionID: AgentRuntime.ActionID
  readonly authorizationDigest: string
  readonly claimDigest: string
  readonly baseBindingDigest: string
  readonly bindingDigest: string
  readonly generation: number
  readonly operationID: AgentRuntime.ControlOperationID
  readonly runID: AgentRuntime.RunID
  readonly snapshotDigest: string
  readonly create: DurableRun.ControlCreateInput
}

const canonicalResources = (items: ReadonlyArray<string>) => [...new Set(items)].sort()
const canonicalRequests = (items: ReadonlyArray<ActionGateway.AuthorizationRequest>) =>
  items
    .map((item) => ({ action: item.action, resources: canonicalResources(item.resources) }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

const fixedSubject = (subject: AgentRuntime.ControlPlaneSubject) => ({
  type: subject.type,
  id: subject.id,
  location: subject.location,
  project: subject.project,
  actor: subject.actor,
  principalRef: subject.principalRef,
})

const claimMaterial = (
  principal: Principal,
  input: ClaimInput,
  claimInputDigest: string,
  claimPayloadDigest: string,
) => ({
  domain: "arforge.control-claim/v1",
  version: 1,
  principal: { tenantID: principal.tenantID, userID: principal.userID },
  subject: fixedSubject(input.subject),
  kind: input.operation.kind,
  name: input.gateway.name,
  policyVersion: ActionGateway.POLICY_VERSION,
  resources: canonicalResources(input.gateway.resources),
  requests: canonicalRequests(input.authorization.requests),
  metadata: input.authorization.metadata ?? null,
  semantics: input.gateway.semantics,
  inputDigest: claimInputDigest,
  payloadDigest: claimPayloadDigest,
  budget: input.run.budget,
  visibility: input.run.visibility,
})

type AliasMaterialInput = {
  readonly principal: Principal
  readonly controlPlaneID: AgentRuntime.ControlPlaneID
  readonly requestID: AgentRuntime.ControlPlaneRequestID
  readonly bindingDigest: string
  readonly authorizationDigest: string
  readonly actionID: AgentRuntime.ActionID
  readonly snapshotDigest: string
}

const aliasMaterial = (input: AliasMaterialInput) => ({
  domain: "arforge.control-request-alias/v1",
  version: 1,
  tenantID: input.principal.tenantID,
  userID: input.principal.userID,
  controlPlaneID: input.controlPlaneID,
  requestID: input.requestID,
  bindingDigest: input.bindingDigest,
  authorizationDigest: input.authorizationDigest,
  actionID: input.actionID,
  snapshotDigest: input.snapshotDigest,
})

const derivedAliasMaterial = (derived: Derived): AliasMaterialInput => ({
  principal: derived.principal,
  controlPlaneID: derived.input.subject.id,
  requestID: derived.input.subject.requestID,
  bindingDigest: derived.bindingDigest,
  authorizationDigest: derived.authorizationDigest,
  actionID: derived.actionID,
  snapshotDigest: derived.snapshotDigest,
})

const strictHash = (value: unknown, reason: string) => {
  const valueHash = canonicalHash(value)
  if (!valueHash) throw new InvalidClaimMaterialError({ reason })
  return valueHash
}

export interface Interface {
  readonly claim: (
    input: ClaimInput,
  ) => Effect.Effect<ClaimResult, MissingPrincipalError | InvalidClaimMaterialError | ClaimConflictError>
  readonly lookup: (input: {
    readonly controlPlaneID: AgentRuntime.ControlPlaneID
    readonly requestID: AgentRuntime.ControlPlaneRequestID
  }) => Effect.Effect<DurableRun.ControlSnapshot, MissingPrincipalError | NotFoundError | ClaimConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ControlClaimIndex") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const durable = yield* DurableRun.Service

    const principalNow = Effect.gen(function* () {
      const principal = yield* CurrentPrincipal
      if (!principal || !principal.tenantID || !principal.userID) return yield* new MissingPrincipalError()
      return principal
    })

    const findClaim = (principal: Principal, bindingDigest: string) =>
      database.db
        .select()
        .from(ControlRunClaimTable)
        .where(
          and(
            eq(ControlRunClaimTable.tenant_id, principal.tenantID),
            eq(ControlRunClaimTable.owner_user_id, principal.userID),
            eq(ControlRunClaimTable.binding_digest, bindingDigest),
          ),
        )
        .get()

    const findAlias = (
      principal: Principal,
      controlPlaneID: AgentRuntime.ControlPlaneID,
      requestID: AgentRuntime.ControlPlaneRequestID,
    ) =>
      database.db
        .select()
        .from(ControlRunRequestAliasTable)
        .where(
          and(
            eq(ControlRunRequestAliasTable.tenant_id, principal.tenantID),
            eq(ControlRunRequestAliasTable.owner_user_id, principal.userID),
            eq(ControlRunRequestAliasTable.control_plane_id, controlPlaneID),
            eq(ControlRunRequestAliasTable.request_id, requestID),
          ),
        )
        .get()

    const derive = Effect.fn("ControlClaimIndex.derive")(function* (principal: Principal, input: ClaimInput) {
      if (input.gateway.kind !== "control-plane")
        return yield* new InvalidClaimMaterialError({
          reason: "A control claim requires a control-plane gateway input.",
        })
      if (input.subject.principalRef !== ControlPrincipal.principalRef(principal))
        return yield* new InvalidClaimMaterialError({
          reason: "The control subject principal reference does not match the authenticated principal.",
        })
      if (
        input.subject.id !==
        ControlPrincipal.controlPlaneID(principal, {
          location: input.subject.location,
          projectID: input.subject.project,
          action: input.gateway.name,
        })
      )
        return yield* new InvalidClaimMaterialError({
          reason: "The control subject ID does not match the authenticated principal and operation binding.",
        })
      if (
        input.gateway.semantics.riskTier !== input.run.riskTier ||
        input.gateway.semantics.authority !== input.run.authority
      )
        return yield* new InvalidClaimMaterialError({
          reason: "Run authority and risk must exactly match the frozen gateway semantics.",
        })
      const inputDigest = strictHash(input.input, "The decoded control input is not canonical JSON.")
      const payloadDigest = strictHash(input.operation.payload, "The frozen control payload is not canonical JSON.")
      const claimInputDigest = strictHash(
        input.claimMaterial?.input ?? input.input,
        "The canonical control claim input is not canonical JSON.",
      )
      const claimPayloadDigest = strictHash(
        input.claimMaterial?.payload ?? input.operation.payload,
        "The canonical control claim payload is not canonical JSON.",
      )
      const actionID = ActionGateway.stableControlPlaneActionID({
        subject: input.subject,
        name: input.gateway.name,
        resources: input.gateway.resources,
        inputDigest,
        policyVersion: ActionGateway.POLICY_VERSION,
      })
      const claimDigest = strictHash(
        claimMaterial(principal, input, claimInputDigest, claimPayloadDigest),
        "The control claim material is not canonical.",
      )
      const baseBindingDigest = strictHash(
        {
          domain: "arforge.control-claim-base/v1",
          version: 1,
          principal: { tenantID: principal.tenantID, userID: principal.userID },
          subject: fixedSubject(input.subject),
          claimDigest,
        },
        "The control claim base binding is not canonical.",
      )
      // A binding is reused for every request alias. The generation is read
      // from its immutable row below; first material always starts at zero.
      const generation = 0
      const bindingDigest = strictHash(
        { domain: "arforge.control-claim-binding/v1", version: 1, baseBindingDigest, generation },
        "The control claim binding is not canonical.",
      )
      const operationID = DurableRun.controlOperationID({ subject: input.subject, claimDigest, generation })
      if (!operationID)
        return yield* new InvalidClaimMaterialError({ reason: "The control operation ID is not canonical." })
      const runID = DurableRun.controlRunIDFromOperation({ subject: input.subject, operationID })
      if (!runID) return yield* new InvalidClaimMaterialError({ reason: "The control run ID is not canonical." })
      const gateway: ActionGateway.Input = {
        ...input.gateway,
        kind: "control-plane",
        actionID,
        inputDigest,
        controlPlane: input.subject,
        runID,
      }
      const authorizationDigest = ActionGateway.intentDigestOf(gateway, input.authorization)
      const operation = AgentRuntime.ControlOperationSnapshot.make({
        version: 1,
        id: operationID,
        kind: input.operation.kind,
        generation,
        policyVersion: ActionGateway.POLICY_VERSION,
        claimDigest,
        authorizationDigest,
        inputDigest,
        actionID,
        resources: canonicalResources(input.gateway.resources),
        semantics: input.gateway.semantics,
        payload: input.operation.payload,
        payloadDigest,
      })
      const create: DurableRun.ControlCreateInput = {
        subject: input.subject,
        operation,
        ...input.run,
      }
      if (DurableRun.controlRunID(create) !== runID)
        return yield* new InvalidClaimMaterialError({ reason: "The control run identity changed while sealing." })
      const snapshotDigest = strictHash(create, "The frozen control run snapshot is not canonical.")
      return {
        principal,
        input,
        inputDigest,
        payloadDigest,
        actionID,
        authorizationDigest,
        claimDigest,
        baseBindingDigest,
        bindingDigest,
        generation,
        operationID,
        runID,
        snapshotDigest,
        create,
      } satisfies Derived
    })

    const verifyIndexed = Effect.fn("ControlClaimIndex.verifyIndexed")(function* (derived: Derived) {
      const row = yield* findClaim(derived.principal, derived.bindingDigest).pipe(Effect.orDie)
      if (!row)
        return yield* new ClaimConflictError({
          reason: "A durable control run exists without its immutable claim projection.",
        })
      if (
        row.base_binding_digest !== derived.baseBindingDigest ||
        row.generation !== derived.generation ||
        row.operation_id !== derived.operationID ||
        row.run_id !== derived.runID ||
        row.control_plane_id !== derived.input.subject.id ||
        row.location !== derived.input.subject.location ||
        row.project_id !== derived.input.subject.project ||
        row.actor !== derived.input.subject.actor ||
        row.claim_digest !== derived.claimDigest ||
        row.policy_version !== ActionGateway.POLICY_VERSION ||
        row.created_sequence !== 0
      )
        return yield* new ClaimConflictError({
          reason: "The immutable control claim projection does not match the derived material.",
        })
      const event = yield* database.db
        .select()
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, derived.runID), eq(EventTable.seq, 0)))
        .get()
        .pipe(Effect.orDie)
      let created: AgentRuntime.ControlRun | undefined
      let createdDigest: string | undefined
      try {
        created = event
          ? Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunCreated.data, { onExcessProperty: "error" })(
              event.data,
            ).run
          : undefined
        const encoded = created ? Schema.encodeUnknownSync(AgentRuntime.ControlRun)(created) : undefined
        createdDigest = canonicalHash(encoded)
      } catch {
        return yield* new ClaimConflictError({ reason: "The control claim creation event is malformed." })
      }
      if (
        event?.type !== EventV2.versionedType(AgentRuntime.Event.ControlRunCreated.type, 2) ||
        !createdDigest ||
        createdDigest !== row.created_run_digest ||
        !created ||
        row.operation_id !== created.operation.id ||
        row.run_id !== created.id ||
        row.control_plane_id !== created.subject.id ||
        row.location !== created.subject.location ||
        row.project_id !== created.subject.project ||
        row.actor !== created.subject.actor ||
        created.subject.principalRef !== derived.input.subject.principalRef ||
        row.canonical_request_id !== created.subject.requestID ||
        row.claim_digest !== created.operation.claimDigest ||
        row.canonical_authorization_digest !== created.operation.authorizationDigest ||
        row.canonical_action_id !== created.operation.actionID ||
        row.policy_version !== created.operation.policyVersion ||
        row.input_digest !== created.operation.inputDigest ||
        row.payload_digest !== created.operation.payloadDigest
      )
        return yield* new ClaimConflictError({ reason: "The control claim has no valid sequence-zero creation event." })
      const loaded = yield* durable
        .load(derived.runID)
        .pipe(Effect.mapError(() => new ClaimConflictError({ reason: "The indexed control run cannot be replayed." })))
      if (!("subject" in loaded.run))
        return yield* new ClaimConflictError({ reason: "The indexed aggregate is not a control run." })
      return { ...loaded, run: loaded.run } as DurableRun.ControlSnapshot
    })

    const insertAlias = Effect.fn("ControlClaimIndex.insertAlias")(function* (derived: Derived) {
      const aliasDigest = strictHash(
        aliasMaterial(derivedAliasMaterial(derived)),
        "The request alias is not canonical.",
      )
      const existing = yield* findAlias(
        derived.principal,
        derived.input.subject.id,
        derived.input.subject.requestID,
      ).pipe(Effect.orDie)
      if (existing) {
        if (
          existing.alias_digest !== aliasDigest ||
          existing.binding_digest !== derived.bindingDigest ||
          existing.presented_authorization_digest !== derived.authorizationDigest ||
          existing.presented_action_id !== derived.actionID ||
          existing.presented_snapshot_digest !== derived.snapshotDigest
        )
          return yield* new ClaimConflictError({
            reason: "The request alias is already bound to different control material.",
          })
        return
      }
      const inserted = yield* database.db
        .insert(ControlRunRequestAliasTable)
        .values({
          tenant_id: derived.principal.tenantID,
          owner_user_id: derived.principal.userID,
          alias_digest: aliasDigest,
          request_id: derived.input.subject.requestID,
          control_plane_id: derived.input.subject.id,
          binding_digest: derived.bindingDigest,
          presented_authorization_digest: derived.authorizationDigest,
          presented_action_id: derived.actionID,
          presented_snapshot_digest: derived.snapshotDigest,
        })
        .run()
        .pipe(Effect.exit)
      if (inserted._tag === "Failure") {
        // A concurrent identical request may win between our lookup and
        // insert. Never turn the unique race into a defect or silently bind
        // different material: re-read and perform the exact same comparison.
        const raced = yield* findAlias(
          derived.principal,
          derived.input.subject.id,
          derived.input.subject.requestID,
        ).pipe(Effect.orDie)
        if (
          !raced ||
          raced.alias_digest !== aliasDigest ||
          raced.binding_digest !== derived.bindingDigest ||
          raced.presented_authorization_digest !== derived.authorizationDigest ||
          raced.presented_action_id !== derived.actionID ||
          raced.presented_snapshot_digest !== derived.snapshotDigest
        )
          return yield* new ClaimConflictError({
            reason: "The concurrent request alias is bound to different control material.",
          })
      }
    })

    const claim = Effect.fn("ControlClaimIndex.claim")(function* (input: ClaimInput) {
      const principal = yield* principalNow
      return yield* database.runAsPrincipal(
        principal,
        Effect.gen(function* () {
          const derived = yield* derive(principal, input)
          const alias = yield* findAlias(principal, input.subject.id, input.subject.requestID).pipe(Effect.orDie)
          if (alias && alias.binding_digest !== derived.bindingDigest)
            return yield* new ClaimConflictError({
              reason: "The request alias is already bound to another canonical control claim.",
            })
          const indexed = yield* findClaim(principal, derived.bindingDigest).pipe(Effect.orDie)
          if (indexed) {
            const snapshot = yield* verifyIndexed(derived)
            yield* insertAlias(derived)
            return {
              kind: "existing" as const,
              snapshot,
              presentedRequestID: input.subject.requestID,
            } satisfies ClaimResult
          }
          const exit = yield* durable
            .claimControl(derived.create, {
              onCreated: ({ run, sequence }) =>
                Effect.gen(function* () {
                  if (sequence !== 0)
                    return yield* new ClaimConflictError({ reason: "ControlRunCreated must be sequence zero." })
                  const encodedRun = Schema.encodeUnknownSync(AgentRuntime.ControlRun)(run)
                  const createdRunDigest = strictHash(encodedRun, "The created control snapshot is not canonical.")
                  yield* database.db
                    .insert(ControlRunClaimTable)
                    .values({
                      tenant_id: principal.tenantID,
                      owner_user_id: principal.userID,
                      binding_digest: derived.bindingDigest,
                      base_binding_digest: derived.baseBindingDigest,
                      generation: derived.generation,
                      operation_id: derived.operationID,
                      run_id: derived.runID,
                      control_plane_id: input.subject.id,
                      location: input.subject.location,
                      project_id: input.subject.project,
                      actor: input.subject.actor,
                      canonical_request_id: input.subject.requestID,
                      claim_digest: derived.claimDigest,
                      canonical_authorization_digest: derived.authorizationDigest,
                      canonical_action_id: derived.actionID,
                      policy_version: ActionGateway.POLICY_VERSION,
                      input_digest: derived.inputDigest,
                      payload_digest: derived.payloadDigest,
                      created_run_digest: createdRunDigest,
                      created_sequence: sequence,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  yield* insertAlias(derived)
                }).pipe(Effect.orDie),
            })
            .pipe(Effect.exit)
          if (exit._tag === "Failure") {
            const won = yield* findClaim(principal, derived.bindingDigest).pipe(Effect.orDie)
            if (won) {
              const snapshot = yield* verifyIndexed(derived)
              yield* insertAlias(derived)
              return {
                kind: "existing" as const,
                snapshot,
                presentedRequestID: input.subject.requestID,
              } satisfies ClaimResult
            }
            return yield* new ClaimConflictError({
              reason: `The durable control claim failed before its index committed: ${Cause.pretty(exit.cause)}`,
            })
          }
          const claimed = exit.value
          const snapshot = yield* verifyIndexed(derived)
          if (claimed.kind === "existing") yield* insertAlias(derived)
          return { kind: claimed.kind, snapshot, presentedRequestID: input.subject.requestID } satisfies ClaimResult
        }),
      )
    })

    const lookup = Effect.fn("ControlClaimIndex.lookup")(function* (input: {
      readonly controlPlaneID: AgentRuntime.ControlPlaneID
      readonly requestID: AgentRuntime.ControlPlaneRequestID
    }) {
      const principal = yield* principalNow
      return yield* database.runAsPrincipal(
        principal,
        Effect.gen(function* () {
          const alias = yield* findAlias(principal, input.controlPlaneID, input.requestID).pipe(Effect.orDie)
          if (!alias) return yield* new NotFoundError({ requestID: input.requestID })
          const expectedAliasDigest = strictHash(
            aliasMaterial({
              principal,
              controlPlaneID: AgentRuntime.ControlPlaneID.make(alias.control_plane_id),
              requestID: AgentRuntime.ControlPlaneRequestID.make(alias.request_id),
              bindingDigest: alias.binding_digest,
              authorizationDigest: alias.presented_authorization_digest,
              actionID: AgentRuntime.ActionID.make(alias.presented_action_id),
              snapshotDigest: alias.presented_snapshot_digest,
            }),
            "The indexed request alias is not canonical.",
          )
          if (alias.alias_digest !== expectedAliasDigest)
            return yield* new ClaimConflictError({
              reason: "The request alias integrity binding does not match its projection.",
            })
          const claim = yield* findClaim(principal, alias.binding_digest).pipe(Effect.orDie)
          if (!claim || claim.created_sequence !== 0)
            return yield* new ClaimConflictError({
              reason: "The request alias points to an invalid control claim projection.",
            })
          const event = yield* database.db
            .select()
            .from(EventTable)
            .where(and(eq(EventTable.aggregate_id, claim.run_id), eq(EventTable.seq, 0)))
            .get()
            .pipe(Effect.orDie)
          let created: AgentRuntime.ControlRun | undefined
          let createdDigest: string | undefined
          try {
            created = event
              ? Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunCreated.data, { onExcessProperty: "error" })(
                  event.data,
                ).run
              : undefined
            createdDigest = created
              ? canonicalHash(Schema.encodeUnknownSync(AgentRuntime.ControlRun)(created))
              : undefined
          } catch {
            return yield* new ClaimConflictError({ reason: "The indexed creation event is malformed." })
          }
          const expectedBase = created
            ? strictHash(
                {
                  domain: "arforge.control-claim-base/v1",
                  version: 1,
                  principal: { tenantID: principal.tenantID, userID: principal.userID },
                  subject: fixedSubject(created.subject),
                  claimDigest: created.operation.claimDigest,
                },
                "The indexed control claim base is not canonical.",
              )
            : undefined
          const expectedBinding = expectedBase
            ? strictHash(
                {
                  domain: "arforge.control-claim-binding/v1",
                  version: 1,
                  baseBindingDigest: expectedBase,
                  generation: claim.generation,
                },
                "The indexed control claim binding is not canonical.",
              )
            : undefined
          const expectedOperation = created
            ? DurableRun.controlOperationID({
                subject: created.subject,
                claimDigest: created.operation.claimDigest,
                generation: created.operation.generation,
              })
            : undefined
          const snapshot = yield* durable
            .load(AgentRuntime.RunID.make(claim.run_id))
            .pipe(
              Effect.mapError(() => new ClaimConflictError({ reason: "The indexed control run cannot be replayed." })),
            )
          if (
            event?.type !== EventV2.versionedType(AgentRuntime.Event.ControlRunCreated.type, 2) ||
            !created ||
            !createdDigest ||
            createdDigest !== claim.created_run_digest ||
            claim.base_binding_digest !== expectedBase ||
            claim.binding_digest !== expectedBinding ||
            claim.generation !== created.operation.generation ||
            claim.operation_id !== expectedOperation ||
            claim.run_id !== created.id ||
            !("subject" in snapshot.run) ||
            snapshot.run.subject.id !== input.controlPlaneID ||
            created.subject.requestID !== claim.canonical_request_id ||
            created.operation.id !== claim.operation_id ||
            created.operation.claimDigest !== claim.claim_digest ||
            created.operation.authorizationDigest !== claim.canonical_authorization_digest ||
            created.operation.actionID !== claim.canonical_action_id ||
            created.operation.policyVersion !== claim.policy_version ||
            created.operation.inputDigest !== claim.input_digest ||
            created.operation.payloadDigest !== claim.payload_digest ||
            created.subject.id !== claim.control_plane_id ||
            created.subject.location !== claim.location ||
            created.subject.project !== claim.project_id ||
            created.subject.actor !== claim.actor ||
            created.subject.principalRef !== ControlPrincipal.principalRef(principal)
          )
            return yield* new ClaimConflictError({
              reason: "The durable control run does not match its request projection.",
            })
          return { ...snapshot, run: snapshot.run } as DurableRun.ControlSnapshot
        }),
      )
    })

    return Service.of({ claim, lookup })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, DurableRun.node] })
