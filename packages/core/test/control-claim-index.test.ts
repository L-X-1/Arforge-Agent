import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { ControlRunClaimTable, ControlRunRequestAliasTable } from "@arforge-ai/core/runtime/control-claim-index.sql"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, ControlClaimIndex.node]),
)
const it = testEffect(runtimeLayer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: 60_000,
  maxCostMicros: 0,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const claimInput = (
  request = "a",
  principal: ControlClaimIndex.Principal = { tenantID: "ten_claim", userID: "usr_claim" },
): ControlClaimIndex.ClaimInput => ({
  subject: AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(principal, {
      location: "/claim-index",
      projectID: ProjectID.global,
      action: "worktree.create",
    }),
    location: AbsolutePath.make("/claim-index"),
    project: ProjectID.global,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(principal),
    requestID: AgentRuntime.ControlPlaneRequestID.make(`cpr_claim-index-${request}`),
  }),
  gateway: {
    kind: "control-plane",
    name: "worktree.create",
    resources: ["git", "filesystem:/claim-index"],
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L3",
      authority: "human",
      idempotency: "idempotent",
      retryability: "safe",
      reversibility: "irreversible",
      filesystemScope: ["/claim-index"],
      networkScope: [],
      secretScope: [],
      externalServices: ["git"],
      expectedArtifacts: [],
      successCriteria: ["created"],
    }),
    reasonSummary: "create control worktree",
  },
  authorization: {
    requests: [{ action: "worktree.create", resources: ["filesystem:/claim-index"] }],
    metadata: { operation: "worktree.create" },
  },
  input: { name: "claim-index" },
  operation: { kind: "worktree.create", payload: { name: "claim-index" } },
  run: {
    initiator: "user",
    authority: "human",
    riskTier: "L3",
    reasonSummary: "create control worktree",
    budget,
    traceID: "claim-index-trace",
    visibility: "details",
  },
})

const asPrincipal = <A, E, R>(principal: ControlClaimIndex.Principal, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))

