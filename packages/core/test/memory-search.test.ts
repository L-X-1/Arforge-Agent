import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { Location } from "@arforge-ai/core/location"
import { MemoryV2 } from "@arforge-ai/core/memory"
import * as MemoryKernel from "@arforge-ai/core/memory-kernel"
import { MemoryCandidateTable } from "@arforge-ai/core/memory/sql"
import { Project } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("C:/workspaces/memory-search")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryKernel.node, MemoryV2.node]), [[Location.node, current]]),
)

describe("Memory literal substring search", () => {
  const cases = [
    {
      name: "underscore is literal rather than a single-character wildcard",
      query: "G12_RELEASE",
      content: "G12_RELEASE requires explicit verification evidence before publishing.",
      decoy: "Astronomy reports schedule G12xRELEASE after observing distant galaxies.",
    },
    {
      name: "percent is literal rather than a variable-length wildcard",
      query: "90% complete",
      content: "The review dashboard displays 90% complete after checking the evidence.",
      decoy: "The unrelated archive contains 90 completely different historical accounts.",
    },
    {
      name: "backslashes are literal path characters",
      query: String.raw`C:\review\notes`,
      content: String.raw`Store the signed checklist at C:\review\notes before the release.`,
      decoy: "The astronomy archive labels its indexing group C:reviewnotes for convenience.",
    },
    {
      name: "mixed backslash percent and underscore remain literal",
      query: String.raw`C:\review\90%_done`,
      content: String.raw`The reviewed artifact lives at C:\review\90%_done and needs a signature.`,
      decoy: "A separate sample collection uses C:review90xxdone for unreviewed observations.",
    },
    {
      name: "ordinary text keeps substring matching",
      query: "verification evidence",
      content: "Publish only after collecting explicit verification evidence for the release.",
      decoy: "The gallery catalogue describes distant galaxies and telescope exposure settings.",
    },
    {
      name: "quotes and SQL-looking text remain bound data",
      query: "%' OR 1=1 --",
      content: "Document the literal example %' OR 1=1 -- as untrusted quoted material.",
      decoy: "The ordinary release checklist requires independent approval and signed evidence.",
    },
  ]

  for (const entry of cases) {
    it.effect(entry.name, () =>
      Effect.gen(function* () {
        const memory = yield* MemoryV2.Service
        const created = yield* memory.create({ content: MemoryV2.Content.make(entry.content), source: "user" })
        yield* memory.create({ content: MemoryV2.Content.make(entry.decoy), source: "user" })
        const result = yield* memory.list({ query: entry.query, includeGlobal: false })
        expect(result.items.map((item) => item.id)).toEqual([created.id])
        expect(result.count).toBe(1)
        expect(result.total).toBe(1)
      }),
    )
  }

  it.effect("keeps the existing workspace/global visibility boundary", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const database = yield* Database.Service
      const local = yield* memory.create({
        content: MemoryV2.Content.make("Boundary needle local release verification."),
        source: "user",
      })
      const global = yield* memory.create({
        content: MemoryV2.Content.make("Boundary needle global typography preference."),
        source: "user",
        scope: "global",
      })
      const otherDirectory = AbsolutePath.make("C:/workspaces/memory-search-other")
      const otherLocation = Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: otherDirectory,
          project: { id: Project.ID.global, directory: otherDirectory },
        }),
      )
      const other = yield* Effect.flatMap(MemoryV2.Service, (other) =>
        other.create({
          content: MemoryV2.Content.make("Boundary needle foreign workspace astronomy records."),
          source: "user",
        }),
      ).pipe(
        Effect.provide(
          Layer.fresh(
            AppNodeBuilder.build(MemoryV2.node, [
              [Location.node, otherLocation],
              [Database.node, Layer.succeed(Database.Service, database)],
            ]),
          ),
        ),
      )
      expect(other.workspacePath).toBe("c:/workspaces/memory-search-other")
      expect(
        (yield* memory.list({ query: "Boundary needle", includeGlobal: false })).items.map((item) => item.id),
      ).toEqual([local.id])
      expect((yield* memory.list({ query: "Boundary needle" })).items.map((item) => item.id).sort()).toEqual(
        [local.id, global.id].sort(),
      )
      expect((yield* memory.list({ query: "Boundary needle", source: "imported" })).items).toEqual([])
      expect((yield* memory.list({ query: "Boundary needle", type: MemoryV2.Type.make("preference") })).items).toEqual(
        [],
      )
      expect(
        (yield* memory.list({ query: "Boundary needle", minimumImportance: MemoryV2.Importance.make(5) })).items,
      ).toEqual([])
    }),
  )

  it.effect("preserves exact candidate ownership without imposing user-private workspace search", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryV2.Service
      const kernel = yield* MemoryKernel.Service
      const database = yield* Database.Service
      const owner = { tenantID: "ten_search_owner", userID: "usr_search_owner" }
      const content = "Owner privacy needle requires explicit review before publishing."
      const activated = yield* Database.principalContext(
        owner,
        Effect.gen(function* () {
          yield* memory.extract("Please remember: " + content)
          const candidates = yield* database.db.select().from(MemoryCandidateTable).all().pipe(Effect.orDie)
          const candidate = candidates.find((item) => item.content === content)
          expect(candidate).toBeDefined()
          if (!candidate) throw new Error("Normal extraction did not create the candidate")
          yield* kernel.approve({
            candidateID: candidate.id,
            actor: { kind: "user" },
            policyVersion: MemoryKernel.POLICY_VERSION,
          })
          const active = yield* kernel.promote({
            candidateID: candidate.id,
            actor: { kind: "user" },
            policyVersion: MemoryKernel.POLICY_VERSION,
            evidenceIDs: [],
          })
          return { active, candidateID: candidate.id }
        }),
      )
      const own = yield* Database.principalContext(
        owner,
        memory.list({ query: "privacy needle", includeGlobal: false }),
      )
      expect(own.items.map((item) => item.id)).toEqual([activated.active.id])
      // Workspace inventory is shared; exact user ownership belongs to candidate review.
      const shared = yield* Database.principalContext(
        { tenantID: owner.tenantID, userID: "usr_search_foreign" },
        memory.list({ query: "privacy needle", includeGlobal: false }),
      )
      expect(shared.items.map((item) => item.id)).toEqual([activated.active.id])
      for (const foreign of [
        { tenantID: owner.tenantID, userID: "usr_search_foreign" },
        { tenantID: "ten_search_foreign", userID: owner.userID },
        Database.DefaultLocalPrincipal,
      ]) {
        const denied = yield* Database.principalContext(
          foreign,
          Effect.flip(kernel.reviewCandidate(activated.candidateID)),
        )
        expect(denied).toBeInstanceOf(MemoryKernel.GateError)
      }
    }),
  )
})
