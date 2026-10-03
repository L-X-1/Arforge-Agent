import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { EventV2 } from "@arforge-ai/core/event"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { DurableWorkflowGraphRuntime } from "@arforge-ai/core/analysis/durable-workflow"
import {
  schedulingRequestDigest,
  workflowSchedulingRequest,
  type MultiAgentBenefitEvidence,
  type MultiAgentBenefitPolicy,
} from "@arforge-ai/core/runtime/multi-agent-scheduling"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import type { WorkflowDefinition } from "@arforge-ai/core/analysis/workflow-graph"

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]))
const it = testEffect(runtimeLayer)

const definition: WorkflowDefinition = {
  schema_version: 1,
  name: "durable-release",
  description: "Durable workflow test",
  source_path: ".arforge/workflows/release.json",
  steps: [
    {
      id: "agent",
      title: "Agent",
      prompt: "inspect",
      depends_on: [],
      continue_on_error: false,
      kind: "agent",
      max_attempts: 1,
      when_step: "",
      when_statuses: [],
      access: "read",
    },
    {
      id: "approval",
      title: "Approval",
      prompt: "Approve release",
      depends_on: ["agent"],
      continue_on_error: false,
      kind: "approval",
      max_attempts: 1,
      when_step: "",
      when_statuses: [],
      access: "read",
    },
    {
      id: "checkpoint",
      title: "Checkpoint",
      prompt: "released",
      depends_on: ["approval"],
      continue_on_error: false,
      kind: "checkpoint",
      max_attempts: 1,
      when_step: "",
      when_statuses: [],
      access: "read",
    },
  ],
}

const agentDefinition = (name: string, access: "read" | "write" = "read"): WorkflowDefinition => ({
  schema_version: 1,
  name,
  description: "workflow concurrency test",
  source_path: `.arforge/workflows/${name}.json`,
  steps: [
    {
      id: "agent",
      title: "Agent",
      prompt: "inspect",
      depends_on: [],
      continue_on_error: false,
      kind: "agent",
      max_attempts: 1,
      when_step: "",
      when_statuses: [],
      access,
    },
  ],
})