describe("ControlClaimIndex", () => {
  it.effect("claims once and appends a second request as a non-authoritative alias", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const principal = { tenantID: "ten_claim", userID: "usr_claim" }
      const first = yield* asPrincipal(principal, service.claim(claimInput("first", principal)))
      const second = yield* asPrincipal(principal, service.claim(claimInput("second", principal)))

      expect(first.kind).toBe("claimed")
      expect(second.kind).toBe("existing")
      expect(second.snapshot.run.id).toBe(first.snapshot.run.id)
      expect(second.snapshot.run.subject.requestID).toBe(first.snapshot.run.subject.requestID)
      const loaded = yield* asPrincipal(
        principal,
        service.lookup({
          controlPlaneID: claimInput("ignored", principal).subject.id,
          requestID: claimInput("second", principal).subject.requestID,
        }),
      )
      expect(loaded.run.id).toBe(first.snapshot.run.id)
    }),
  )

  it.effect("aliases request-bound execution payloads through frozen claim material", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const principal = { tenantID: "ten_snapshot_alias", userID: "usr_snapshot_alias" }
      const first = claimInput("first", principal)
      const firstClaimMaterial = {
        input: first.input,
        payload: { kind: "create", target: "/managed/worktree", branch: "feature" },
      }
      const second = claimInput("second", principal)
      const firstPresented = {
        ...first,
        claimMaterial: firstClaimMaterial,
        operation: { kind: first.operation.kind, payload: { name: "claim-index", requestID: "first" } },
      }
      const secondPresented = {
        ...second,
        claimMaterial: firstClaimMaterial,
        operation: { kind: second.operation.kind, payload: { name: "claim-index", requestID: "second" } },
      }
      const claimed = yield* asPrincipal(principal, service.claim(firstPresented))
      const aliased = yield* asPrincipal(principal, service.claim(secondPresented))
      expect(claimed.kind).toBe("claimed")
      expect(aliased.kind).toBe("existing")
      expect(aliased.snapshot.run.id).toBe(claimed.snapshot.run.id)
      expect(aliased.snapshot.run.subject.requestID).toBe(first.subject.requestID)
    }),
  )

  it.effect("keeps request aliases tenant/owner scoped and requires a dynamic principal", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const one = { tenantID: "ten_one", userID: "usr_one" }
      const two = { tenantID: "ten_two", userID: "usr_two" }
      const first = yield* asPrincipal(one, service.claim(claimInput("shared", one)))
      const second = yield* asPrincipal(two, service.claim(claimInput("shared", two)))
      expect(first.kind).toBe("claimed")
      expect(second.kind).toBe("claimed")
      expect(second.snapshot.run.id).not.toBe(first.snapshot.run.id)
      const missing = yield* service.claim(claimInput("missing")).pipe(Effect.exit)
      expect(String(missing)).toContain("ControlClaimIndex.MissingPrincipalError")
    }),
  )

  it.effect("rejects a forged control-plane ID even when principalRef is correct", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const principal = { tenantID: "ten_subject_id", userID: "usr_subject_id" }
      const forged: ControlClaimIndex.ClaimInput = {
        ...claimInput("forged", principal),
        subject: {
          ...claimInput("forged", principal).subject,
          id: AgentRuntime.ControlPlaneID.make("ctl_forged_subject_id"),
        },
      }
      const result = yield* asPrincipal(principal, service.claim(forged)).pipe(Effect.exit)
      expect(String(result)).toContain("ControlClaimIndex.InvalidClaimMaterialError")
    }),
  )

  it.effect("refuses to rebind a request alias to different frozen material", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const principal = { tenantID: "ten_conflict", userID: "usr_conflict" }
      const original = claimInput("same", principal)
      yield* asPrincipal(principal, service.claim(original))
      const changed: ControlClaimIndex.ClaimInput = {
        ...original,
        operation: { kind: "worktree.create", payload: { name: "different" } },
      }
      const conflict = yield* asPrincipal(principal, service.claim(changed)).pipe(Effect.exit)
      expect(String(conflict)).toContain("ControlClaimIndex.ClaimConflictError")
    }),
  )

  it.effect("treats generation zero as the single immutable binding and serializes identical aliases", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_generation", userID: "usr_generation" }
      const input = claimInput("same", principal)
      const [left, right] = yield* Effect.all(
        [asPrincipal(principal, service.claim(input)), asPrincipal(principal, service.claim(input))],
        { concurrency: "unbounded" },
      )
      expect([left.kind, right.kind].sort()).toEqual(["claimed", "existing"])
      expect(left.snapshot.run.id).toBe(right.snapshot.run.id)
      const rows = yield* database.db
        .select()
        .from(ControlRunClaimTable)
        .where(eq(ControlRunClaimTable.run_id, left.snapshot.run.id))
        .all()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.generation).toBe(0)
    }),
  )

  it.effect("fails closed on lookup when the immutable seq0 projection digest is tampered", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_seq0", userID: "usr_seq0" }
      const claimed = yield* asPrincipal(principal, service.claim(claimInput("first", principal)))
      yield* database.db
        .update(ControlRunClaimTable)
        .set({ created_run_digest: "tampered" })
        .where(eq(ControlRunClaimTable.run_id, claimed.snapshot.run.id))
        .run()
      const result = yield* asPrincipal(
        principal,
        service.lookup({
          controlPlaneID: claimed.snapshot.run.subject.id,
          requestID: claimed.snapshot.run.subject.requestID,
        }),
      ).pipe(Effect.exit)
      expect(String(result)).toContain("ControlClaimIndex.ClaimConflictError")

      // The durable event has not changed: failure is specifically the index
      // projection's seq0 digest mismatch, not a malformed run history.
      const event = yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, claimed.snapshot.run.id))
        .get()
      expect(event?.type).toBe(EventV2.versionedType(AgentRuntime.Event.ControlRunCreated.type, 2))
    }),
  )

  it.effect("fails closed when a syntactically valid seq0 creation event is altered", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_event", userID: "usr_event" }
      const claimed = yield* asPrincipal(principal, service.claim(claimInput("first", principal)))
      const event = yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, claimed.snapshot.run.id))
        .get()
      if (!event || typeof event.data.run !== "object" || event.data.run === null)
        return yield* Effect.die("Missing control creation event")
      yield* database.db
        .update(EventTable)
        .set({ data: { ...event.data, run: { ...event.data.run, reasonSummary: "tampered" } } })
        .where(eq(EventTable.id, event.id))
        .run()
      const result = yield* asPrincipal(
        principal,
        service.lookup({
          controlPlaneID: claimed.snapshot.run.subject.id,
          requestID: claimed.snapshot.run.subject.requestID,
        }),
      ).pipe(Effect.exit)
      expect(String(result)).toContain("ControlClaimIndex.ClaimConflictError")
    }),
  )

  it.effect("fails closed when a request alias is redirected to another canonical claim", () =>
    Effect.gen(function* () {
      const service = yield* ControlClaimIndex.Service
      const database = yield* Database.Service
      const principal = { tenantID: "ten_alias_integrity", userID: "usr_alias_integrity" }
      const firstInput = claimInput("alias-first", principal)
      const secondBase = claimInput("alias-second", principal)
      const secondInput: ControlClaimIndex.ClaimInput = {
        ...secondBase,
        input: { name: "another-claim" },
        operation: { kind: "worktree.create", payload: { name: "another-claim" } },
      }
      const first = yield* asPrincipal(principal, service.claim(firstInput))
      const second = yield* asPrincipal(principal, service.claim(secondInput))
      const secondRow = yield* database.db
        .select({ bindingDigest: ControlRunClaimTable.binding_digest })
        .from(ControlRunClaimTable)
        .where(eq(ControlRunClaimTable.run_id, second.snapshot.run.id))
        .get()
      if (!secondRow) return yield* Effect.die("Missing second canonical claim")

      // The foreign key still points at a real claim. The alias integrity
      // digest must make this single-field projection corruption observable.
      yield* database.db
        .update(ControlRunRequestAliasTable)
        .set({ binding_digest: secondRow.bindingDigest })
        .where(eq(ControlRunRequestAliasTable.request_id, firstInput.subject.requestID))
        .run()

      const result = yield* asPrincipal(
        principal,
        service.lookup({
          controlPlaneID: first.snapshot.run.subject.id,
          requestID: firstInput.subject.requestID,
        }),
      ).pipe(Effect.exit)
      expect(String(result)).toContain("ControlClaimIndex.ClaimConflictError")
    }),
  )
})
