import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge memory compatibility entry (TS Core/Server owner)", () => {
  cliIt.concurrent(
    "runs status/list/search/get/create/update/facets through one typed contract",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const at = ["--workspace", home]
        const spawn = (args: string[]) =>
          arforge.spawn(args, {
            env: {
              // The Bun test preload intentionally sets :memory:. Override it
              // for this cross-process flow so create→list exercises durable
              // persistence instead of each child receiving a fresh database.
              ARFORGE_DB: path.join(home, "memory.db"),
              ARFORGE_DB_URL: "",
              ARFORGE_DB_ADMIN_URL: "",
            },
          })

        const initial = yield* spawn(["memory", "status", ...at, "--json"])
        arforge.expectExit(initial, 0)
        expect(JSON.parse(initial.stdout)).toMatchObject({ total: 0, workspace: 0, global: 0 })

        const created = yield* spawn([
          "memory",
          "create",
          "Remember the authentication token expiry workflow",
          "--type",
          "workflow",
          "--tags",
          "auth,runbook",
          "--importance",
          "4",
          ...at,
          "--json",
        ])
        arforge.expectExit(created, 0)
        const memory = JSON.parse(created.stdout) as { id: string; scope: string; source: string; tags: string[] }
        expect(memory.id).toMatch(/^mem_/)
        expect(memory.scope).toBe("workspace")
        expect(memory.source).toBe("user")
        expect(memory.tags).toEqual(["auth", "runbook"])

        const listed = yield* spawn(["memory", "list", "--query", "authentication", ...at, "--json"])
        arforge.expectExit(listed, 0)
        expect(JSON.parse(listed.stdout).items.map((item: { id: string }) => item.id)).toContain(memory.id)

        const searched = yield* spawn(["memory", "search", "token expiry", ...at, "--json"])
        arforge.expectExit(searched, 0)
        const semantic = JSON.parse(searched.stdout) as { localOnly: boolean; items: Array<{ memory: { id: string } }> }
        expect(semantic.localOnly).toBe(true)
        expect(semantic.items[0]?.memory.id).toBe(memory.id)

        const fetched = yield* spawn(["memory", "get", memory.id, ...at, "--json"])
        arforge.expectExit(fetched, 0)
        expect(JSON.parse(fetched.stdout).id).toBe(memory.id)

        const updated = yield* spawn([
          "memory",
          "update",
          memory.id,
          "--content",
          "Remember the authentication token expiry and rotation workflow",
          "--review-level",
          "2",
          ...at,
          "--json",
        ])
        arforge.expectExit(updated, 0)
        expect(JSON.parse(updated.stdout)).toMatchObject({ id: memory.id, reviewLevel: 2 })

        const facets = yield* spawn(["memory", "facets", "--no-include-global", ...at, "--json"])
        arforge.expectExit(facets, 0)
        expect(JSON.parse(facets.stdout).tags).toEqual(
          expect.arrayContaining([
            { value: "auth", count: 1 },
            { value: "runbook", count: 1 },
          ]),
        )

        const quality = yield* spawn(["memory", "recall-quality", ...at, "--json"])
        arforge.expectExit(quality, 0)
        expect(JSON.parse(quality.stdout)).toHaveProperty("status", "operational_baseline")

        const metrics = yield* spawn(["memory", "metrics", ...at, "--json"])
        arforge.expectExit(metrics, 0)
        const metricsReport = JSON.parse(metrics.stdout) as {
          execution_mode: string
          side_effects: string
          status: { total: number; workspace: number; important: number }
          recall_quality: { status: string; sample_size: number }
          persisted_conflicts: { count: number; truncated: boolean }
          source_coverage: { status: string; inspected: number; visible_total: number }
          golden_eval: { status: string }
          history: { status: string }
        }
        expect(metricsReport).toMatchObject({
          execution_mode: "read-only-core-memory-metrics",
          side_effects: "none",
          status: { total: 1, workspace: 1, important: 1 },
          recall_quality: { status: "operational_baseline", sample_size: 1 },
          persisted_conflicts: { count: 0, truncated: false },
          source_coverage: { status: "not_comparable", inspected: 1, visible_total: 1 },
          golden_eval: { status: "not_comparable" },
          history: { status: "not_read" },
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "memory_metrics.jsonl")).exists())).toBe(false)

        const writeStats = yield* spawn(["memory", "write-stats", ...at, "--json"])
        arforge.expectExit(writeStats, 0)
        const writeStatsReport = JSON.parse(writeStats.stdout) as {
          execution_mode: string
          side_effects: string
          database: {
            total: number
            inspected: number
            visible_total: number
            truncated: boolean
            by_source: Array<{ source: string; count: number }>
          }
          decision_log: { status: string; file: string }
          clear: { status: string }
        }
        expect(writeStatsReport).toMatchObject({
          execution_mode: "read-only-core-memory-write-stats",
          side_effects: "none",
          database: {
            total: 1,
            inspected: 1,
            visible_total: 1,
            truncated: false,
            by_source: [{ source: "user", count: 1 }],
          },
          decision_log: { status: "not_read", file: "memory_writes.jsonl" },
          clear: { status: "unsupported" },
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "memory_writes.jsonl")).exists())).toBe(false)

        const recovery = yield* spawn(["memory", "recovery", ...at, "--json"])
        arforge.expectExit(recovery, 0)
        const recoveryReport = JSON.parse(recovery.stdout) as {
          execution_mode: string
          side_effects: string
          source: { status: string; rows: number; corrupt_rows: number }
          events_total: number
          verified_count: number
          clear: { status: string }
        }
        expect(recoveryReport).toMatchObject({
          execution_mode: "read-only-core-memory-recovery",
          side_effects: "none",
          source: { status: "missing", rows: 0, corrupt_rows: 0 },
          events_total: 0,
          verified_count: 0,
          clear: { status: "unsupported" },
        })
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "recovery_outcomes.jsonl")).exists())).toBe(false)

        const human = yield* spawn(["memory", "status", ...at])
        arforge.expectExit(human, 0)
        expect(human.stdout).toContain("记忆状态")
        expect(human.stdout).toContain(memory.id)

        const digest = yield* spawn(["memory", "digest", "--category", "workflow", ...at, "--json"])
        arforge.expectExit(digest, 0)
        const report = JSON.parse(digest.stdout) as {
          total: number
          category_count: number
          truncated: boolean
          categories: Array<{ category: string; count: number; items: Array<{ content: string; mem_type: string }> }>
        }
        expect(report).toMatchObject({ total: 1, category_count: 1, truncated: false })
        expect(report.categories[0]).toMatchObject({ category: "workflow", count: 1 })
        expect(report.categories[0]?.items[0]).toMatchObject({
          content: "Remember the authentication token expiry and rotation workflow",
          mem_type: "workflow",
        })

        const digestPath = path.join(home, "exports", "memory-digest.md")
        const written = yield* spawn(["memory", "digest", ...at, "--path", digestPath])
        arforge.expectExit(written, 0)
        expect(written.stdout).toContain("记忆档案已写入")
        expect(yield* Effect.promise(() => Bun.file(digestPath).text())).toContain("workflow · 工作流")
        expect(yield* Effect.promise(() => Bun.file(digestPath).text())).toContain("authentication token expiry")

        // Conflict is deliberately a read-only report.  It consumes the
        // persisted candidate list but never invokes conflictScan, so a
        // normal create/update flow cannot accidentally mutate conflict
        // history merely by asking for diagnostics.
        const conflict = yield* spawn(["memory", "conflict", ...at, "--json"])
        arforge.expectExit(conflict, 0)
        const conflictReport = JSON.parse(conflict.stdout) as {
          execution_mode: string
          benchmark: { detection_rate: number; false_positive_rate: number; precision: number }
          persisted: { count: number }
          relation_coverage: { status: string }
        }
        expect(conflictReport.execution_mode).toBe("read-only-core-conflict-report")
        expect(conflictReport.benchmark).toMatchObject({ detection_rate: 1, false_positive_rate: 0, precision: 1 })
        expect(conflictReport.persisted.count).toBe(0)
        expect(conflictReport.relation_coverage.status).toBe("not_comparable")
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "memory_conflict_benchmark.jsonl")).exists())).toBe(
          false,
        )

        const conflictHuman = yield* spawn(["memory", "conflict", ...at])
        arforge.expectExit(conflictHuman, 0)
        expect(conflictHuman.stdout).toContain("只读")
        expect(conflictHuman.stdout).toContain("不会自动扫描或写入")
        expect(conflictHuman.stdout).toContain("当前工作区没有已持久化冲突候选")
      }),
    240_000,
  )

  cliIt.concurrent(
    "keeps unsupported historical memory clear explicit and fail-closed",
    ({ arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["memory", "write-stats", "--clear"])
        arforge.expectExit(result, 2)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("仍在迁移")
        expect(result.stderr).toContain("不会删除历史文件")

        const recovery = yield* arforge.spawn(["memory", "recovery", "--clear"])
        arforge.expectExit(recovery, 2)
        expect(recovery.stdout).toBe("")
        expect(recovery.stderr).toContain("不会删除历史文件")
      }),
    30_000,
  )

  cliIt.concurrent(
    "exposes the unproven feedback contract as a read-only audit",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const reportResult = yield* arforge.spawn([
          "memory",
          "feedback",
          "--contract-audit",
          "--workspace",
          home,
          "--json",
        ])
        arforge.expectExit(reportResult, 0, "memory feedback contract audit")
        const report = JSON.parse(reportResult.stdout) as {
          workspace: string
          execution_mode: string
          status: string
          side_effects: string
          writes: number
          missing_requirements: string[]
        }
        expect(report).toMatchObject({
          workspace: home,
          execution_mode: "read-only-memory-feedback-contract-audit",
          status: "not_ready",
          side_effects: "none",
          writes: 0,
        })
        expect(report.missing_requirements).toContain("returned_set_validation")
        expect(reportResult.stderr).toBe("")

        const human = yield* arforge.spawn(["memory", "feedback", "--contract-audit", "--workspace", home])
        arforge.expectExit(human, 0, "memory feedback contract audit human")
        expect(human.stdout).toContain("合同审计（只读）")
        expect(human.stdout).toContain("not_ready")
        expect(human.stdout).toContain("不会写入 recall feedback")

        const conflicting = yield* arforge.spawn([
          "memory",
          "feedback",
          "--contract-audit",
          "--retrieval-uid",
          "retrieval-1",
        ])
        arforge.expectExit(conflicting, 1, "memory feedback contract audit conflict")
        expect(conflicting.stdout).toBe("")
        expect(conflicting.stderr).toContain("只接受 --workspace、--json")
        expect(yield* Effect.promise(() => Bun.file(`${home}/memory_feedback.jsonl`).exists())).toBe(false)
      }),
    30_000,
  )

  cliIt.concurrent(
    "rejects ambiguous, missing, and out-of-range memory input before mutation",
    ({ arforge }) =>
      Effect.gen(function* () {
        const missing = yield* arforge.spawn(["memory", "create", "--json"])
        arforge.expectExit(missing, 1)
        expect(missing.stdout).toBe("")
        expect(missing.stderr).toContain("需要非空内容")

        const invalidLimit = yield* arforge.spawn(["memory", "list", "--limit", "0", "--json"])
        arforge.expectExit(invalidLimit, 1)
        expect(invalidLimit.stderr).toContain("--limit 必须是 1 到 500")

        const missingQuery = yield* arforge.spawn(["memory", "search", "--json"])
        arforge.expectExit(missingQuery, 1)
        expect(missingQuery.stderr).toContain("需要查询文本")

        const ambiguousCreate = yield* arforge.spawn([
          "memory",
          "create",
          "positional content",
          "--content",
          "option content",
        ])
        arforge.expectExit(ambiguousCreate, 1)
        expect(ambiguousCreate.stderr).toContain("位置参数和 --content 中选择一个")

        const digestQuery = yield* arforge.spawn(["memory", "digest", "--query", "ignored", "--json"])
        arforge.expectExit(digestQuery, 1)
        expect(digestQuery.stderr).toContain("memory digest 只接受")

        const digestLimit = yield* arforge.spawn(["memory", "digest", "--digest-limit", "0", "--json"])
        arforge.expectExit(digestLimit, 1)
        expect(digestLimit.stderr).toContain("--digest-limit 必须是 1 到 500")

        const conflictQuery = yield* arforge.spawn(["memory", "conflict", "--query", "ignored", "--json"])
        arforge.expectExit(conflictQuery, 1)
        expect(conflictQuery.stderr).toContain("memory conflict 只接受")

        const conflictLimit = yield* arforge.spawn(["memory", "conflict", "--conflict-limit", "0", "--json"])
        arforge.expectExit(conflictLimit, 1)
        expect(conflictLimit.stderr).toContain("--conflict-limit 必须是 1 到 500")
      }),
    60_000,
  )

  cliIt.concurrent(
    "keeps recall feedback syntax explicit and fail-closed until a durable Core producer exists",
    ({ arforge }) =>
      Effect.gen(function* () {
        const valid = yield* arforge.spawn([
          "memory",
          "feedback",
          "retrieval-uid",
          "--useful",
          "1,2",
          "--irrelevant",
          "3",
          "--json",
        ])
        arforge.expectExit(valid, 2)
        expect(valid.stdout).toBe("")
        expect(valid.stderr).toContain("durable retrieval event")
        expect(valid.stderr).toContain("不会写入 recall feedback")

        const optionForm = yield* arforge.spawn([
          "memory",
          "feedback",
          "--retrieval-uid",
          "retrieval-option",
          "--useful",
          "4",
        ])
        arforge.expectExit(optionForm, 2)
        expect(optionForm.stderr).toContain("仍在迁移")

        const missing = yield* arforge.spawn(["memory", "feedback", "--useful", "1"])
        arforge.expectExit(missing, 1)
        expect(missing.stdout).toBe("")
        expect(missing.stderr).toContain("需要一个 retrieval UID")

        const overlap = yield* arforge.spawn([
          "memory",
          "feedback",
          "retrieval-overlap",
          "--useful",
          "1",
          "--irrelevant",
          "1",
        ])
        arforge.expectExit(overlap, 1)
        expect(overlap.stderr).toContain("不能同时")

        const invalidIDs = yield* arforge.spawn(["memory", "feedback", "retrieval-invalid", "--useful", "mem_1"])
        arforge.expectExit(invalidIDs, 1)
        expect(invalidIDs.stderr).toContain("正整数")
      }),
    60_000,
  )
})
