import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  aggregateMetrics,
  benefitEvidenceDigest,
  compareBenefit,
  evaluateMultiAgentGate,
  schedulingRequestDigest,
  workflowSchedulingRequest,
  type MultiAgentBenefitEvidence,
  type MultiAgentBenefitPolicy,
  type MultiAgentSchedulingRequest,
} from "@arforge-ai/core/runtime/multi-agent-scheduling"

const request: MultiAgentSchedulingRequest = {
  requestedParallelism: 2,
  tasks: [
    { id: "read-a", kind: "agent", access: "read", dependsOn: [] },
    { id: "read-b", kind: "agent", access: "read", dependsOn: [] },
  ],
}

const policy: MultiAgentBenefitPolicy = {
  revision: "approved-policy-v1",
  minSamples: 3,
  maxSuccessRegression: 0,
  maxDurationRatio: 1,
  maxTokenRatio: 1,
  maxCostRatio: 1,
  maxConflictRateDelta: 0,
}

const evidence = (overrides: Partial<MultiAgentBenefitEvidence> = {}): MultiAgentBenefitEvidence => ({
  schemaVersion: 1,
  datasetDigest: "a".repeat(64),
  suiteID: "multi-agent-golden",
  suiteRevision: 2,
  requestDigest: schedulingRequestDigest(request),
  evidenceIDs: [AgentRuntime.EvidenceID.make("evd_multi_agent_golden")],
  baseline: {
    sampleSize: 3,
    succeeded: 3,
    totalDurationMs: 300,
    totalTokens: 300,
    totalCostMinor: 30,
    conflicts: 0,
  },
  multi: {
    sampleSize: 3,
    succeeded: 3,
    totalDurationMs: 150,
    totalTokens: 240,
    totalCostMinor: 24,
    conflicts: 0,
  },
  source: "replay",
  ...overrides,
})

