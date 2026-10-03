/**
 * Durable Workflow Graph adapter.
 *
 * Workflow graphs use the existing SessionRun aggregate as their durable
 * authority.  The graph definition, immutable artifact digest, node
 * projection, and workflow events live in a Run checkpoint; run status,
 * budget, lease, CAS, and recovery remain owned by DurableRun.  This keeps
 * the old SQL graph tables available as migration input without maintaining
 * a second writer or lease truth.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { SessionID } from "@arforge-ai/schema/session-id"
import { DateTime, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { canonicalHash } from "../util/canonical-hash"
import { DurableRun } from "../runtime/durable-run"
import { digest as runtimeDigest } from "../runtime/insight"
import {
  completionGate,
  createDefaultVerifierRegistry,
  freezeVerifierInput,
} from "../runtime/verifier"
import {
  MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
  evaluateMultiAgentGate,
  workflowSchedulingRequest,
  type MultiAgentBenefitComparison,
  type MultiAgentBenefitEvidence,
  type MultiAgentBenefitPolicy,
  type MultiAgentGateAction,
} from "../runtime/multi-agent-scheduling"
import { withWriteLane as acquireWriteLane, type WriteLanePolicy } from "../runtime/write-conflict-control"
import { AbsolutePath } from "../schema"
import {
  FAILURE_NODE_STATUSES,
  SUCCESS_NODE_STATUSES,
  TERMINAL_NODE_STATUSES,
  type NodeRecord,
  type RunRecord,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
  definitionPayload,
} from "./workflow-graph"

export const DURABLE_WORKFLOW_STATE_VERSION = 1
export const DURABLE_WORKFLOW_LEASE_TTL_MS = 30_000
export const DURABLE_WORKFLOW_MAX_EVENTS = 2_000
export const DURABLE_WORKFLOW_CHILD_MAX_DURATION_MS = 5 * 60_000

export class DurableWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DurableWorkflowError"
  }
}

export interface DurableWorkflowArtifact {
  readonly kind: "workflow-definition"
  readonly schema_version: number
  readonly source_path: string
  readonly digest: string
  readonly definition: Record<string, unknown>
}

export interface DurableWorkflowNodeState {
  readonly node_id: string
  readonly title: string
  readonly kind: WorkflowStepDefinition["kind"]
  readonly access: WorkflowStepDefinition["access"]
  readonly status: string
  readonly attempt: number
  readonly max_attempts: number
  readonly depends_on: ReadonlyArray<string>
  readonly continue_on_error: boolean
  readonly when_step: string
  readonly when_statuses: ReadonlyArray<string>
  readonly output: string
  readonly error: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly budget_reserved_attempts: number
  readonly child_run_id?: string
}

export interface DurableWorkflowEvent {
  readonly sequence: number
  readonly event_type: string
  readonly node_id: string
  readonly data: Record<string, unknown>
  readonly created_at: string
}

export interface DurableWorkflowBudgetState {
  max_attempts: number
  reserved_attempts: number
  used_attempts: number
  max_duration_ms: number
}

export interface DurableWorkflowSchedulingState {
  schema_version: typeof MULTI_AGENT_SCHEDULING_SCHEMA_VERSION
  request_digest: string
  requested_max_parallel: number
  effective_max_parallel: number
  action: MultiAgentGateAction
  execute_mode: "single" | "multi"
  eligible: boolean
  reasons: ReadonlyArray<string>
  failed_checks: ReadonlyArray<string>
  reason: string
  decision_digest: string
  evaluated_at: string
  evidence_digest?: string
  policy_revision?: string
  comparison?: MultiAgentBenefitComparison
}

export interface DurableWorkflowVerificationState {
  schema_version: 1
  action_kind: "workflow"
  action_version: "1"
  passed: boolean
  total: number
  passed_count: number
  failed_checks: ReadonlyArray<string>
  evidence_digest: string
  evaluated_at: string
}

export interface DurableWorkflowApprovalScope {
  definition_digest: string
  downstream: ReadonlyArray<string>
  requested_at: string
}

export interface DurableWorkflowState {
  version: typeof DURABLE_WORKFLOW_STATE_VERSION
  artifact: DurableWorkflowArtifact
  workspace: string
  permission_mode: string
  budget: DurableWorkflowBudgetState
  max_parallel: number
  scheduling: DurableWorkflowSchedulingState
  nodes: Record<string, DurableWorkflowNodeState>
  approval_scopes: Record<string, DurableWorkflowApprovalScope>
  verification?: DurableWorkflowVerificationState
  events: DurableWorkflowEvent[]
  last_error: string
}

export interface DurableWorkflowRuntimeOptions {
  readonly durableRun: DurableRun.Interface
  readonly ownerId?: string
  readonly maxParallelLimit?: number
  readonly scheduling?: {
    readonly evidence?: MultiAgentBenefitEvidence
    readonly policy?: MultiAgentBenefitPolicy
  }
  readonly runner?: (
    step: WorkflowStepDefinition,
    context: {
      readonly run_id: string
      readonly session_id: string
      readonly workspace: string
      readonly access: WorkflowStepDefinition["access"]
      readonly writeLane?: Pick<WriteLanePolicy, "mode" | "workspaceKey" | "policyDigest">
      readonly dependencies: Record<string, { status: string; output: string }>
      readonly child_run_id: string
      readonly signal: AbortSignal
    },
  ) => Promise<string>
  readonly commandRunner?: (
    step: WorkflowStepDefinition,
    context: {
      readonly run_id: string
      readonly session_id: string
      readonly workspace: string
      readonly access: WorkflowStepDefinition["access"]
      readonly writeLane?: Pick<WriteLanePolicy, "mode" | "workspaceKey" | "policyDigest">
      readonly dependencies: Record<string, { status: string; output: string }>
      readonly signal: AbortSignal
    },
  ) => Promise<string>
}

const terminalRunStatuses = new Set(["completed", "failed", "cancelled"])

const iso = (value: DateTime.Utc | undefined) => (value ? new Date(DateTime.toEpochMillis(value)).toISOString() : null)

const jsonRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const stringValue = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)

const numberValue = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const boolValue = (value: unknown) => value === true

const schedulingStateFromDecision = (
  decision: ReturnType<typeof evaluateMultiAgentGate>,
  requestedMaxParallel: number,
): DurableWorkflowSchedulingState => ({
  schema_version: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
  request_digest: decision.requestDigest,
  requested_max_parallel: requestedMaxParallel,
  effective_max_parallel: decision.executeMode === "multi" ? requestedMaxParallel : 1,
  action: decision.action,
  execute_mode: decision.executeMode,
  eligible: decision.eligible,
  reasons: [...decision.reasons],
  failed_checks: [...decision.failedChecks],
  reason: decision.reason,
  decision_digest: decision.decisionDigest,
  evaluated_at: new Date().toISOString(),
  ...(decision.evidenceDigest ? { evidence_digest: decision.evidenceDigest } : {}),
  ...(decision.policyRevision ? { policy_revision: decision.policyRevision } : {}),
  ...(decision.comparison ? { comparison: decision.comparison } : {}),
})

const decodeScheduling = (value: unknown, requestedMaxParallel: number): DurableWorkflowSchedulingState => {
  const record = jsonRecord(value)
  const rawAction = stringValue(record.action, "single")
  const action: MultiAgentGateAction = ["single", "candidate", "multi"].includes(rawAction)
    ? (rawAction as MultiAgentGateAction)
    : "single"
  const requested = Math.max(1, numberValue(record.requested_max_parallel, requestedMaxParallel))
  return {
    schema_version: MULTI_AGENT_SCHEDULING_SCHEMA_VERSION,
    request_digest: stringValue(record.request_digest),
    requested_max_parallel: requested,
    effective_max_parallel:
      action === "multi" ? Math.max(1, Math.min(requested, numberValue(record.effective_max_parallel, requested))) : 1,
    action,
    execute_mode: action === "multi" ? "multi" : "single",
    eligible: boolValue(record.eligible),
    reasons: Array.isArray(record.reasons) ? record.reasons.map(String) : [],
    failed_checks: Array.isArray(record.failed_checks) ? record.failed_checks.map(String) : [],
    reason: stringValue(record.reason, "legacy workflow run has no scheduling evidence; single-agent mode enforced"),
    decision_digest: stringValue(record.decision_digest),
    evaluated_at: stringValue(record.evaluated_at),
    ...(typeof record.evidence_digest === "string" ? { evidence_digest: record.evidence_digest } : {}),
    ...(typeof record.policy_revision === "string" ? { policy_revision: record.policy_revision } : {}),
    ...(record.comparison !== undefined
      ? { comparison: jsonRecord(record.comparison) as unknown as MultiAgentBenefitComparison }
      : {}),
  }
}

function decodeState(value: unknown): DurableWorkflowState {
  const record = jsonRecord(value)
  const artifactRecord = jsonRecord(record.artifact)
  const nodesRecord = jsonRecord(record.nodes)
  const verificationRecord = jsonRecord(record.verification)
  const events = Array.isArray(record.events) ? record.events : []
  const nodes: Record<string, DurableWorkflowNodeState> = {}
  for (const [nodeID, raw] of Object.entries(nodesRecord)) {
    const node = jsonRecord(raw)
    nodes[nodeID] = {
      node_id: stringValue(node.node_id, nodeID),
      title: stringValue(node.title, nodeID),
      kind: stringValue(node.kind, "agent") as WorkflowStepDefinition["kind"],
      access: stringValue(node.access, "read") === "write" ? "write" : "read",
      status: stringValue(node.status, "pending"),
      attempt: numberValue(node.attempt),
      max_attempts: Math.max(1, numberValue(node.max_attempts, 1)),
      depends_on: Array.isArray(node.depends_on) ? node.depends_on.map(String) : [],
      continue_on_error: boolValue(node.continue_on_error),
      when_step: stringValue(node.when_step),
      when_statuses: Array.isArray(node.when_statuses) ? node.when_statuses.map(String) : [],
      output: stringValue(node.output),
      error: stringValue(node.error),
      started_at: typeof node.started_at === "string" ? node.started_at : null,
      finished_at: typeof node.finished_at === "string" ? node.finished_at : null,
      budget_reserved_attempts: Math.max(0, numberValue(node.budget_reserved_attempts)),
      ...(typeof node.child_run_id === "string" ? { child_run_id: node.child_run_id } : {}),
    }
  }
  return {
    version: DURABLE_WORKFLOW_STATE_VERSION,
    artifact: {
      kind: "workflow-definition",
      schema_version: numberValue(artifactRecord.schema_version, 1),
      source_path: stringValue(artifactRecord.source_path),
      digest: stringValue(artifactRecord.digest),
      definition: jsonRecord(artifactRecord.definition),
    },
    workspace: stringValue(record.workspace),
    permission_mode: stringValue(record.permission_mode, "acceptEdits"),
    budget: {
      max_attempts: Math.max(
        1,
        numberValue(
          jsonRecord(record.budget).max_attempts,
          Object.values(nodes).reduce((sum, node) => sum + node.max_attempts, 0),
        ),
      ),
      reserved_attempts: Math.max(0, numberValue(jsonRecord(record.budget).reserved_attempts)),
      used_attempts: Math.max(0, numberValue(jsonRecord(record.budget).used_attempts)),
      max_duration_ms: Math.max(
        DURABLE_WORKFLOW_CHILD_MAX_DURATION_MS,
        numberValue(
          jsonRecord(record.budget).max_duration_ms,
          Math.max(
            30 * 60_000,
            Object.values(nodes).reduce((sum, node) => sum + node.max_attempts, 0) *
              DURABLE_WORKFLOW_CHILD_MAX_DURATION_MS,
          ),
        ),
      ),
    },
    max_parallel: Math.max(1, numberValue(record.max_parallel, 1)),
    scheduling: decodeScheduling(record.scheduling, Math.max(1, numberValue(record.max_parallel, 1))),
    nodes,
    approval_scopes: Object.fromEntries(
      Object.entries(jsonRecord(record.approval_scopes)).flatMap(([nodeID, raw]) => {
        const scope = jsonRecord(raw)
        return [
          [
            nodeID,
            {
              definition_digest: stringValue(scope.definition_digest),
              downstream: Array.isArray(scope.downstream) ? scope.downstream.map(String) : [],
              requested_at: stringValue(scope.requested_at),
            },
          ],
        ]
      }),
    ),
    ...(typeof record.verification === "object" && record.verification !== null
      ? {
          verification: {
            schema_version: 1 as const,
            action_kind: "workflow" as const,
            action_version: "1" as const,
            passed: boolValue(verificationRecord.passed),
            total: Math.max(0, numberValue(verificationRecord.total)),
            passed_count: Math.max(0, numberValue(verificationRecord.passed_count)),
            failed_checks: Array.isArray(verificationRecord.failed_checks)
              ? verificationRecord.failed_checks.map(String)
              : [],
            evidence_digest: stringValue(verificationRecord.evidence_digest),
            evaluated_at: stringValue(verificationRecord.evaluated_at),
          },
        }
      : {}),
    events: events.flatMap((item, sequence) => {
      const event = jsonRecord(item)
      return [
        {
          sequence: numberValue(event.sequence, sequence),
          event_type: stringValue(event.event_type),
          node_id: stringValue(event.node_id),
          data: jsonRecord(event.data),
          created_at: stringValue(event.created_at),
        },
      ]
    }),
    last_error: stringValue(record.last_error),
  }
}

const cloneState = (state: DurableWorkflowState): DurableWorkflowState =>
  JSON.parse(JSON.stringify(state)) as DurableWorkflowState

const stateDigest = (definition: WorkflowDefinition) => {
  const digest = canonicalHash(definitionPayload(definition))
  if (digest === undefined)
    throw new DurableWorkflowError("INVALID_DEFINITION", "workflow definition is not canonicalizable")
  return digest
}

const stateForDefinition = (
  definition: WorkflowDefinition,
  maxParallel: number,
  workspace: string,
  permissionMode: string,
  scheduling: DurableWorkflowSchedulingState,
): DurableWorkflowState => ({
  version: DURABLE_WORKFLOW_STATE_VERSION,
  artifact: {
    kind: "workflow-definition",
    schema_version: definition.schema_version,
    source_path: definition.source_path,
    digest: stateDigest(definition),
    definition: definitionPayload(definition),
  },
  workspace,
  permission_mode: permissionMode,
  budget: {
    max_attempts: Math.max(
      1,
      definition.steps.reduce((sum, step) => sum + step.max_attempts, 0),
    ),
    reserved_attempts: 0,
    used_attempts: 0,
    max_duration_ms: Math.max(
      30 * 60_000,
      definition.steps.reduce((sum, step) => sum + step.max_attempts, 0) * DURABLE_WORKFLOW_CHILD_MAX_DURATION_MS,
    ),
  },
  max_parallel: maxParallel,
  scheduling,
  nodes: Object.fromEntries(
    definition.steps.map((step) => [
      step.id,
      {
        node_id: step.id,
        title: step.title,
        kind: step.kind,
        access: step.access,
        status: "pending",
        attempt: 0,
        max_attempts: step.max_attempts,
        depends_on: [...step.depends_on],
        continue_on_error: step.continue_on_error,
        when_step: step.when_step,
        when_statuses: [...step.when_statuses],
        output: "",
        error: "",
        started_at: null,
        finished_at: null,
        budget_reserved_attempts: 0,
      } satisfies DurableWorkflowNodeState,
    ]),
  ),
  approval_scopes: {},
  events: [],
  last_error: "",
})

const now = () => new Date().toISOString()
const workflowPermissionModes = new Set(["plan", "acceptEdits", "fullAccess"])

const permissionRiskTier = (permissionMode: string): AgentRuntime.RiskTier => {
  switch (permissionMode) {
    case "plan":
      return "L0"
    case "acceptEdits":
      return "L2"
    default:
      return "L3"
  }
}

const riskRank: Record<AgentRuntime.RiskTier, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 }

const mutationNode = (step: WorkflowStepDefinition) =>
  step.kind === "command" || (step.kind === "agent" && step.access === "write")

const stepRunStatus = (status: string): AgentRuntime.RunStatus => {
  switch (status) {
    case "pending":
      return "queued"
    case "waiting_approval":
      return "awaiting_authorization"
    case "running":
      return "running"
    case "completed":
    case "skipped":
      return "completed"
    case "failed":
    case "blocked":
      return "failed"
    default:
      return "paused"
  }
}

export class DurableWorkflowGraphRuntime {
  readonly durableRun: DurableRun.Interface
  readonly ownerId: string
  readonly maxParallelLimit: number
  private readonly runner: NonNullable<DurableWorkflowRuntimeOptions["runner"]>
  private readonly commandRunner: DurableWorkflowRuntimeOptions["commandRunner"]
  private readonly schedulingEvidence?: MultiAgentBenefitEvidence
  private readonly schedulingPolicy?: MultiAgentBenefitPolicy
  private readonly verifierRegistry = createDefaultVerifierRegistry()
  private readonly loops = new Set<string>()
  private readonly controllers = new Map<string, Map<string, AbortController>>()

  constructor(options: DurableWorkflowRuntimeOptions) {
    this.durableRun = options.durableRun
    this.ownerId = options.ownerId ?? `workflow-${randomUUID().replaceAll("-", "")}`
    this.maxParallelLimit = options.maxParallelLimit ?? 8
    this.runner = options.runner ?? (async (step) => step.prompt)
    this.commandRunner = options.commandRunner
    this.schedulingEvidence = options.scheduling?.evidence
    this.schedulingPolicy = options.scheduling?.policy
  }

  /** Kept for callers during cutover; the durable event store owns the schema. */
  async ensureSchema(): Promise<void> {}

  async createRun(input: {
    definition: WorkflowDefinition
    sessionId: string
    workspace: string
    permissionMode?: string
    maxParallel?: number
    runID?: AgentRuntime.RunID
  }): Promise<RunRecord> {
    const maxParallel = input.maxParallel ?? 4
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > this.maxParallelLimit)
      throw new DurableWorkflowError("INVALID_PARAMS", `max_parallel must be between 1 and ${this.maxParallelLimit}`)
    const sessionText = input.sessionId.trim()
    if (!sessionText) throw new DurableWorkflowError("INVALID_PARAMS", "session_id must not be empty")
    const permissionMode = input.permissionMode ?? "acceptEdits"
    if (!workflowPermissionModes.has(permissionMode))
      throw new DurableWorkflowError("INVALID_PARAMS", `unsupported permission_mode: ${permissionMode}`)
    const definitionDigest = stateDigest(input.definition)
    const schedulingRequest = workflowSchedulingRequest(input.definition, maxParallel)
    const schedulingDecision = evaluateMultiAgentGate(schedulingRequest, this.schedulingEvidence, this.schedulingPolicy)
    const scheduling = schedulingStateFromDecision(schedulingDecision, maxParallel)
    const state = stateForDefinition(input.definition, maxParallel, input.workspace, permissionMode, scheduling)
    const sessionID = SessionID.make(sessionText)
    if (input.runID) {
      try {
        const existing = await this.snapshot(input.runID)
        const existingState = this.state(existing)
        if (existingState.artifact.digest === definitionDigest) return this.runRecord(existing)
        throw new DurableWorkflowError(
          "RUN_DIGEST_CONFLICT",
          "the workflow run ID is bound to a different definition digest",
        )
      } catch (error) {
        if (error instanceof DurableWorkflowError && error.code === "RUN_DIGEST_CONFLICT") throw error
        if (error instanceof DurableWorkflowError && error.code !== "NOT_WORKFLOW_RUN") throw error
      }
    }
    const budget = AgentRuntime.Budget.make({
      maxAttempts: state.budget.max_attempts,
      maxDurationMs: state.budget.max_duration_ms,
      maxCostMicros: Math.max(1, state.budget.max_attempts),
      maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    })
    const canMutateWorkspace =
      permissionMode !== "plan" && input.definition.steps.some((step) => step.access === "write")
    const created = await Effect.runPromise(
      this.durableRun.create({
        ...(input.runID ? { id: input.runID } : {}),
        sessionID,
        initiator: "user",
        authority: "human",
        riskTier: canMutateWorkspace ? permissionRiskTier(permissionMode) : "L0",
        reasonSummary: `workflow ${input.definition.name}`,
        budget,
        traceID: input.runID ?? `workflow:${definitionDigest}`,
        visibility: "details",
        project: ProjectID.global,
        location: AbsolutePath.make(input.workspace),
        delegableCapabilities: [
          {
            action: "*",
            resources: ["workspace"],
            access: canMutateWorkspace ? "write" : "read",
          },
        ],
      }),
    )
    const initialEvent = this.event(state, "graph.created", "", {
      definition_digest: definitionDigest,
      nodes: input.definition.steps.length,
    })
    state.events = [initialEvent]
    const schedulingEvent = this.event(state, "scheduling.gate_evaluated", "", {
      schema_version: scheduling.schema_version,
      request_digest: scheduling.request_digest,
      requested_max_parallel: scheduling.requested_max_parallel,
      effective_max_parallel: scheduling.effective_max_parallel,
      action: scheduling.action,
      execute_mode: scheduling.execute_mode,
      eligible: scheduling.eligible,
      reasons: scheduling.reasons,
      failed_checks: scheduling.failed_checks,
      reason: scheduling.reason,
      decision_digest: scheduling.decision_digest,
      ...(scheduling.evidence_digest ? { evidence_digest: scheduling.evidence_digest } : {}),
      ...(scheduling.policy_revision ? { policy_revision: scheduling.policy_revision } : {}),
    })
    await Effect.runPromise(
      this.durableRun.checkpoint({
        runID: created.run.id,
        state: { ...state, events: [...state.events, schedulingEvent] },
      }),
    )
    return this.runRecord(await this.snapshot(created.run.id))
  }

  async start(runId: string): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    if (terminalRunStatuses.has(snapshot.run.status) || this.isWaitingApproval(snapshot))
      return this.runRecord(snapshot)
    let current = snapshot
    if (current.run.status === "draft") current = await this.transition(runId, "preflight", "workflow preflight sealed")
    if (current.run.status === "preflight") current = await this.transition(runId, "queued", "workflow queued")
    if (current.run.status === "queued" || current.run.status === "paused")
      current = await this.transition(runId, "running", "workflow worker started")
    if (!this.loops.has(runId)) {
      this.loops.add(runId)
      void this.drive(runId).finally(() => this.loops.delete(runId))
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async pause(runId: string): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    if (terminalRunStatuses.has(snapshot.run.status)) return this.runRecord(snapshot)
    if (snapshot.run.status === "running" || snapshot.run.status === "queued") {
      const current = await this.snapshot(runId)
      if (current.run.status === "running" || current.run.status === "queued")
        await this.transition(runId, "paused", "workflow paused by user")
      this.abortControllers(runId)
      await this.propagateChildren(runId, "paused")
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async cancel(runId: string): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    if (!terminalRunStatuses.has(snapshot.run.status)) {
      this.abortControllers(runId)
      await Effect.runPromise(
        this.durableRun.cancel({
          runID: AgentRuntime.RunID.make(runId),
          reason: "workflow cancelled by user",
          recursive: true,
        }),
      )
      await this.propagateChildren(runId, "cancelled")
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async resume(runId: string): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    if (snapshot.run.status === "paused") {
      if (this.isWaitingApproval(snapshot)) return this.runRecord(snapshot)
      const state = cloneState(this.state(snapshot))
      for (const [nodeId, node] of Object.entries(state.nodes)) {
        if (node.status !== "paused") continue
        state.nodes[nodeId] = {
          ...node,
          status: "pending",
          attempt: 0,
          output: "",
          error: "",
          started_at: null,
          finished_at: null,
          ...("child_run_id" in node ? { child_run_id: undefined } : {}),
        }
      }
      this.addEvent(state, "workflow.resumed", "", {})
      await this.save(runId, state)
      await this.transition(runId, "queued", "workflow resumed")
      await this.transition(runId, "running", "workflow worker restarted")
    }
    if (!this.loops.has(runId)) {
      this.loops.add(runId)
      void this.drive(runId).finally(() => this.loops.delete(runId))
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async decideApproval(runId: string, nodeId: string, approved: boolean, comment = ""): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    const state = cloneState(this.state(snapshot))
    const node = state.nodes[nodeId]
    if (!node || node.status !== "waiting_approval")
      throw new DurableWorkflowError("NODE_NOT_PENDING", `node is not waiting for approval: ${nodeId}`)
    const scope = state.approval_scopes[nodeId]
    if (!scope || scope.definition_digest !== state.artifact.digest)
      throw new DurableWorkflowError("APPROVAL_SCOPE_INVALID", `approval scope is not frozen for node: ${nodeId}`)
    state.nodes[nodeId] = {
      ...node,
      status: approved ? "completed" : "failed",
      output: approved ? JSON.stringify({ approved: true, comment, downstream: scope.downstream }) : "",
      error: approved ? "" : comment || "approval rejected",
      finished_at: now(),
    }
    state.events = [
      ...state.events,
      this.event(state, approved ? "node.approved" : "node.rejected", nodeId, {
        comment,
        definition_digest: scope.definition_digest,
        downstream: scope.downstream,
      }),
    ]
    await this.save(snapshot.run.id, state)
    if (snapshot.run.status === "paused") {
      await this.transition(runId, "queued", "workflow approval resolved")
      await this.transition(runId, "running", "workflow approval resumed")
      if (!this.loops.has(runId)) {
        this.loops.add(runId)
        void this.drive(runId).finally(() => this.loops.delete(runId))
      }
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async recover(runId: string): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    if (terminalRunStatuses.has(snapshot.run.status) || snapshot.run.status === "paused")
      return this.runRecord(snapshot)
    if (snapshot.run.status === "running") {
      const orphaned = await Effect.runPromise(this.durableRun.orphaned(this.session(snapshot)))
      if (!orphaned.some((item) => item.run.id === snapshot.run.id)) return this.runRecord(snapshot)
      await this.transition(runId, "recovering", "workflow lease owner recovery")
    }
    const recovering = await this.snapshot(runId)
    if (recovering.run.status !== "recovering") return this.runRecord(recovering)
    const state = cloneState(this.state(recovering))
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (node.status !== "running") continue
      if (!node.child_run_id) {
        state.nodes[nodeId] = { ...node, status: "pending", started_at: null, finished_at: null }
        this.addEvent(state, "node.recovered_retry", nodeId, { reason: "running node had no child run checkpoint" })
        continue
      }
      const child = await Effect.runPromise(this.durableRun.load(AgentRuntime.RunID.make(node.child_run_id)))
      if (child.run.status === "completed") {
        state.nodes[nodeId] = {
          ...node,
          status: "completed",
          output: node.output || `recovered child run ${node.child_run_id}`,
          error: "",
          finished_at: now(),
        }
        this.addEvent(state, "node.recovered", nodeId, { child_run_id: node.child_run_id, status: child.run.status })
        continue
      }
      if (!terminalRunStatuses.has(child.run.status)) {
        if (child.run.status === "running" || child.run.status === "recovering") {
          if (DurableRun.canTransition(child.run.status, "failed"))
            await Effect.runPromise(
              this.durableRun.transition({
                runID: child.run.id,
                to: "failed",
                reason: "child run orphaned with no resumable worker",
              }),
            )
        } else if (DurableRun.canTransition(child.run.status, "cancelled")) {
          await Effect.runPromise(
            this.durableRun.transition({
              runID: child.run.id,
              to: "cancelled",
              reason: "child run orphaned before execution",
            }),
          )
        }
      }
      state.nodes[nodeId] = {
        ...node,
        status: "pending",
        started_at: null,
        finished_at: null,
        ...("child_run_id" in node ? { child_run_id: undefined } : {}),
      }
      this.addEvent(state, "node.recovered_retry", nodeId, { child_run_id: node.child_run_id })
    }
    await this.save(runId, state)
    await this.transition(runId, "running", "workflow recovery resumed")
    if (!this.loops.has(runId)) {
      this.loops.add(runId)
      void this.drive(runId).finally(() => this.loops.delete(runId))
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async retryNode(runId: string, nodeId: string, includeDescendants = false): Promise<RunRecord> {
    const snapshot = await this.snapshot(runId)
    const state = cloneState(this.state(snapshot))
    const node = state.nodes[nodeId]
    if (!node || !FAILURE_NODE_STATUSES.has(node.status))
      throw new DurableWorkflowError(
        "NODE_NOT_RETRYABLE",
        `node cannot be retried in status ${node?.status ?? "missing"}`,
      )
    if (state.budget.used_attempts >= state.budget.max_attempts)
      throw new DurableWorkflowError("BUDGET_EXHAUSTED", "workflow retry exceeds the parent attempt budget")
    const affected = new Set([nodeId])
    if (includeDescendants) {
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of Object.values(state.nodes)) {
          if (candidate.depends_on.some((dependency) => affected.has(dependency)) && !affected.has(candidate.node_id)) {
            affected.add(candidate.node_id)
            changed = true
          }
        }
      }
    }
    for (const id of affected) {
      const current = state.nodes[id]!
      state.nodes[id] = {
        ...current,
        status: "pending",
        attempt: 0,
        output: "",
        error: "",
        started_at: null,
        finished_at: null,
      }
    }
    state.events = [
      ...state.events,
      this.event(state, "node.retry_requested", nodeId, { descendants: affected.size - 1 }),
    ]
    await this.save(runId, state)
    if (snapshot.run.status === "failed") await this.transition(runId, "recovering", "workflow node retry requested")
    if (["recovering", "paused"].includes((await this.snapshot(runId)).run.status))
      await this.transition(runId, "queued", "workflow retry queued")
    if ((await this.snapshot(runId)).run.status === "queued")
      await this.transition(runId, "running", "workflow retry started")
    if (!this.loops.has(runId)) {
      this.loops.add(runId)
      void this.drive(runId).finally(() => this.loops.delete(runId))
    }
    return this.runRecord(await this.snapshot(runId))
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.runRecord(await this.snapshot(runId))
  }

  async listRuns(input: { sessionId?: string; limit?: number } = {}) {
    const snapshots = await Effect.runPromise(
      this.durableRun.list({
        ...(input.sessionId ? { sessionID: SessionID.make(input.sessionId) } : {}),
        limit: Math.min(Math.max(input.limit ?? 50, 1), 500),
      }),
    )
    const items: Record<string, unknown>[] = []
    for (const snapshot of snapshots) {
      try {
        const loaded = await this.snapshot(snapshot.run.id)
        if (this.isWorkflow(loaded)) items.push(this.runRecord(loaded) as unknown as Record<string, unknown>)
      } catch {}
    }
    return { schema_version: 1, count: items.length, items }
  }

  async events(runId: string, after = 0, limit = 200) {
    const state = this.state(await this.snapshot(runId))
    const items = state.events.filter((event) => event.sequence > after).slice(0, Math.min(Math.max(limit, 1), 500))
    return {
      schema_version: 1,
      count: items.length,
      items: items.map((event) => ({
        run_id: runId,
        sequence: event.sequence,
        event_type: event.event_type,
        node_id: event.node_id,
        data_json: JSON.stringify(event.data),
        created_at: event.created_at,
      })),
    }
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<RunRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const run = await this.getRun(runId)
      if (terminalRunStatuses.has(run.status) || run.status === "waiting_approval" || Date.now() >= deadline) return run
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }

  async nodesFor(runId: string): Promise<Map<string, NodeRecord>> {
    const snapshot = await this.snapshot(runId)
    const state = this.state(snapshot)
    return new Map(
      Object.values(state.nodes).map((node) => [
        node.node_id,
        {
          run_id: runId,
          node_id: node.node_id,
          position: Object.keys(state.nodes).indexOf(node.node_id),
          title: node.title,
          kind: node.kind,
          access: node.access,
          status: node.status,
          attempt: node.attempt,
          max_attempts: node.max_attempts,
          depends_on_json: JSON.stringify(node.depends_on),
          continue_on_error: node.continue_on_error,
          when_step: node.when_step,
          when_statuses_json: JSON.stringify(node.when_statuses),
          output: node.output,
          error: node.error,
          started_at: node.started_at,
          finished_at: node.finished_at,
          budget_reserved_attempts: node.budget_reserved_attempts,
          ...(node.child_run_id ? { child_run_id: node.child_run_id } : {}),
        } satisfies NodeRecord,
      ]),
    )
  }

  /** Project graph nodes into the canonical AgentRuntime.Step contract. */
  async stepsFor(runId: string): Promise<ReadonlyArray<AgentRuntime.Step>> {
    const snapshot = await this.snapshot(runId)
    const state = this.state(snapshot)
    const run = snapshot.run
    return Object.values(state.nodes).map((node, sequence) =>
      AgentRuntime.Step.make({
        id: AgentRuntime.StepID.make(`stp_${run.id}_${node.node_id}`),
        runID: run.id,
        title: node.title,
        status: stepRunStatus(node.status),
        sequence,
        ...(snapshot.checkpoint ? { checkpointID: snapshot.checkpoint.id } : {}),
        initiator: run.initiator,
        authority: run.authority,
        riskTier: run.riskTier,
        reasonSummary: `workflow step ${node.node_id}`,
        budget: run.budget,
        traceID: `${run.traceID}:step:${node.node_id}`,
        ...(run.parentTraceID ? { parentTraceID: run.parentTraceID } : {}),
        visibility: run.visibility,
      }),
    )
  }

  private async drive(runId: string): Promise<void> {
    let lease: AgentRuntime.RunLease | undefined
    try {
      const acquired = await Effect.runPromise(
        this.durableRun.acquireLease({
          runID: AgentRuntime.RunID.make(runId),
          ownerID: this.ownerId,
          ttlMs: DURABLE_WORKFLOW_LEASE_TTL_MS,
        }),
      )
      lease = acquired.lease
      for (;;) {
        const snapshot = await this.snapshot(runId)
        if (snapshot.run.status !== "running") return
        const state = cloneState(this.state(snapshot))
        const definition = this.definition(state)
        const nodes = state.nodes
        const runnable: WorkflowStepDefinition[] = []
        let changed = false
        for (const step of definition.steps) {
          const node = nodes[step.id]!
          if (node.status !== "pending") continue
          const dependencies = step.depends_on
            .map((id) => nodes[id])
            .filter((item): item is DurableWorkflowNodeState => item !== undefined)
          if (dependencies.some((item) => !TERMINAL_NODE_STATUSES.has(item.status))) continue
          const failed = dependencies.filter(
            (item) => FAILURE_NODE_STATUSES.has(item.status) && !item.continue_on_error,
          )
          if (failed.length > 0) {
            this.settle(
              state,
              step.id,
              "blocked",
              `blocked by failed dependency: ${failed.map((item) => item.node_id).join(", ")}`,
              "",
            )
            changed = true
            continue
          }
          if (step.when_step && !step.when_statuses.includes(nodes[step.when_step]?.status ?? "")) {
            this.settle(
              state,
              step.id,
              "skipped",
              `condition not met: ${step.when_step}=${nodes[step.when_step]?.status}`,
              "",
            )
            changed = true
            continue
          }
          if (state.permission_mode === "plan" && mutationNode(step)) {
            this.settle(
              state,
              step.id,
              "blocked",
              "workflow permission_mode=plan forbids mutation nodes",
              "permission denied",
            )
            this.addEvent(state, "node.capability_denied", step.id, {
              permission_mode: state.permission_mode,
              access: step.access,
              kind: step.kind,
            })
            changed = true
            continue
          }
          if (step.kind === "approval") {
            const downstream = this.downstreamFor(state, step.id)
            const scope = state.approval_scopes[step.id]
            if (!scope) {
              state.approval_scopes[step.id] = {
                definition_digest: state.artifact.digest,
                downstream,
                requested_at: now(),
              }
            }
            state.nodes[step.id] = {
              ...node,
              status: "waiting_approval",
              started_at: node.started_at ?? now(),
              finished_at: null,
            }
            this.addEvent(state, "node.approval_requested", step.id, {
              title: step.title,
              prompt: step.prompt,
              definition_digest: state.artifact.digest,
              downstream: state.approval_scopes[step.id]?.downstream ?? downstream,
            })
            changed = true
            continue
          }
          if (step.kind === "checkpoint") {
            this.settle(state, step.id, "completed", step.prompt || "workflow checkpoint reached", "")
            changed = true
            continue
          }
          runnable.push(step)
        }
        if (changed) {
          await this.save(runId, state)
          if (runnable.length === 0) continue
        }
        if (runnable.length === 0) {
          const statuses = Object.values(nodes).map((node) => node.status)
          if (statuses.some((status) => status === "waiting_approval")) {
            await this.transition(runId, "paused", "workflow awaits approval")
          } else if (statuses.every((status) => SUCCESS_NODE_STATUSES.has(status))) {
            await this.transition(runId, "verifying", "workflow nodes settled")
            const verifying = await this.snapshot(runId)
            const verifyingState = cloneState(this.state(verifying))
            const verification = await this.verifyWorkflowCompletion(verifying, verifyingState)
            verifyingState.verification = verification.verification
            this.addEvent(verifyingState, "workflow.verification_completed", "", {
              passed: verification.gate.allowed,
              total: verification.gate.summary.total,
              passed_count: verification.gate.summary.passedCount,
              failed_checks: verification.gate.summary.failedChecks,
              evidence_digest: verification.verification.evidence_digest,
            })
            if (verification.gate.allowed) {
              await this.save(runId, verifyingState)
              await this.transition(runId, "completed", "workflow independent verifier passed")
            } else {
              verifyingState.last_error = `workflow verifier failed: ${verification.gate.summary.failedChecks.join(", ")}`
              await this.save(runId, verifyingState)
              await this.transition(runId, "failed", verifyingState.last_error)
            }
          } else if (statuses.some((status) => FAILURE_NODE_STATUSES.has(status))) {
            state.last_error = "one or more workflow nodes did not complete"
            await this.save(runId, state)
            await this.transition(runId, "failed", state.last_error)
          } else {
            await this.transition(runId, "failed", "workflow graph has no runnable nodes")
          }
          return
        }
        const writeNode = runnable.find((step) => step.access === "write")
        const batch = writeNode ? [writeNode] : runnable.slice(0, state.scheduling.effective_max_parallel)
        const additionalBudget = batch.reduce((sum, step) => {
          const node = state.nodes[step.id]!
          return sum + (node.budget_reserved_attempts > 0 ? 0 : step.max_attempts)
        }, 0)
        if (state.budget.reserved_attempts + additionalBudget > state.budget.max_attempts) {
          for (const step of batch)
            this.settle(state, step.id, "blocked", "child workflow budget exceeds parent budget", "budget denied")
          this.addEvent(state, "workflow.budget_denied", "", {
            reserved_attempts: state.budget.reserved_attempts,
            requested_attempts: additionalBudget,
            max_attempts: state.budget.max_attempts,
          })
          await this.save(runId, state)
          continue
        }
        state.budget.reserved_attempts += additionalBudget
        for (const step of batch) {
          const current = state.nodes[step.id]!
          state.nodes[step.id] = {
            ...current,
            status: "running",
            attempt: current.attempt + 1,
            started_at: current.started_at ?? now(),
            finished_at: null,
            budget_reserved_attempts: current.budget_reserved_attempts || step.max_attempts,
          }
          this.addEvent(state, "node.started", step.id, {
            kind: step.kind,
            access: step.access,
            ...(step.access === "write" ? { write_lane: "workspace-exclusive" } : {}),
          })
        }
        await this.save(runId, state)
        const execute = (step: WorkflowStepDefinition, writeLane?: WriteLanePolicy) => {
          const controller = this.controllerFor(runId, step.id)
          return this.executeNode(runId, step, state, controller.signal, writeLane).finally(() => {
            this.clearController(runId, step.id)
          })
        }
        const results = writeNode
          ? await this.withWorkspaceWriteLane(
              runId,
              writeNode,
              state,
              this.controllerFor(runId, writeNode.id).signal,
              (writeLane) => Promise.all(batch.map((step) => execute(step, writeLane))),
            )
          : await Promise.all(batch.map((step) => execute(step)))
        const currentParent = await this.snapshot(runId)
        if (currentParent.run.status !== "running" || results.some((result) => result.status === "interrupted")) return
        const settled = cloneState(this.state(currentParent))
        for (const [index, step] of batch.entries()) {
          const result = results[index]!
          const current = settled.nodes[step.id]!
          settled.budget.used_attempts += result.attempt
          settled.nodes[step.id] = {
            ...current,
            status: result.status,
            output: result.output,
            error: result.error,
            attempt: result.attempt,
            ...(result.childRunId ? { child_run_id: result.childRunId } : {}),
            finished_at: now(),
          }
          this.addEvent(settled, `node.${result.status}`, step.id, { attempts: result.attempt })
        }
        await this.save(runId, settled)
        if (lease) {
          try {
            const renewed = await Effect.runPromise(
              this.durableRun.heartbeat({
                runID: AgentRuntime.RunID.make(runId),
                leaseID: lease.id,
                ownerID: lease.ownerID,
                ttlMs: DURABLE_WORKFLOW_LEASE_TTL_MS,
              }),
            )
            lease = renewed.lease
          } catch {
            return
          }
        }
      }
    } catch (error) {
      if (error instanceof DurableWorkflowError && error.code === "WORKFLOW_INTERRUPTED") return
      try {
        const snapshot = await this.snapshot(runId)
        if (!terminalRunStatuses.has(snapshot.run.status) && ["running", "verifying"].includes(snapshot.run.status))
          await this.transition(runId, "failed", error instanceof Error ? error.message : String(error))
      } catch {}
    } finally {
      if (lease) {
        await Effect.runPromise(
          this.durableRun.releaseLease({
            runID: AgentRuntime.RunID.make(runId),
            leaseID: lease.id,
            ownerID: lease.ownerID,
            reason: "workflow worker finished",
          }),
        ).catch(() => undefined)
      }
    }
  }

  private async executeNode(
    runId: string,
    step: WorkflowStepDefinition,
    state: DurableWorkflowState,
    signal: AbortSignal,
    writeLane?: WriteLanePolicy,
  ) {
    const parent = await this.snapshot(runId)
    const dependencies = Object.fromEntries(
      step.depends_on.map((id) => [
        id,
        { status: state.nodes[id]?.status ?? "missing", output: state.nodes[id]?.output ?? "" },
      ]),
    )
    let lastError = ""
    for (let attempt = 1; attempt <= step.max_attempts; attempt++) {
      try {
        if (step.kind === "command") {
          if (!this.commandRunner)
            throw new DurableWorkflowError("GATEWAY_REQUIRED", "workflow command nodes require a Shell Action executor")
          return {
            status: "completed",
            output: await this.commandRunner(step, {
              run_id: runId,
              session_id: this.session(parent),
              workspace: this.workspace(parent),
              access: step.access,
              ...(writeLane ? { writeLane: writeLaneContext(writeLane) } : {}),
              dependencies,
              signal,
            }),
            error: "",
            attempt,
          }
        }
        const child = await this.createChildRun(parent, step, state, attempt)
        await this.registerChildRun(runId, step.id, child.run.id)
        try {
          const output = await this.runner(step, {
            run_id: runId,
            session_id: this.session(parent),
            workspace: this.workspace(parent),
            access: step.access,
            ...(writeLane ? { writeLane: writeLaneContext(writeLane) } : {}),
            dependencies,
            child_run_id: child.run.id,
            signal,
          })
          await this.finishChild(child.run.id, "completed", "workflow agent node completed", output)
          return { status: "completed", output: output.slice(0, 100_000), error: "", attempt, childRunId: child.run.id }
        } catch (error) {
          if (signal.aborted) {
            const parentAfterAbort = await this.snapshot(runId)
            if (parentAfterAbort.run.status === "cancelled")
              await Effect.runPromise(
                this.durableRun.cancel({
                  runID: child.run.id,
                  reason: "workflow node interrupted",
                  recursive: true,
                }),
              )
            else if (parentAfterAbort.run.status === "paused") {
              const childAfterAbort = await Effect.runPromise(this.durableRun.load(child.run.id))
              if (
                !terminalRunStatuses.has(childAfterAbort.run.status) &&
                DurableRun.canTransition(childAfterAbort.run.status, "paused")
              )
                await Effect.runPromise(
                  this.durableRun.transition({
                    runID: child.run.id,
                    to: "paused",
                    reason: "parent workflow paused",
                  }),
                )
            }
          } else {
            await this.finishChild(child.run.id, "failed", error instanceof Error ? error.message : String(error))
          }
          throw error
        }
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
      }
    }
    if (signal.aborted)
      return { status: "interrupted", output: "", error: "workflow interrupted", attempt: step.max_attempts }
    return { status: "failed", output: "", error: lastError, attempt: step.max_attempts }
  }

  private async createChildRun(
    parent: DurableRun.Snapshot,
    step: WorkflowStepDefinition,
    state: DurableWorkflowState,
    attempt: number,
  ) {
    const childRiskTier: AgentRuntime.RiskTier = step.access === "read" ? "L0" : "L2"
    if (riskRank[childRiskTier] > riskRank[parent.run.riskTier])
      throw new DurableWorkflowError("CAPABILITY_DENIED", `child node ${step.id} exceeds parent risk tier`)
    const childDuration = Math.max(1, Math.floor(state.budget.max_duration_ms / Math.max(1, state.budget.max_attempts)))
    if (!("sessionID" in parent.run))
      throw new DurableWorkflowError("INVALID_PARENT", "workflow parent must be a SessionRun")
    const project = parent.run.project ?? ProjectID.global
    const location = parent.run.location ?? AbsolutePath.make(state.workspace)
    const childMaxTokens = Math.max(
      1,
      Math.floor(parent.run.budget.maxTokens / Math.max(1, state.scheduling.effective_max_parallel)),
    )
    const capabilities: ReadonlyArray<AgentRuntime.ChildCapability> = [
      { action: "*", resources: ["workspace"], access: step.access },
    ]
    const child = await Effect.runPromise(
      this.durableRun.createChild({
        parentRunID: parent.run.id,
        sessionID: parent.run.sessionID,
        idempotencyKey: `workflow:${step.id}:attempt:${attempt}`,
        delegatedObjective: step.prompt,
        allowedCapabilities: capabilities,
        project,
        location,
        expectedDeliverable: {
          summaryRequired: true,
          artifactKinds: [],
          evidenceKinds: [],
          verifier: "workflow",
        },
        deadlineAt: DateTime.makeUnsafe(Date.now() + childDuration),
        initiator: "agent",
        authority: step.access === "read" ? "automatic" : "scoped_grant",
        riskTier: childRiskTier,
        reasonSummary: `workflow node ${step.id} attempt ${attempt}`,
        traceID: `${parent.run.traceID}:${step.id}:${attempt}`,
        parentTraceID: parent.run.traceID,
        visibility: "details",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 1,
          maxDurationMs: childDuration,
          maxCostMicros: 1,
          maxTokens: childMaxTokens,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
      }),
    )
    await this.finishChild(child.run.id, "running", "workflow child run started")
    return child
  }

  private controllerFor(runId: string, nodeId: string) {
    let runControllers = this.controllers.get(runId)
    if (!runControllers) {
      runControllers = new Map()
      this.controllers.set(runId, runControllers)
    }
    let controller = runControllers.get(nodeId)
    if (!controller) {
      controller = new AbortController()
      runControllers.set(nodeId, controller)
    }
    return controller
  }

  private clearController(runId: string, nodeId: string) {
    const runControllers = this.controllers.get(runId)
    runControllers?.delete(nodeId)
    if (runControllers?.size === 0) this.controllers.delete(runId)
  }

  private abortControllers(runId: string) {
    for (const controller of this.controllers.get(runId)?.values() ?? []) controller.abort()
  }

  private async propagateChildren(runId: string, status: "paused" | "cancelled") {
    const snapshot = await this.snapshot(runId)
    const state = cloneState(this.state(snapshot))
    let changed = false
    for (const [nodeId, node] of Object.entries(state.nodes)) {
      if (!node.child_run_id) continue
      let child = await Effect.runPromise(this.durableRun.load(AgentRuntime.RunID.make(node.child_run_id)))
      if (status === "paused" && child.activeAttempt) {
        await Effect.runPromise(
          this.durableRun.finishAttempt({
            runID: child.run.id,
            attempt: child.activeAttempt.attempt,
            outcome: "interrupted",
            durationMs: Math.max(0, Date.now() - DateTime.toEpochMillis(child.activeAttempt.startedAt)),
            costMicros: 0,
            tokens: 0,
          }),
        )
        child = await Effect.runPromise(this.durableRun.load(child.run.id))
      }
      if (!terminalRunStatuses.has(child.run.status) && DurableRun.canTransition(child.run.status, status)) {
        if (status === "cancelled")
          await Effect.runPromise(
            this.durableRun.cancel({ runID: child.run.id, reason: "parent workflow cancelled", recursive: true }),
          )
        else
          await Effect.runPromise(
            this.durableRun.transition({
              runID: child.run.id,
              to: status,
              reason: `parent workflow ${status}`,
            }),
          )
        changed = true
      }
      if ((status === "cancelled" && ["running", "paused"].includes(node.status)) || node.status === "running") {
        state.nodes[nodeId] = { ...node, status }
        this.addEvent(state, `node.${status}`, nodeId, { child_run_id: node.child_run_id, propagated: true })
        changed = true
      }
    }
    if (changed) await this.save(runId, state)
  }

  private async verifyWorkflowCompletion(snapshot: DurableRun.Snapshot, state: DurableWorkflowState) {
    const nodes = Object.values(state.nodes)
    const requiredStepsSettled = nodes.length > 0 && nodes.every((node) => SUCCESS_NODE_STATUSES.has(node.status))
    const actionsSettled =
      nodes.length > 0 &&
      nodes.every((node) => TERMINAL_NODE_STATUSES.has(node.status) && node.finished_at !== null)
    const observationValues = { requiredStepsSettled, actionsSettled, settledNodeCount: nodes.length }
    const observationDigest = canonicalHash(observationValues) ?? ""
    const bindingDigest =
      canonicalHash({ run_id: snapshot.run.id, definition_digest: state.artifact.digest }) ?? snapshot.run.id
    const evidence = await this.verifierRegistry.verify(
      freezeVerifierInput({
        frozenIntent: {
          actionKind: "workflow",
          actionVersion: "1",
          intentDigest: state.artifact.digest,
          payload: state.artifact.definition,
        },
        observation: {
          status: requiredStepsSettled && actionsSettled ? "succeeded" : "failed",
          observationDigest,
          summary: `workflow nodes settled: ${nodes.length}`,
          values: observationValues,
        },
        artifactRefs: [
          {
            kind: state.artifact.kind,
            ref: state.artifact.source_path || `workflow:${snapshot.run.id}`,
            digest: state.artifact.digest,
          },
        ],
        runID: snapshot.run.id,
        actionID: AgentRuntime.ActionID.make(`act_workflow_verify_${bindingDigest.slice(0, 24)}`),
        observationID: AgentRuntime.ObservationID.make(`obs_workflow_verify_${bindingDigest.slice(0, 24)}`),
      }),
    )
    const gate = completionGate({
      runID: snapshot.run.id,
      checkpoint: snapshot.checkpoint,
      actions: nodes.map((node) => ({
        actionID: `workflow-node:${node.node_id}`,
        status: TERMINAL_NODE_STATUSES.has(node.status) ? "settled" : node.status,
        observationStatus: SUCCESS_NODE_STATUSES.has(node.status) ? "succeeded" : "failed",
      })),
      digest: runtimeDigest,
      independentVerifierPassed: evidence.evaluation.passed,
    })
    return {
      gate,
      verification: {
        schema_version: 1 as const,
        action_kind: "workflow" as const,
        action_version: "1" as const,
        passed: gate.allowed,
        total: gate.summary.total,
        passed_count: gate.summary.passedCount,
        failed_checks: [...gate.summary.failedChecks],
        evidence_digest: evidence.evidenceDigest,
        evaluated_at: now(),
      } satisfies DurableWorkflowVerificationState,
    }
  }

  private async withWorkspaceWriteLane<T>(
    runId: string,
    step: WorkflowStepDefinition,
    state: DurableWorkflowState,
    signal: AbortSignal,
    work: (writeLane: WriteLanePolicy) => Promise<T>,
  ) {
    try {
      return await acquireWriteLane(
        {
          parentRunID: runId,
          childRunID: `workflow:${runId}:${step.id}`,
          nodeID: step.id,
          ownerID: this.ownerId,
          workspace: state.workspace,
          access: "write",
          isolation: "workspace-exclusive",
        },
        signal,
        work,
      )
    } catch (error) {
      if (error instanceof Error && error.name === "WriteConflictError")
        throw new DurableWorkflowError("WORKFLOW_INTERRUPTED", error.message)
      throw error
    }
  }

  private async registerChildRun(runId: string, nodeId: string, childRunId: AgentRuntime.RunID) {
    const snapshot = await this.snapshot(runId)
    const state = cloneState(this.state(snapshot))
    const node = state.nodes[nodeId]
    if (!node) return
    state.nodes[nodeId] = { ...node, child_run_id: childRunId }
    await this.save(runId, state)
    const current = await this.snapshot(runId)
    if (current.run.status === "paused" || current.run.status === "cancelled") {
      const child = await Effect.runPromise(this.durableRun.load(childRunId))
      if (child.run.status === "running" || child.run.status === "queued")
        if (current.run.status === "cancelled")
          await Effect.runPromise(
            this.durableRun.cancel({ runID: child.run.id, reason: "parent workflow cancelled", recursive: true }),
          )
        else
          await Effect.runPromise(
            this.durableRun.transition({
              runID: childRunId,
              to: current.run.status,
              reason: `parent workflow ${current.run.status}`,
            }),
          )
    }
  }

  private downstreamFor(state: DurableWorkflowState, nodeId: string) {
    const downstream = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const node of Object.values(state.nodes)) {
        if (
          node.depends_on.some((dependency) => dependency === nodeId || downstream.has(dependency)) &&
          !downstream.has(node.node_id)
        ) {
          downstream.add(node.node_id)
          changed = true
        }
      }
    }
    return [...downstream]
  }

  private async finishChild(
    runId: AgentRuntime.RunID,
    status: "running" | "completed" | "failed",
    reason: string,
    summary = "",
  ) {
    let snapshot = await Effect.runPromise(this.durableRun.load(runId))
    if (status === "running") {
      if (snapshot.run.status === "draft")
        await Effect.runPromise(this.durableRun.transition({ runID: runId, to: "preflight", reason }))
      const queued = await Effect.runPromise(this.durableRun.load(runId))
      if (queued.run.status === "preflight")
        await Effect.runPromise(this.durableRun.transition({ runID: runId, to: "queued", reason }))
      const running = await Effect.runPromise(this.durableRun.load(runId))
      if (running.run.status === "queued")
        await Effect.runPromise(this.durableRun.transition({ runID: runId, to: "running", reason }))
      const started = await Effect.runPromise(this.durableRun.load(runId))
      if (started.run.status === "running" && !started.activeAttempt)
        await Effect.runPromise(this.durableRun.beginAttempt({ runID: runId }))
      return
    }
    snapshot = await Effect.runPromise(this.durableRun.load(runId))
    if (snapshot.activeAttempt) {
      await Effect.runPromise(
        this.durableRun.finishAttempt({
          runID: runId,
          attempt: snapshot.activeAttempt.attempt,
          outcome: status === "completed" ? "completed" : "failed",
          durationMs: Math.max(0, Date.now() - DateTime.toEpochMillis(snapshot.activeAttempt.startedAt)),
          costMicros: 0,
          tokens: 0,
        }),
      )
    }
    snapshot = await Effect.runPromise(this.durableRun.load(runId))
    if (snapshot.run.status === "running") {
      await Effect.runPromise(this.durableRun.transition({ runID: runId, to: "verifying", reason }))
      await Effect.runPromise(this.durableRun.transition({ runID: runId, to: status, reason }))
    }
    const settled = await Effect.runPromise(this.durableRun.load(runId))
    await Effect.runPromise(
      this.durableRun.recordChildResult({
        runID: runId,
        result: {
          status,
          summary: summary.slice(0, 16_000),
          artifactRefs: [],
          evidenceRefs: [],
          usage: {
            attempts: settled.run.budget.attemptsUsed,
            durationMs: settled.run.budget.durationMsUsed,
            costMicros: settled.run.budget.costMicrosUsed,
            tokens: settled.run.budget.tokensUsed,
          },
        },
      }),
    )
  }

  private async transition(runId: string, to: AgentRuntime.RunStatus, reason: string) {
    return this.snapshotAfter(
      Effect.runPromise(this.durableRun.transition({ runID: AgentRuntime.RunID.make(runId), to, reason })),
    )
  }

  private async snapshotAfter(effect: Promise<DurableRun.Snapshot>) {
    return effect
  }

  private async snapshot(runId: string) {
    const snapshot = await Effect.runPromise(this.durableRun.load(AgentRuntime.RunID.make(runId)))
    if (!this.isWorkflow(snapshot))
      throw new DurableWorkflowError("NOT_WORKFLOW_RUN", `run is not a durable workflow: ${runId}`)
    return snapshot
  }

  private state(snapshot: DurableRun.Snapshot) {
    const checkpoint = snapshot.checkpoint
    if (!checkpoint) throw new DurableWorkflowError("CORRUPT_STATE", "durable workflow has no immutable checkpoint")
    const state = decodeState(checkpoint.state)
    if (state.version !== DURABLE_WORKFLOW_STATE_VERSION || !state.artifact.digest)
      throw new DurableWorkflowError("CORRUPT_STATE", "durable workflow checkpoint is not a valid workflow state")
    return state
  }

  private definition(state: DurableWorkflowState): WorkflowDefinition {
    return state.artifact.definition as unknown as WorkflowDefinition
  }

  private session(snapshot: DurableRun.Snapshot) {
    return (snapshot as DurableRun.SessionSnapshot).run.sessionID
  }

  private workspace(snapshot: DurableRun.Snapshot) {
    return this.state(snapshot).workspace
  }

  private isWorkflow(snapshot: DurableRun.Snapshot) {
    try {
      return this.state(snapshot).artifact.kind === "workflow-definition"
    } catch {
      return false
    }
  }

  private isWaitingApproval(snapshot: DurableRun.Snapshot) {
    try {
      return Object.values(this.state(snapshot).nodes).some((node) => node.status === "waiting_approval")
    } catch {
      return false
    }
  }

  private async save(runId: string, state: DurableWorkflowState) {
    const bounded = {
      ...state,
      events: state.events.slice(-DURABLE_WORKFLOW_MAX_EVENTS),
    }
    await Effect.runPromise(this.durableRun.checkpoint({ runID: AgentRuntime.RunID.make(runId), state: bounded }))
  }

  private event(
    state: DurableWorkflowState,
    eventType: string,
    nodeId: string,
    data: Record<string, unknown>,
  ): DurableWorkflowEvent {
    return {
      sequence: (state.events.at(-1)?.sequence ?? 0) + 1,
      event_type: eventType,
      node_id: nodeId,
      data,
      created_at: now(),
    }
  }

  private addEvent(state: DurableWorkflowState, eventType: string, nodeId: string, data: Record<string, unknown>) {
    state.events = [...state.events, this.event(state, eventType, nodeId, data)]
  }

  private settle(state: DurableWorkflowState, nodeId: string, status: string, output: string, error: string) {
    const node = state.nodes[nodeId]!
    state.nodes[nodeId] = {
      ...node,
      status,
      output: output.slice(0, 100_000),
      error: error.slice(0, 4_000),
      finished_at: now(),
    }
    this.addEvent(state, `node.${status}`, nodeId, {})
  }

  private runRecord(snapshot: DurableRun.Snapshot): RunRecord {
    const state = this.state(snapshot)
    const run = snapshot.run
    return {
      run_id: run.id,
      session_id: this.session(snapshot),
      name: stringValue(state.artifact.definition.name, state.artifact.source_path),
      description: stringValue(state.artifact.definition.description),
      source_path: state.artifact.source_path,
      workspace: this.workspace(snapshot),
      definition_json: JSON.stringify(state.artifact.definition),
      permission_mode: state.permission_mode,
      status: this.publicStatus(snapshot),
      control: "",
      max_parallel: state.scheduling.effective_max_parallel,
      definition_digest: state.artifact.digest,
      budget: {
        max_attempts: state.budget.max_attempts,
        reserved_attempts: state.budget.reserved_attempts,
        used_attempts: state.budget.used_attempts,
        max_duration_ms: state.budget.max_duration_ms,
      },
      scheduling: {
        schema_version: state.scheduling.schema_version,
        request_digest: state.scheduling.request_digest,
        requested_max_parallel: state.scheduling.requested_max_parallel,
        effective_max_parallel: state.scheduling.effective_max_parallel,
        action: state.scheduling.action,
        execute_mode: state.scheduling.execute_mode,
        eligible: state.scheduling.eligible,
        reasons: [...state.scheduling.reasons],
        failed_checks: [...state.scheduling.failed_checks],
        reason: state.scheduling.reason,
        decision_digest: state.scheduling.decision_digest,
        evaluated_at: state.scheduling.evaluated_at,
        ...(state.scheduling.evidence_digest ? { evidence_digest: state.scheduling.evidence_digest } : {}),
        ...(state.scheduling.policy_revision ? { policy_revision: state.scheduling.policy_revision } : {}),
      },
      ...(state.verification ? { verification: { ...state.verification } } : {}),
      created_at: iso(run.time.created) ?? "",
      updated_at: iso(run.time.updated) ?? "",
      started_at: iso(run.time.started),
      finished_at: iso(run.time.finished),
      last_error: state.last_error,
      lease_owner: snapshot.lease?.ownerID ?? "",
      lease_expires_at: iso(snapshot.lease?.expiresAt),
    }
  }

  private publicStatus(snapshot: DurableRun.Snapshot) {
    if (this.isWaitingApproval(snapshot)) return "waiting_approval"
    if (snapshot.run.status === "draft") return "planned"
    return snapshot.run.status
  }
}

export const DurableWorkflow = {
  Runtime: DurableWorkflowGraphRuntime,
  decodeState,
  stateDigest,
}

function writeLaneContext(policy: WriteLanePolicy): Pick<WriteLanePolicy, "mode" | "workspaceKey" | "policyDigest"> {
  return {
    mode: policy.mode,
    workspaceKey: policy.workspaceKey,
    policyDigest: policy.policyDigest,
  }
}
