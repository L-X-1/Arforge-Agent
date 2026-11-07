import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PersonalWorkspace } from "../src/personal-workspace"
import { Project } from "../src/project"
import { AgentRuntime } from "../src/agent-runtime"

describe("Personal Workspace parent source contract", () => {
  test("decodes an older whole snapshot without losing historical rows or inventing bindings", () => {
    const oldRun = {
      runID: "run_old_source_contract", sessionID: "ses_old_source_contract", status: "completed",
      initiator: "user", authority: "human", riskTier: "L0", state: "settled", recoveryRequired: false,
      budget: { attemptsUsed: 0, maxAttempts: 1, durationMsUsed: 0, maxDurationMs: 100, costMicrosUsed: 0, maxCostMicros: 100 },
      createdAt: 0, updatedAt: 0,
    }
    const wire = {
      asOf: 0, project: { id: "global", directory: "C:/" },
      location: { directory: "C:/selected", projectID: "global", projectDirectory: "C:/" },
      sessions: [], tasks: [], runs: [oldRun], personalJobs: [], memoryCandidates: [], attention: [],
      counts: { sessions: 0, activeSessions: 0, tasks: 0, pendingTasks: 0, runs: 1, activeRuns: 0, recoveringRuns: 0, personalJobs: 0, pendingApprovals: 0, artifacts: 0, memoryCandidates: 0 },
      cost: { runUsedMicros: 0, runLimitMicros: 0, jobUsedMicros: 0, jobLimitMicros: 0 },
    }
    const decoded = Schema.decodeUnknownSync(PersonalWorkspace.Snapshot)(wire)
    expect(decoded.runs).toHaveLength(1)
    expect(decoded.runs[0]?.runID).toBe(AgentRuntime.RunID.make(oldRun.runID))
    expect(decoded.runs[0]?.source).toEqual({ inspectability: "missing-binding" })
    expect(Schema.encodeSync(PersonalWorkspace.Snapshot)(decoded).runs[0]?.source).toEqual({ inspectability: "missing-binding" })
    expect(wire.runs[0]).not.toHaveProperty("source")
  })

  test("known origins require both persisted bindings and do not imply control permission", () => {
    for (const inspectability of ["current", "requires-navigation", "session-moved"] as const) {
      const value = { inspectability, projectID: "global", directory: "C:/source" }
      const source = Schema.decodeUnknownSync(PersonalWorkspace.RunSource)(value)
      expect(Schema.encodeSync(PersonalWorkspace.RunSource)(source)).toEqual(value)
      expect(() => Schema.decodeUnknownSync(PersonalWorkspace.RunSource)({ inspectability, projectID: "global" })).toThrow()
      expect(() => Schema.decodeUnknownSync(PersonalWorkspace.RunSource)({ inspectability, directory: "C:/source" })).toThrow()
    }
  })
  test("missing binding preserves partial metadata and omits undefined fields", () => {
    const source: PersonalWorkspace.RunSource = { inspectability: "missing-binding", projectID: Project.ID.global, directory: undefined }
    expect(Schema.encodeSync(PersonalWorkspace.RunSource)(source)).toEqual({ inspectability: "missing-binding", projectID: "global" })
    expect(Schema.decodeUnknownSync(PersonalWorkspace.RunSource)({ inspectability: "missing-binding" })).toEqual({ inspectability: "missing-binding" })
  })
})
