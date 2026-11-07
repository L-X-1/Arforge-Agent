// Test-only SQLite owner. No server/model/service processes or user profile.
import { basename, dirname, isAbsolute, join } from "node:path"
import { realpath } from "node:fs/promises"

const [databasePath, mode] = Bun.argv.slice(2)
if (!databasePath || !isAbsolute(databasePath) || !["seed", "read"].includes(mode ?? ""))
  throw new Error("Invalid Stage7 restart fixture arguments")
const root = await realpath(dirname(databasePath))
if (!/^arforge-core-test-[A-Za-z0-9]+$/.test(basename(root)) ||
    join(root, "evidence-resolver.sqlite") !== databasePath)
  throw new Error("Stage7 restart database is outside its exact owned temporary root")
// Child-local fixture configuration before importing the database dialect.
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = root
const input = JSON.parse(await Bun.stdin.text()) as {
  identity: { tenantID: string; userID: string; actor: string }
  record: unknown
  recordDigest: string
  corruptEvidenceID: string
}
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { Effect, Layer, Schema } = await import("effect")
const { Database } = await import("@arforge-ai/core/database/database")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { ExperienceStoreV1 } = await import("@arforge-ai/core/experience-store")
const { ExperienceEvidenceTable } = await import("@arforge-ai/core/experience-store/sql")
const { DurableAction } = await import("@arforge-ai/core/runtime/durable-action")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const RuntimeEvaluation = await import("@arforge-ai/core/runtime/evaluation")
const { LearningV2 } = await import("@arforge-ai/core/learning")
const { EventV2 } = await import("@arforge-ai/core/event")
const { Location } = await import("@arforge-ai/core/location")
const { Project } = await import("@arforge-ai/core/project")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { canonicalHash } = await import("@arforge-ai/core/util/canonical-hash")
const evidence = Schema.decodeUnknownSync(AgentRuntime.Evidence)(input.record)
if (canonicalHash(input.record) !== input.recordDigest) throw new Error("Stage7 fixture digest mismatch")
const corruptEvidenceID = AgentRuntime.EvidenceID.make(input.corruptEvidenceID)
if (mode === "seed") {
  const seedLayer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
    [Database.node, Database.layerFromPath(databasePath)],
  ])
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ExperienceEvidenceTable).values({
      tenant_id: input.identity.tenantID, owner_user_id: input.identity.userID,
      id: evidence.id, run_id: evidence.runID!, action_id: evidence.actionID!,
      observation_id: evidence.observationIDs![0]!, record_digest: input.recordDigest,
      record: input.record, time_created: 1_725_000_000_000, time_updated: 1_725_000_000_000,
    }).run().pipe(Effect.orDie)
    yield* db.insert(ExperienceEvidenceTable).values({
      tenant_id: input.identity.tenantID, owner_user_id: input.identity.userID,
      id: corruptEvidenceID, run_id: evidence.runID!, action_id: evidence.actionID!,
      observation_id: evidence.observationIDs![0]!,
      // Preserve the deliberate primary-ID/digest corruption negative control.
      record_digest: "0".repeat(64), record: input.record,
      time_created: 1_725_000_000_001, time_updated: 1_725_000_000_001,
    }).run().pipe(Effect.orDie)
  }).pipe(Effect.provide(seedLayer))))
}
const directory = AbsolutePath.make("C:/workspaces/stage7-lifecycle")
const current = Layer.succeed(Location.Service, Location.Service.of({
  directory, project: { id: Project.ID.global, directory },
}))
const readerLayer = AppNodeBuilder.build(LayerNode.group([
  Database.node, EventV2.node, DurableAction.globalNode, DurableRun.globalNode,
  RuntimeEvaluation.node, LearningV2.node, ExperienceStoreV1.node,
]), [[Database.node, Database.layerFromPath(databasePath)], [Location.node, current]])
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const experience = yield* ExperienceStoreV1.Service
  const read = yield* experience.resolveEvidenceIDs(input.identity, [evidence.id])
  const facts = yield* experience.resolveEvidenceFacts(input.identity, [evidence.id])
  const foreign = yield* experience.resolveEvidenceIDs({ ...input.identity, userID: "usr_stage7_other" }, [evidence.id])
  const corruption = yield* experience.resolveEvidenceIDs(input.identity, [corruptEvidenceID]).pipe(Effect.flip)
  return { read, facts, foreign, corruptionTag: corruption._tag }
}).pipe(Effect.provide(readerLayer))))
// End naturally: the parent awaits process exit (and thus all native file handles)
// before another owner or removal. No process.exit, kill, retry or cleanup suppression.
console.log(JSON.stringify({ pid: process.pid, ...result }))