describe("DurableWorkflowGraphRuntime", () => {
  it.effect("uses DurableRun for workflow state, approval, child runs, and recovery", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      const runtime = new DurableWorkflowGraphRuntime({ durableRun, ownerId: "workflow-test" })
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition,
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/workspace",
          permissionMode: "plan",
          maxParallel: 2,
        }),
      )

      expect(created.status).toBe("planned")
      expect(created.permission_mode).toBe("plan")
      expect(created.definition_digest).toMatch(/^[0-9a-f]{64}$/)
      expect(created.budget).toMatchObject({ max_attempts: 3, reserved_attempts: 0, used_attempts: 0 })
      expect(created.scheduling).toMatchObject({
        action: "single",
        execute_mode: "single",
        effective_max_parallel: 1,
      })
      const projectedSteps = yield* Effect.promise(() => runtime.stepsFor(created.run_id))
      expect(projectedSteps.map((step) => ({ id: step.id, title: step.title, status: step.status }))).toEqual([
        { id: expect.stringMatching(/^stp_run_workflow_import|^stp_run_/), title: "Agent", status: "queued" },
        { id: expect.any(String), title: "Approval", status: "queued" },
        { id: expect.any(String), title: "Checkpoint", status: "queued" },
      ])
      yield* Effect.promise(() => runtime.start(created.run_id))
      const waiting = yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))
      expect(waiting.status).toBe("waiting_approval")
      expect((yield* Effect.promise(() => runtime.nodesFor(created.run_id))).get("agent")).toMatchObject({
        status: "completed",
        budget_reserved_attempts: 1,
        child_run_id: expect.any(String),
      })
      const waitingSnapshot = yield* durableRun.load(AgentRuntime.RunID.make(created.run_id))
      expect(waitingSnapshot.checkpoint?.state).toMatchObject({
        approval_scopes: { approval: { definition_digest: expect.any(String), downstream: ["checkpoint"] } },
        budget: { max_attempts: 3, reserved_attempts: 1, used_attempts: 1 },
      })
      const requested = (yield* Effect.promise(() => runtime.events(created.run_id))).items.find(
        (event) => event.event_type === "node.approval_requested",
      )
      expect(JSON.parse(requested?.data_json ?? "{}")).toMatchObject({ downstream: ["checkpoint"] })

      yield* Effect.promise(() => runtime.decideApproval(created.run_id, "approval", true, "approved"))
      const completed = yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))
      expect(completed.status).toBe("completed")
      expect(completed.verification).toMatchObject({
        action_kind: "workflow",
        action_version: "1",
        passed: true,
        total: 3,
        passed_count: 3,
        failed_checks: [],
      })
      expect(completed.verification?.evidence_digest).toMatch(/^[0-9a-f]{64}$/)

      const loaded = yield* durableRun.load(AgentRuntime.RunID.make(created.run_id))
      expect(loaded.run.status).toBe("completed")
      expect(loaded.checkpoint?.state).toMatchObject({
        artifact: { kind: "workflow-definition" },
        nodes: { checkpoint: { status: "completed" } },
        verification: { passed: true, evidence_digest: expect.any(String) },
      })
      expect(
        (yield* Effect.promise(() => runtime.events(created.run_id))).items.map((event) => event.event_type),
      ).toContain("node.approved")
      expect(
        (yield* durableRun.list({ sessionID: (loaded.run as AgentRuntime.SessionRun).sessionID, limit: 20 })).length,
      ).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("imports the same run ID only for the same immutable definition digest", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      const runtime = new DurableWorkflowGraphRuntime({ durableRun, ownerId: "workflow-import-test" })
      const runID = AgentRuntime.RunID.make("run_workflow_import")
      const input = { definition, sessionId: SessionSchema.ID.create(), workspace: "E:/workspace", runID }
      const first = yield* Effect.promise(() => runtime.createRun(input))
      const same = yield* Effect.promise(() => runtime.createRun(input))
      expect(same.run_id).toBe(first.run_id)

      const changed = { ...definition, description: "different digest" }
      const conflict = yield* Effect.promise(() =>
        runtime.createRun({ ...input, definition: changed }).catch((error) => error),
      )
      expect(conflict).toMatchObject({ code: "RUN_DIGEST_CONFLICT" })
    }),
  )

  it.effect("keeps a read-only workflow parent at read capability even under an editable session mode", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      const runtime = new DurableWorkflowGraphRuntime({ durableRun, ownerId: "read-parent-capability-test" })
      const read = yield* Effect.promise(() =>
        runtime.createRun({
          definition: agentDefinition("read-parent-capability", "read"),
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/read-parent-capability",
          permissionMode: "fullAccess",
        }),
      )
      const snapshot = yield* durableRun.load(AgentRuntime.RunID.make(read.run_id))

      expect(snapshot.run.riskTier).toBe("L0")
      if (!("sessionID" in snapshot.run)) throw new Error("expected a session workflow run")
      expect(snapshot.run.delegableCapabilities).toEqual([
        { action: "*", resources: ["workspace"], access: "read" },
      ])
    }),
  )

  it.effect("runs independent reads concurrently and serializes writes per workspace", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      let active = 0
      let maxActive = 0
      const runner = async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(40)
        active -= 1
        return "ok"
      }
      const reads: WorkflowDefinition = {
        ...agentDefinition("parallel-reads"),
        steps: [
          { ...agentDefinition("parallel-reads").steps[0]!, id: "read-a", title: "Read A" },
          { ...agentDefinition("parallel-reads").steps[0]!, id: "read-b", title: "Read B" },
        ],
      }
      const readRequest = workflowSchedulingRequest(reads, 2)
      const readPolicy: MultiAgentBenefitPolicy = {
        revision: "test-approved-v1",
        minSamples: 1,
        maxSuccessRegression: 0,
        maxDurationRatio: 1,
        maxTokenRatio: 1,
        maxCostRatio: 1,
        maxConflictRateDelta: 0,
      }
      const readEvidence: MultiAgentBenefitEvidence = {
        schemaVersion: 1,
        datasetDigest: "a".repeat(64),
        suiteID: "workflow-read-golden",
        suiteRevision: 1,
        requestDigest: schedulingRequestDigest(readRequest),
        evidenceIDs: ["evd_workflow_read_benefit" as AgentRuntime.EvidenceID],
        baseline: {
          sampleSize: 1,
          succeeded: 1,
          totalDurationMs: 100,
          totalTokens: 100,
          totalCostMinor: 10,
          conflicts: 0,
        },
        multi: {
          sampleSize: 1,
          succeeded: 1,
          totalDurationMs: 50,
          totalTokens: 80,
          totalCostMinor: 8,
          conflicts: 0,
        },
        source: "recorded",
      }
      const readRuntime = new DurableWorkflowGraphRuntime({
        durableRun,
        runner,
        ownerId: "parallel-read-test",
        scheduling: { evidence: readEvidence, policy: readPolicy },
      })
      const readRun = yield* Effect.promise(() =>
        readRuntime.createRun({
          definition: reads,
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/shared-workspace",
          permissionMode: "plan",
          maxParallel: 2,
        }),
      )
      yield* Effect.promise(() => readRuntime.start(readRun.run_id))
      expect((yield* Effect.promise(() => readRuntime.wait(readRun.run_id, 5_000))).status).toBe("completed")
      expect(maxActive).toBe(2)
      const readParent = yield* durableRun.load(AgentRuntime.RunID.make(readRun.run_id))
      expect(readParent.checkpoint?.state).toMatchObject({
        scheduling: { action: "multi", execute_mode: "multi", effective_max_parallel: 2 },
      })
      const readChildren = yield* durableRun.list({
        sessionID: (readParent.run as AgentRuntime.SessionRun).sessionID,
        limit: 20,
      })
      const readChildRuns = readChildren.filter((item) => item.run.id !== readRun.run_id)
      expect(readChildRuns).toHaveLength(2)
      expect(
        readChildRuns.every((item) => item.run.budget.maxTokens === Math.floor(readParent.run.budget.maxTokens / 2)),
      ).toBe(true)

      active = 0
      maxActive = 0
      const firstRuntime = new DurableWorkflowGraphRuntime({ durableRun, runner, ownerId: "write-test-a" })
      const secondRuntime = new DurableWorkflowGraphRuntime({ durableRun, runner, ownerId: "write-test-b" })
      const writeDefinition = agentDefinition("serialized-write", "write")
      const first = yield* Effect.promise(() =>
        firstRuntime.createRun({
          definition: writeDefinition,
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/shared-workspace",
          permissionMode: "fullAccess",
        }),
      )
      const second = yield* Effect.promise(() =>
        secondRuntime.createRun({
          definition: writeDefinition,
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/shared-workspace",
          permissionMode: "fullAccess",
        }),
      )
      yield* Effect.promise(() => Promise.all([firstRuntime.start(first.run_id), secondRuntime.start(second.run_id)]))
      const completed = yield* Effect.promise(() =>
        Promise.all([firstRuntime.wait(first.run_id, 5_000), secondRuntime.wait(second.run_id, 5_000)]),
      )
      expect(completed.map((run) => run.status)).toEqual(["completed", "completed"])
      expect(maxActive).toBe(1)

      const parent = yield* durableRun.load(AgentRuntime.RunID.make(first.run_id))
      const children = yield* durableRun.list({
        sessionID: (parent.run as AgentRuntime.SessionRun).sessionID,
        limit: 20,
      })
      const child = children.find((item) => item.run.id !== first.run_id)
      expect(child?.run.initiator).toBe("agent")
      expect(child?.run.riskTier).toBe("L2")
      expect(child?.run.budget.maxAttempts).toBe(1)
      expect(child?.run.budget.maxTokens).toBe(parent.run.budget.maxTokens)
      expect(child?.run.budget.maxDurationMs).toBeLessThanOrEqual(parent.run.budget.maxDurationMs)
    }),
  )

  it.effect("exposes an explicit write lane only to mutation children", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      const observed: Array<{ access: "read" | "write"; mode?: string; workspaceKey?: string }> = []
      const runtime = new DurableWorkflowGraphRuntime({
        durableRun,
        ownerId: "write-lane-context-test",
        runner: async (_step, context) => {
          observed.push({
            access: context.access,
            ...(context.writeLane
              ? { mode: context.writeLane.mode, workspaceKey: context.writeLane.workspaceKey }
              : {}),
          })
          return "ok"
        },
      })
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition: agentDefinition("write-lane-context", "write"),
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/lane-context",
          permissionMode: "fullAccess",
        }),
      )
      yield* Effect.promise(() => runtime.start(created.run_id))
      expect((yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))).status).toBe("completed")
      expect(observed).toEqual([{ access: "write", mode: "workspace-exclusive", workspaceKey: "e:/lane-context" }])
      const started = (yield* Effect.promise(() => runtime.events(created.run_id))).items.find(
        (event) => event.event_type === "node.started",
      )
      expect(JSON.parse(started?.data_json ?? "{}")).toMatchObject({
        access: "write",
        write_lane: "workspace-exclusive",
      })
    }),
  )

  it.effect("keeps an eligible read split single-agent when benefit evidence is absent", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      let active = 0
      let maxActive = 0
      const runtime = new DurableWorkflowGraphRuntime({
        durableRun,
        ownerId: "missing-benefit-evidence-test",
        runner: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await Bun.sleep(25)
          active -= 1
          return "ok"
        },
      })
      const reads: WorkflowDefinition = {
        ...agentDefinition("missing-benefit-evidence"),
        steps: [
          { ...agentDefinition("missing-benefit-evidence").steps[0]!, id: "read-a", title: "Read A" },
          { ...agentDefinition("missing-benefit-evidence").steps[0]!, id: "read-b", title: "Read B" },
        ],
      }
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition: reads,
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/single-agent-fallback",
          permissionMode: "plan",
          maxParallel: 2,
        }),
      )
      yield* Effect.promise(() => runtime.start(created.run_id))
      expect((yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))).status).toBe("completed")
      expect(maxActive).toBe(1)
      expect((yield* durableRun.load(AgentRuntime.RunID.make(created.run_id))).checkpoint?.state).toMatchObject({
        scheduling: { action: "candidate", execute_mode: "single", effective_max_parallel: 1 },
      })
      const initialEvents = (yield* Effect.promise(() => runtime.events(created.run_id))).items
      expect(initialEvents.map((event) => event.event_type)).toContain("scheduling.gate_evaluated")
      expect(initialEvents.find((event) => event.event_type === "graph.created")?.sequence).toBe(1)
      expect(initialEvents.find((event) => event.event_type === "scheduling.gate_evaluated")?.sequence).toBe(2)
    }),
  )

  it.effect("fails closed for plan-mode mutation nodes and records parent budget", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      let runnerCalls = 0
      const runtime = new DurableWorkflowGraphRuntime({
        durableRun,
        ownerId: "permission-test",
        runner: async () => {
          runnerCalls += 1
          return "must not run"
        },
      })
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition: agentDefinition("plan-write", "write"),
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/workspace",
          permissionMode: "plan",
        }),
      )
      yield* Effect.promise(() => runtime.start(created.run_id))
      const failed = yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))
      expect(failed.status).toBe("failed")
      expect(runnerCalls).toBe(0)
      expect((yield* Effect.promise(() => runtime.nodesFor(created.run_id))).get("agent")).toMatchObject({
        status: "blocked",
        error: "permission denied",
      })
      const loaded = yield* durableRun.load(AgentRuntime.RunID.make(created.run_id))
      expect(loaded.run.riskTier).toBe("L0")
      expect(loaded.run.budget.maxAttempts).toBe(1)
      expect(loaded.checkpoint?.state).toMatchObject({ budget: { max_attempts: 1, used_attempts: 0 } })
    }),
  )

  it.effect("propagates pause and cancel to a child without settling the node", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      let resolveEntered: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve
      })
      const runtime = new DurableWorkflowGraphRuntime({
        durableRun,
        ownerId: "propagation-test",
        runner: async (_step, context) => {
          resolveEntered?.()
          await new Promise<never>((_, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          })
          return "unreachable"
        },
      })
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition: agentDefinition("propagation", "read"),
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/workspace",
          permissionMode: "plan",
        }),
      )
      yield* Effect.promise(() => runtime.start(created.run_id))
      yield* Effect.promise(() => entered)

      let childRunID = ""
      for (let attempt = 0; attempt < 50 && !childRunID; attempt++) {
        const snapshot = yield* durableRun.load(AgentRuntime.RunID.make(created.run_id))
        const checkpoint = snapshot.checkpoint?.state as
          | { nodes?: Record<string, { child_run_id?: string }> }
          | undefined
        childRunID = checkpoint?.nodes?.agent?.child_run_id ?? ""
        if (!childRunID) yield* Effect.promise(() => Bun.sleep(10))
      }
      expect(childRunID).not.toBe("")
      const paused = yield* Effect.promise(() => runtime.pause(created.run_id))
      expect(paused.status).toBe("paused")
      expect((yield* durableRun.load(AgentRuntime.RunID.make(childRunID))).run.status).toBe("paused")
      expect((yield* Effect.promise(() => runtime.nodesFor(created.run_id))).get("agent")?.status).toBe("paused")
      expect((yield* Effect.promise(() => runtime.wait(created.run_id, 100))).status).toBe("paused")

      const cancelled = yield* Effect.promise(() => runtime.cancel(created.run_id))
      expect(cancelled.status).toBe("cancelled")
      expect((yield* durableRun.load(AgentRuntime.RunID.make(childRunID))).run.status).toBe("cancelled")
      expect((yield* Effect.promise(() => runtime.nodesFor(created.run_id))).get("agent")?.status).toBe("cancelled")
    }),
  )

  it.effect("recovers a lease-owner crash through DurableRun orphan detection", () =>
    Effect.gen(function* () {
      const durableRun = yield* DurableRun.Service
      const runtime = new DurableWorkflowGraphRuntime({
        durableRun,
        ownerId: "recovery-test",
        runner: async () => "recovered",
      })
      const created = yield* Effect.promise(() =>
        runtime.createRun({
          definition: agentDefinition("recovery"),
          sessionId: SessionSchema.ID.create(),
          workspace: "E:/workspace",
          permissionMode: "plan",
        }),
      )
      yield* durableRun.transition({
        runID: AgentRuntime.RunID.make(created.run_id),
        to: "preflight",
        reason: "test crash",
      })
      yield* durableRun.transition({
        runID: AgentRuntime.RunID.make(created.run_id),
        to: "queued",
        reason: "test crash",
      })
      yield* durableRun.transition({
        runID: AgentRuntime.RunID.make(created.run_id),
        to: "running",
        reason: "test crash",
      })
      const recovered = yield* Effect.promise(() => runtime.recover(created.run_id))
      expect(["running", "completed"]).toContain(recovered.status)
      expect((yield* Effect.promise(() => runtime.wait(created.run_id, 5_000))).status).toBe("completed")
    }),
  )
})
