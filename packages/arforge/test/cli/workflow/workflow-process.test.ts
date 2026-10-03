import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge workflows compatibility entry (TS Core owner)", () => {
  cliIt.concurrent(
    "routes the supported legacy actions to the typed workflow owner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const database = join(home, "workflow.sqlite")
        const spawn = (args: string[]) =>
          arforge.spawn(args, { env: { ARFORGE_DB: database, ARFORGE_DB_URL: "", ARFORGE_DB_ADMIN_URL: "" } })
        const workflowPath = join(home, ".arforge", "workflows", "checkpoint.json")
        yield* Effect.promise(() => mkdir(join(home, ".arforge", "workflows"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            workflowPath,
            JSON.stringify({
              schema_version: 2,
              name: "checkpoint_flow",
              steps: [{ id: "done", title: "Done", kind: "checkpoint", prompt: "finished" }],
            }),
          ),
        )

        const directList = yield* spawn(["workflow", "list", "--workspace", home, "--json"])
        const legacyList = yield* spawn(["workflows", "list", "--workspace", home, "--json"])
        const implicitList = yield* spawn(["workflows", "--workspace", home, "--json"])
        for (const [label, result] of [
          ["workflow list", directList],
          ["workflows list", legacyList],
          ["workflows default list", implicitList],
        ] as const) {
          arforge.expectExit(result, 0, label)
          expect(result.stderr).toBe("")
        }
        expect(JSON.parse(legacyList.stdout)).toEqual(JSON.parse(directList.stdout))
        expect(JSON.parse(implicitList.stdout)).toEqual(JSON.parse(directList.stdout))

        const directValidation = yield* spawn([
          "workflow",
          "validate",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--json",
        ])
        const legacyValidation = yield* spawn([
          "workflows",
          "validate",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--json",
        ])
        arforge.expectExit(directValidation, 0, "workflow validate")
        arforge.expectExit(legacyValidation, 0, "workflows validate")
        expect(JSON.parse(legacyValidation.stdout)).toEqual(JSON.parse(directValidation.stdout))
        expect(JSON.parse(directValidation.stdout)).toMatchObject({
          valid: true,
          name: "checkpoint_flow",
          steps: 1,
          edges: 0,
        })

        const directRuns = yield* spawn(["workflow", "runs", "--workspace", home, "--json"])
        const legacyRuns = yield* spawn(["workflows", "runs", "--workspace", home, "--json"])
        arforge.expectExit(directRuns, 0, "workflow runs")
        arforge.expectExit(legacyRuns, 0, "workflows runs")
        expect(JSON.parse(legacyRuns.stdout)).toEqual(JSON.parse(directRuns.stdout))

        const started = yield* spawn([
          "workflow",
          "start",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--permission-mode",
          "plan",
          "--max-parallel",
          "1",
          "--json",
        ])
        arforge.expectExit(started, 0, "workflow start")
        const runID = (JSON.parse(started.stdout) as { run_id?: string }).run_id
        expect(runID).toMatch(/^run_/)

        const directStatus = yield* spawn(["workflow", "get", runID!, "--workspace", home, "--json"])
        const legacyStatus = yield* spawn(["workflows", "status", runID!, "--workspace", home, "--json"])
        arforge.expectExit(directStatus, 0, "workflow get")
        arforge.expectExit(legacyStatus, 0, "workflows status")
        expect(JSON.parse(legacyStatus.stdout)).toEqual(JSON.parse(directStatus.stdout))

        const directEvents = yield* spawn(["workflow", "events", runID!, "--workspace", home, "--json"])
        const legacyEvents = yield* spawn(["workflows", "events", runID!, "--workspace", home, "--json"])
        arforge.expectExit(directEvents, 0, "workflow events")
        arforge.expectExit(legacyEvents, 0, "workflows events")
        expect(JSON.parse(legacyEvents.stdout)).toEqual(JSON.parse(directEvents.stdout))
        expect((JSON.parse(directEvents.stdout) as { count: number }).count).toBeGreaterThan(0)

        const previewReportPath = join(home, "reports", "preview.json")
        const directPreviewRun = yield* spawn([
          "workflow",
          "run",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--report",
          previewReportPath,
          "--json",
        ])
        const legacyPreviewRun = yield* spawn([
          "workflows",
          "run",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--report",
          previewReportPath,
          "--json",
        ])
        arforge.expectExit(directPreviewRun, 0, "workflow run preview")
        arforge.expectExit(legacyPreviewRun, 0, "workflows run preview")
        expect(JSON.parse(legacyPreviewRun.stdout)).toEqual(JSON.parse(directPreviewRun.stdout))
        expect(JSON.parse(directPreviewRun.stdout)).toMatchObject({
          name: "checkpoint_flow",
          success: true,
          dry_run: true,
          report_path: previewReportPath,
        })
        const previewReport = yield* Effect.promise(() => Bun.file(previewReportPath).json())
        expect(previewReport).toMatchObject({
          name: "checkpoint_flow",
          success: true,
          dry_run: true,
        })

        const defaultPreviewRun = yield* spawn([
          "workflow",
          "run",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--json",
        ])
        arforge.expectExit(defaultPreviewRun, 0, "workflow run default profile report")
        expect(JSON.parse(defaultPreviewRun.stdout)).toMatchObject({
          report_path: join(home, "workflows", "runs", "checkpoint_flow.json"),
        })

        const escapedReportPath = join(home, "..", "workflow-report-escape.json")
        const rejectedReport = yield* spawn([
          "workflows",
          "run",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--execute",
          "--report",
          escapedReportPath,
        ])
        arforge.expectExit(rejectedReport, 2, "workflows run rejects report outside workspace")
        expect(rejectedReport.stdout).toBe("")
        expect(rejectedReport.stderr).toContain("--report 必须位于当前工作区内")
        const escapedReportExists = yield* Effect.promise(() => Bun.file(escapedReportPath).exists())
        expect(escapedReportExists).toBe(false)

        const executeReportPath = join(home, "reports", "execute.json")
        const executed = yield* spawn([
          "workflows",
          "run",
          ".arforge/workflows/checkpoint.json",
          "--workspace",
          home,
          "--permission-mode",
          "plan",
          "--max-parallel",
          "1",
          "--execute",
          "--report",
          executeReportPath,
          "--json",
        ])
        arforge.expectExit(executed, 0, "workflows run execute")
        expect(JSON.parse(executed.stdout)).toMatchObject({
          name: "checkpoint_flow",
          success: true,
          dry_run: false,
          graph_status: "completed",
          report_path: executeReportPath,
        })
        const executeReport = yield* Effect.promise(() => Bun.file(executeReportPath).json())
        expect(executeReport).toMatchObject({
          name: "checkpoint_flow",
          success: true,
          dry_run: false,
        })
        expect(executeReport).not.toHaveProperty("graph_run_id")
        expect(executeReport).not.toHaveProperty("graph_status")
      }),
    180_000,
  )
})
