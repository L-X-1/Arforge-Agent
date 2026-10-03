import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import {
  ExperienceGraphV2,
  InvalidRelationError,
  RelationConflictError,
  type CreateRelationInput,
} from "@arforge-ai/core/experience-graph"
import { testEffect } from "./lib/effect"

const digest = (letter: string) => letter.repeat(64)
const base: CreateRelationInput = {
  sourceKind: "experience_candidate",
  sourceID: "exc_release_checks",
  sourceDigest: digest("a"),
  targetKind: "scope",
  targetID: "scope_workspace_release",
  targetDigest: digest("b"),
  relation: "applies_to",
  evidenceIDs: ["evd_relation_initial"],
  policyVersion: "experience-policy-v1",
}

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ExperienceGraphV2.node]), []))

describe("ExperienceGraph", () => {
  it.effect("persists six typed relations and makes identical writes idempotent", () =>
    Effect.gen(function* () {
      const graph = yield* ExperienceGraphV2.Service
      const first = yield* graph.create(base)
      const second = yield* graph.create({ ...base, evidenceIDs: ["evd_relation_initial"] })
      expect(second).toEqual(first)

      const relations = [
        base,
        {
          ...base,
          targetID: "exc_contradiction",
          targetKind: "experience_candidate" as const,
          relation: "contradicts" as const,
        },
        {
          ...base,
          targetID: "exc_superseded",
          targetKind: "experience_candidate" as const,
          relation: "supersedes" as const,
        },
        { ...base, targetID: "exp_origin", targetKind: "experience" as const, relation: "derived_from" as const },
        { ...base, targetID: "scope_failure", relation: "failed_under" as const },
        { ...base, targetID: "skill_release", targetKind: "skill" as const, relation: "supports_skill" as const },
      ]
      for (const relation of relations.slice(1)) yield* graph.create(relation)

      expect(yield* graph.list({ sourceID: base.sourceID, limit: 10 })).toHaveLength(6)
      expect(yield* graph.list({ relation: "supports_skill" })).toMatchObject([
        { targetKind: "skill", targetID: "skill_release", relation: "supports_skill" },
      ])
      expect(yield* graph.get(first.id)).toEqual(first)
    }),
  )

  it.effect("rejects digest drift for an existing immutable edge", () =>
    Effect.gen(function* () {
      const graph = yield* ExperienceGraphV2.Service
      const first = yield* graph.create(base)
      const error = yield* graph.create({ ...base, targetDigest: digest("c") }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(RelationConflictError)
      if (!(error instanceof RelationConflictError)) throw new Error("expected an immutable relation conflict")
      expect(error.relationID).toBe(first.id)
    }),
  )

  it.effect("fails closed on invalid evidence, digest, and relation endpoints", () =>
    Effect.gen(function* () {
      const graph = yield* ExperienceGraphV2.Service
      const invalidEvidence = yield* graph.create({ ...base, evidenceIDs: [] }).pipe(Effect.flip)
      expect(invalidEvidence).toBeInstanceOf(InvalidRelationError)
      const invalidDigest = yield* graph.create({ ...base, sourceDigest: "not-a-digest" }).pipe(Effect.flip)
      expect(invalidDigest).toBeInstanceOf(InvalidRelationError)
      const invalidSkill = yield* graph
        .create({ ...base, relation: "supports_skill", targetKind: "scope" })
        .pipe(Effect.flip)
      expect(invalidSkill).toBeInstanceOf(InvalidRelationError)
    }),
  )
})
