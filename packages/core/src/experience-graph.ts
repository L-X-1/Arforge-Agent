export * as ExperienceGraphV2 from "./experience-graph"

import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { canonicalHash } from "./util/canonical-hash"
import { ExperienceGraphRelationTable } from "./experience-graph/sql"

export const RelationKind = Schema.Literals([
  "applies_to",
  "contradicts",
  "supersedes",
  "derived_from",
  "failed_under",
  "supports_skill",
])
export type RelationKind = typeof RelationKind.Type

export const NodeKind = Schema.Literals(["experience_candidate", "experience", "skill", "scope"])
export type NodeKind = typeof NodeKind.Type

export interface RelationRecord {
  readonly id: string
  readonly sourceKind: NodeKind
  readonly sourceID: string
  readonly sourceDigest: string
  readonly targetKind: NodeKind
  readonly targetID: string
  readonly targetDigest: string
  readonly relation: RelationKind
  readonly evidenceIDs: ReadonlyArray<string>
  readonly policyVersion: string
  readonly digest: string
  readonly createdAt: number
}

export interface CreateRelationInput {
  readonly sourceKind: NodeKind
  readonly sourceID: string
  readonly sourceDigest: string
  readonly targetKind: NodeKind
  readonly targetID: string
  readonly targetDigest: string
  readonly relation: RelationKind
  readonly evidenceIDs: ReadonlyArray<string>
  readonly policyVersion: string
}

export interface ListRelationsInput {
  readonly sourceID?: string
  readonly targetID?: string
  readonly relation?: RelationKind
  readonly limit?: number
}

