import { describe, expect, test } from "bun:test"
import { canReadRunSource, navigateToRunSource, workspaceSnapshotSources } from "./personal-workspace-source"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { Project } from "@arforge-ai/schema/project"
import { AbsolutePath } from "@arforge-ai/schema/schema"
import { resolve } from "node:path"

const run = {
  runID: "run_source_foreign", sessionID: "ses_source_foreign",
  source: { inspectability: "requires-navigation" as const, projectID: Project.ID.global, directory: AbsolutePath.make("D:/history") },
}
const location = { projectID: "global", directory: "C:/current" }

describe("Personal Workspace original-source navigation", () => {
  test("retains old SDK response rows as read-only while validating actual origin metadata", () => {
    const old = { runID: "run_old", sessionID: "ses_old", status: "completed" as const, initiator: "user" as const,
      authority: "human" as const, riskTier: "L0" as const, state: "settled" as const, recoveryRequired: false,
      budget: { attemptsUsed: 0, maxAttempts: 1, durationMsUsed: 0, maxDurationMs: 100, costMicrosUsed: 0, maxCostMicros: 100 }, createdAt: 0, updatedAt: 0 }
    const snapshot = { asOf: 0, project: { id: "global", directory: "C:/" },
      location: { directory: "C:/selected", projectID: "global", projectDirectory: "C:/" }, sessions: [], tasks: [],
      runs: [old, { ...old, runID: "run_known", source: run.source }], personalJobs: [], memoryCandidates: [], attention: [],
      counts: { sessions: 0, activeSessions: 0, tasks: 0, pendingTasks: 0, runs: 2, activeRuns: 0, recoveringRuns: 0, personalJobs: 0, pendingApprovals: 0, artifacts: 0, memoryCandidates: 0 },
      cost: { runUsedMicros: 0, runLimitMicros: 0, jobUsedMicros: 0, jobLimitMicros: 0 } }
    const adapted = workspaceSnapshotSources(snapshot)
    expect(adapted.runs).toHaveLength(2)
    expect(adapted.runs[0]?.source).toEqual({ inspectability: "missing-binding" })
    expect(adapted.runs[1]?.source).toEqual(run.source)
    expect(snapshot.runs[0]).not.toHaveProperty("source")
    expect(canReadRunSource(adapted.runs[0]!, snapshot.location)).toBe(false)
  })
  test("only current exact-source parents are inspectable; missing, foreign and moved histories are not queried", () => {
    expect(canReadRunSource(run, location)).toBe(false)
    expect(canReadRunSource({ ...run, source: { inspectability: "missing-binding" } }, location)).toBe(false)
    expect(canReadRunSource({ ...run, source: { ...run.source, inspectability: "session-moved" } }, location)).toBe(false)
    const current = { ...run, source: { ...run.source, inspectability: "current" as const, directory: location.directory } }
    expect(canReadRunSource(current, location)).toBe(true)
    expect(canReadRunSource(current, { ...location, projectID: "another-project" })).toBe(false)
    expect(canReadRunSource(current, { ...location, directory: "D:/elsewhere" })).toBe(false)
  })

  test("production tab navigation preserves actual draft prompt state in isolation", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "--conditions=browser", "--rerun-every", "--preload", "./happydom.ts",
        "./src/components/control-center/personal-workspace-source-navigation.isolated.ts"],
      cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
    expect(stdout + stderr).toContain("2 pass")
  }, 15_000)

  test("missing and current sources never trigger navigation reads", async () => {
    const calls: string[] = []
    const deps = {
      current: () => true,
      getSession: async () => { calls.push("session"); throw new Error("must not read") },
      getLocation: async () => { calls.push("location"); throw new Error("must not read") },
      selectSession: () => { calls.push("select") },
    }
    expect(await navigateToRunSource({ ...run, source: { inspectability: "missing-binding" } }, deps)).toBe(false)
    expect(await navigateToRunSource({ ...run, source: { ...run.source, inspectability: "current" } }, deps)).toBe(false)
    expect(calls).toEqual([])
  })

  test("rejects a moved session or wrong project without changing source", async () => {
    for (const changed of [{ directory: "C:/moved", projectID: "global" }, { directory: "D:/history", projectID: "other" }]) {
      const calls: string[] = []
      await expect(navigateToRunSource(run, {
        current: () => true, getSession: async () => ({ id: run.sessionID, ...changed }),
        getLocation: async () => { calls.push("location"); return changed },
        selectSession: () => { calls.push("select") },
      })).rejects.toThrow("source")
      expect(calls).toEqual([])
    }
  })

  test("rejects resolved location drift and forwards denied reads without navigation", async () => {
    let selected = false
    const deps = {
      current: () => true,
      getSession: async () => ({ id: run.sessionID, projectID: "global", directory: "D:/history" }),
      getLocation: async () => ({ projectID: "other", directory: "D:/history" }),
      selectSession: () => { selected = true },
    }
    await expect(navigateToRunSource(run, deps)).rejects.toThrow("source")
    await expect(navigateToRunSource(run, { ...deps, getSession: async () => { throw new Error("403 denied") } })).rejects.toThrow("403 denied")
    expect(selected).toBe(false)
  })

  test("a source switch away and back invalidates delayed navigation before chaining another read", async () => {
    let scope = "server-a/current"
    const guard = createScopeRequestGuard(() => scope)
    const token = guard.capture()
    let resolve!: (value: { id: string; projectID: string; directory: string }) => void
    const pending = new Promise<{ id: string; projectID: string; directory: string }>(done => { resolve = done })
    const calls: string[] = []
    const navigation = navigateToRunSource(run, {
      current: () => guard.isCurrent(token), getSession: () => pending,
      getLocation: async (directory) => { calls.push("location"); return { projectID: "global", directory } },
      selectSession: () => { calls.push("select") },
    })
    scope = "server-b/current"; guard.current()
    scope = "server-a/current"; guard.current()
    resolve({ id: run.sessionID, projectID: "global", directory: "D:/history" })
    expect(await navigation).toBe(false)
    expect(calls).toEqual([])
  })
})
