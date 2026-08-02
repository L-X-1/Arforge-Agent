import { count } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import * as LayerNode from "../src/effect/layer-node"
import { LearningOutcomeTable, LearningPatternTable } from "../src/learning/sql"
import { MemoryTable } from "../src/memory/sql"
import { ProjectTable } from "../src/project/sql"
import { SessionTable } from "../src/session/sql"

if (!process.env.ARFORGE_DB_URL?.trim()) {
  throw new Error("ARFORGE_DB_URL is required; keep credentials in the environment, never in source control")
}

const tableCount = <Table extends Parameters<ReturnType<Database.Interface["db"]["select"]>["from"]>[0]>(table: Table) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select({ value: count() }).from(table).get()
    return Number(row?.value ?? 0)
  })

const result = await Effect.runPromise(
  Effect.all({
    projects: tableCount(ProjectTable),
    sessions: tableCount(SessionTable),
    memories: tableCount(MemoryTable),
    learningOutcomes: tableCount(LearningOutcomeTable),
    learningPatterns: tableCount(LearningPatternTable),
  }).pipe(Effect.provide(LayerNode.compile(Database.node))),
)

console.log(JSON.stringify({ backend: "postgresql", ...result }))