export interface Interface {
  readonly create: (
    input: CreateRelationInput,
  ) => Effect.Effect<RelationRecord, InvalidRelationError | RelationConflictError>
  readonly get: (id: string) => Effect.Effect<RelationRecord | undefined>
  readonly list: (input?: ListRelationsInput) => Effect.Effect<ReadonlyArray<RelationRecord>>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ExperienceGraph") {}

export class InvalidRelationError extends Schema.TaggedErrorClass<InvalidRelationError>()(
  "ExperienceGraph.InvalidRelationError",
  { reason: Schema.String },
) {}

export class RelationConflictError extends Schema.TaggedErrorClass<RelationConflictError>()(
  "ExperienceGraph.RelationConflictError",
  { relationID: Schema.String },
) {}

type NormalizedRelation = Omit<CreateRelationInput, "evidenceIDs"> & { readonly evidenceIDs: ReadonlyArray<string> }

const digestPattern = /^[a-f0-9]{64}$/i

const bounded = (value: string, field: string, maximum: number) => {
  const normalized = value.trim().slice(0, maximum)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

const normalize = (input: CreateRelationInput): NormalizedRelation => {
  const sourceID = bounded(input.sourceID, "sourceID", 256)
  const targetID = bounded(input.targetID, "targetID", 256)
  if (sourceID === targetID && input.sourceKind === input.targetKind)
    throw new Error("source and target must be different graph nodes")
  if (!digestPattern.test(input.sourceDigest) || !digestPattern.test(input.targetDigest))
    throw new Error("sourceDigest and targetDigest must be 64-character immutable digests")
  if (input.relation === "supports_skill" && input.targetKind !== "skill")
    throw new Error("supports_skill relations must target a skill node")
  const evidenceIDs = [...new Set(input.evidenceIDs.map((id) => id.trim()).filter(Boolean))]
  if (evidenceIDs.length === 0 || evidenceIDs.some((id) => !id.startsWith("evd_")))
    throw new Error("at least one immutable evidence ID is required")
  return {
    sourceKind: input.sourceKind,
    sourceID,
    sourceDigest: input.sourceDigest.toLowerCase(),
    targetKind: input.targetKind,
    targetID,
    targetDigest: input.targetDigest.toLowerCase(),
    relation: input.relation,
    evidenceIDs,
    policyVersion: bounded(input.policyVersion, "policyVersion", 120),
  }
}

const relationDigest = (input: NormalizedRelation) => canonicalHash(input)

const relationID = (digest: string) => `egr_${digest.slice(0, 24)}`

const toRecord = (row: typeof ExperienceGraphRelationTable.$inferSelect): RelationRecord => ({
  id: row.id,
  sourceKind: row.source_kind,
  sourceID: row.source_id,
  sourceDigest: row.source_digest,
  targetKind: row.target_kind,
  targetID: row.target_id,
  targetDigest: row.target_digest,
  relation: row.relation_kind,
  evidenceIDs: row.evidence_ids,
  policyVersion: row.policy_version,
  digest: row.digest,
  createdAt: row.time_created,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const scope = Effect.fn("ExperienceGraph.scope")(function* () {
      const principal = yield* Database.CurrentPrincipal
      return {
        tenantID: principal?.tenantID ?? "ten_local",
        userID: principal?.userID ?? "usr_local",
      }
    })

    const create: Interface["create"] = Effect.fn("ExperienceGraph.create")(function* (input) {
      let normalized: NormalizedRelation
      try {
        normalized = normalize(input)
      } catch (error) {
        return yield* new InvalidRelationError({ reason: error instanceof Error ? error.message : String(error) })
      }
      const digest = relationDigest(normalized)
      if (!digest) return yield* new InvalidRelationError({ reason: "relation is not canonicalizable" })
      const id = relationID(digest)
      const principal = yield* scope()
      const identity = and(
        eq(ExperienceGraphRelationTable.tenant_id, principal.tenantID),
        eq(ExperienceGraphRelationTable.owner_user_id, principal.userID),
        eq(ExperienceGraphRelationTable.source_kind, normalized.sourceKind),
        eq(ExperienceGraphRelationTable.source_id, normalized.sourceID),
        eq(ExperienceGraphRelationTable.target_kind, normalized.targetKind),
        eq(ExperienceGraphRelationTable.target_id, normalized.targetID),
        eq(ExperienceGraphRelationTable.relation_kind, normalized.relation),
      )
      const existing = yield* db.select().from(ExperienceGraphRelationTable).where(identity).get().pipe(Effect.orDie)
      if (existing) {
        if (existing.digest !== digest) return yield* new RelationConflictError({ relationID: existing.id })
        return toRecord(existing)
      }
      const inserted = yield* db
        .insert(ExperienceGraphRelationTable)
        .values({
          tenant_id: principal.tenantID,
          owner_user_id: principal.userID,
          id,
          source_kind: normalized.sourceKind,
          source_id: normalized.sourceID,
          source_digest: normalized.sourceDigest,
          target_kind: normalized.targetKind,
          target_id: normalized.targetID,
          target_digest: normalized.targetDigest,
          relation_kind: normalized.relation,
          evidence_ids: normalized.evidenceIDs,
          policy_version: normalized.policyVersion,
          digest,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (inserted) return toRecord(inserted)
      const raced = yield* db.select().from(ExperienceGraphRelationTable).where(identity).get().pipe(Effect.orDie)
      if (!raced) return yield* new InvalidRelationError({ reason: "relation insert was not observable" })
      if (raced.digest !== digest) return yield* new RelationConflictError({ relationID: raced.id })
      return toRecord(raced)
    })

    const get: Interface["get"] = Effect.fn("ExperienceGraph.get")(function* (id) {
      const principal = yield* scope()
      const row = yield* db
        .select()
        .from(ExperienceGraphRelationTable)
        .where(
          and(
            eq(ExperienceGraphRelationTable.tenant_id, principal.tenantID),
            eq(ExperienceGraphRelationTable.owner_user_id, principal.userID),
            eq(ExperienceGraphRelationTable.id, id),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? toRecord(row) : undefined
    })

    const list: Interface["list"] = Effect.fn("ExperienceGraph.list")(function* (input = {}) {
      const principal = yield* scope()
      const filters = [
        eq(ExperienceGraphRelationTable.tenant_id, principal.tenantID),
        eq(ExperienceGraphRelationTable.owner_user_id, principal.userID),
        input.sourceID ? eq(ExperienceGraphRelationTable.source_id, input.sourceID) : undefined,
        input.targetID ? eq(ExperienceGraphRelationTable.target_id, input.targetID) : undefined,
        input.relation ? eq(ExperienceGraphRelationTable.relation_kind, input.relation) : undefined,
      ].filter((value): value is NonNullable<typeof value> => value !== undefined)
      const rows = yield* db
        .select()
        .from(ExperienceGraphRelationTable)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(ExperienceGraphRelationTable.time_created))
        .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toRecord)
    })

    return Service.of({ create, get, list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