describe("multi-agent scheduling benefit gate", () => {
  test("keeps an eligible decomposition as a candidate without evidence", () => {
    const decision = evaluateMultiAgentGate(request)
    expect(decision.action).toBe("candidate")
    expect(decision.executeMode).toBe("single")
    expect(decision.reasons).toEqual(["independent-read", "independent-dag-node"])
    expect(decision.failedChecks).toContain("fixed-dataset multi-agent benefit evidence is missing")
  })

  test("rejects writes and dependent nodes before any benefit evidence is considered", () => {
    const write = evaluateMultiAgentGate({
      ...request,
      tasks: [{ ...request.tasks[0]!, access: "write" }, request.tasks[1]!],
    })
    const dependent = evaluateMultiAgentGate({
      ...request,
      tasks: [request.tasks[0]!, { ...request.tasks[1]!, dependsOn: ["read-a"] }],
    })
    expect(write.action).toBe("single")
    expect(write.executeMode).toBe("single")
    expect(dependent.action).toBe("single")
    expect(dependent.executeMode).toBe("single")

    const cyclic = evaluateMultiAgentGate({
      ...request,
      tasks: [
        { ...request.tasks[0]!, dependsOn: ["read-b"] },
        { ...request.tasks[1]!, dependsOn: ["read-a"] },
      ],
    })
    expect(cyclic.action).toBe("single")
    expect(cyclic.failedChecks).toContain("task dependency graph must be acyclic")
  })

  test("recognizes an independent frontier inside a DAG and preserves transitive read dependencies", () => {
    const definition = {
      schema_version: 1,
      name: "dag-frontier",
      description: "",
      source_path: ".arforge/workflows/dag-frontier.json",
      steps: [
        {
          id: "read-a",
          title: "Read A",
          prompt: "",
          depends_on: [],
          continue_on_error: false,
          kind: "agent" as const,
          max_attempts: 1,
          when_step: "",
          when_statuses: [],
          access: "read" as const,
        },
        {
          id: "barrier",
          title: "Barrier",
          prompt: "",
          depends_on: ["read-a"],
          continue_on_error: false,
          kind: "command" as const,
          max_attempts: 1,
          when_step: "",
          when_statuses: [],
          access: "write" as const,
        },
        {
          id: "read-b",
          title: "Read B",
          prompt: "",
          depends_on: ["barrier"],
          continue_on_error: false,
          kind: "agent" as const,
          max_attempts: 1,
          when_step: "",
          when_statuses: [],
          access: "read" as const,
        },
        {
          id: "read-c",
          title: "Read C",
          prompt: "",
          depends_on: [],
          continue_on_error: false,
          kind: "agent" as const,
          max_attempts: 1,
          when_step: "",
          when_statuses: [],
          access: "read" as const,
        },
      ],
    }
    const dagRequest = workflowSchedulingRequest(definition, 3)
    expect(dagRequest.tasks.find((task) => task.id === "read-b")?.dependsOn).toEqual(["read-a"])
    const decision = evaluateMultiAgentGate(dagRequest)
    expect(decision.action).toBe("candidate")
    expect(decision.reasons).toEqual(["independent-dag-node"])
  })

  test("reports every approved structured split reason without enabling execution", () => {
    const decision = evaluateMultiAgentGate({
      ...request,
      signals: {
        specializedToolIsolation: true,
        riskIsolation: true,
        longContextIsolation: true,
      },
    })
    expect(decision.executeMode).toBe("single")
    expect(decision.reasons).toEqual([
      "independent-read",
      "independent-dag-node",
      "specialized-tool-isolation",
      "risk-isolation",
      "long-context-isolation",
    ])
  })

  test("enables multi-agent execution only when all approved comparisons pass", () => {
    const decision = evaluateMultiAgentGate(request, evidence(), policy)
    expect(decision.action).toBe("multi")
    expect(decision.executeMode).toBe("multi")
    expect(decision.failedChecks).toEqual([])
    expect(decision.comparison).toMatchObject({
      successRateDelta: 0,
      durationRatio: 0.5,
      tokenRatio: 0.8,
      costRatio: 0.8,
      conflictRateDelta: 0,
    })
    expect(decision.decisionDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("falls back to single-agent when benefit regresses or evidence is mismatched", () => {
    const regression = evaluateMultiAgentGate(
      request,
      evidence({
        multi: {
          sampleSize: 3,
          succeeded: 2,
          totalDurationMs: 600,
          totalTokens: 600,
          totalCostMinor: 60,
          conflicts: 1,
        },
      }),
      policy,
    )
    expect(regression.action).toBe("single")
    expect(regression.executeMode).toBe("single")
    expect(regression.failedChecks.length).toBeGreaterThan(0)

    const mismatch = evaluateMultiAgentGate(
      request,
      evidence({ requestDigest: "b".repeat(64) }),
      policy,
    )
    expect(mismatch.action).toBe("candidate")
    expect(mismatch.executeMode).toBe("single")
  })

  test("rejects unpaired or duplicate fixed-dataset evidence", () => {
    const unpaired = evaluateMultiAgentGate(
      request,
      evidence({
        multi: {
          sampleSize: 4,
          succeeded: 4,
          totalDurationMs: 200,
          totalTokens: 320,
          totalCostMinor: 32,
          conflicts: 0,
        },
      }),
      policy,
    )
    expect(unpaired.action).toBe("candidate")
    expect(unpaired.failedChecks).toContain("baseline and multi evidence must use the same fixed-dataset sample size")

    const duplicateID = AgentRuntime.EvidenceID.make("evd_multi_agent_duplicate")
    const duplicate = evaluateMultiAgentGate(request, evidence({ evidenceIDs: [duplicateID, duplicateID] }), policy)
    expect(duplicate.action).toBe("candidate")
    expect(duplicate.failedChecks).toContain("evidence IDs must be unique")
  })

  test("canonicalizes evidence references because their order has no semantic meaning", () => {
    const first = AgentRuntime.EvidenceID.make("evd_multi_agent_first")
    const second = AgentRuntime.EvidenceID.make("evd_multi_agent_second")
    expect(benefitEvidenceDigest(evidence({ evidenceIDs: [first, second] }))).toBe(
      benefitEvidenceDigest(evidence({ evidenceIDs: [second, first] })),
    )
  })

  test("aggregates and compares fixed observations deterministically", () => {
    const baseline = aggregateMetrics([
      { succeeded: true, durationMs: 10, tokens: 20, costMinor: 2, conflict: false },
      { succeeded: false, durationMs: 20, tokens: 30, costMinor: 3, conflict: true },
    ])
    const multi = aggregateMetrics([
      { succeeded: true, durationMs: 5, tokens: 15, costMinor: 1, conflict: false },
      { succeeded: true, durationMs: 5, tokens: 15, costMinor: 1, conflict: false },
    ])
    const comparison = compareBenefit(baseline, multi)
    expect(comparison.baseline.successRate).toBe(0.5)
    expect(comparison.multi.successRate).toBe(1)
    expect(comparison.conflictRateDelta).toBe(-0.5)
    expect(comparison.durationRatio).toBeCloseTo(1 / 3)
  })
})
