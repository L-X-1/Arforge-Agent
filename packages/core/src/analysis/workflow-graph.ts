export * as WorkflowGraph from "./workflow-graph"

/**
 * Legacy workflow graph runtime — migration/source compatibility only.
 *
 * Production workflow execution uses `DurableWorkflowGraphRuntime` and the
 * DurableRun aggregate. This table-backed runtime must not be wired as a
 * second production writer or lease authority after the cutover.
 *
 * Executes dependency graphs over the PostgreSQL ``workflow_graph_runs/nodes/events``
 * tables (or an equivalent SQLite schema for local tests). Command nodes spawn
 * bounded local commands; agent nodes delegate to an injected runner (the
 * TypeScript session runner); approval and checkpoint nodes coordinate human
 * gates. State transitions and events are durable.
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { createHash } from "node:crypto"

export const LEASE_SECONDS = 60
export const MAX_OUTPUT_CHARS = 100_000
export const MAX_ERROR_CHARS = 4_000
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"])
export const TERMINAL_NODE_STATUSES = new Set(["completed", "failed", "blocked", "skipped"])
export const FAILURE_NODE_STATUSES = new Set(["failed", "blocked"])
export const SUCCESS_NODE_STATUSES = new Set(["completed", "skipped"])

export class WorkflowGraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "WorkflowGraphError"
  }
}

export interface WorkflowStepDefinition {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly depends_on: string[]
  readonly continue_on_error: boolean
  readonly kind: "agent" | "command" | "approval" | "checkpoint"
  readonly max_attempts: number
  readonly when_step: string
  readonly when_statuses: string[]
  readonly access: "read" | "write"
}

export interface WorkflowDefinition {
  readonly schema_version: number
  readonly name: string
  readonly description: string
  readonly source_path: string
  readonly steps: WorkflowStepDefinition[]
}

export interface WorkflowRunBudget {
  readonly max_attempts: number
  readonly reserved_attempts: number
  readonly used_attempts: number
  readonly max_duration_ms: number
}

export interface WorkflowSchedulingSummary {
  readonly schema_version: number
  readonly request_digest: string
  readonly requested_max_parallel: number
  readonly effective_max_parallel: number
  readonly action: string
  readonly execute_mode: string
  readonly eligible: boolean
  readonly reasons: ReadonlyArray<string>
  readonly failed_checks: ReadonlyArray<string>
  readonly reason: string
  readonly decision_digest: string
  readonly evaluated_at: string
  readonly evidence_digest?: string
  readonly policy_revision?: string
}

export interface WorkflowVerificationSummary {
  readonly schema_version: 1
  readonly action_kind: "workflow"
  readonly action_version: "1"
  readonly passed: boolean
  readonly total: number
  readonly passed_count: number
  readonly failed_checks: ReadonlyArray<string>
  readonly evidence_digest: string
  readonly evaluated_at: string
}

export interface RunRecord {
  readonly run_id: string
  readonly session_id: string
  readonly name: string
  readonly description: string
  readonly source_path: string
  readonly workspace: string
  readonly definition_json: string
  readonly permission_mode: string
  readonly status: string
  readonly control: string
  readonly max_parallel: number
  readonly definition_digest?: string
  readonly budget?: WorkflowRunBudget
  readonly scheduling?: WorkflowSchedulingSummary
  readonly verification?: WorkflowVerificationSummary
  readonly created_at: string
  readonly updated_at: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly last_error: string
  readonly lease_owner: string
  readonly lease_expires_at: string | null
}

export interface NodeRecord {
  readonly run_id: string
  readonly node_id: string
  readonly position: number
  readonly title: string
  readonly kind: string
  readonly access: string
  readonly status: string
  readonly attempt: number
  readonly max_attempts: number
  readonly depends_on_json: string
  readonly continue_on_error: boolean
  readonly when_step: string
  readonly when_statuses_json: string
  readonly output: string
  readonly error: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly budget_reserved_attempts?: number
  readonly child_run_id?: string
}

export interface GraphEvent {
  readonly run_id: string
  readonly sequence: number
  readonly event_type: string
  readonly node_id: string
  readonly data_json: string
  readonly created_at: string
}

/** Minimal row interface for the workflow tables (PostgreSQL or SQLite). */
export interface WorkflowDatabase {
  readonly query: (sql: string, params?: readonly unknown[]) => Promise<Array<Record<string, unknown>>>
  readonly execute: (sql: string, params?: readonly unknown[]) => Promise<unknown>
}

export interface WorkflowGraphRuntimeOptions {
  readonly database?: WorkflowDatabase
  readonly runner?: (step: WorkflowStepDefinition, context: Record<string, unknown>) => Promise<string>
  readonly maxParallelLimit?: number
  readonly ownerId?: string
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => string
}

export interface NodeContext {
  readonly run_id: string
  readonly session_id: string
  readonly workspace: string
  readonly permission_mode: string
  readonly dependencies: Record<string, { status: string; output: string }>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_graph_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_path TEXT NOT NULL,
  workspace TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  control TEXT NOT NULL DEFAULT '',
  max_parallel INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_workflow_graph_runs_session ON workflow_graph_runs(session_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS workflow_graph_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'read',
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  depends_on_json TEXT NOT NULL,
  continue_on_error INTEGER NOT NULL DEFAULT 0,
  when_step TEXT NOT NULL DEFAULT '',
  when_statuses_json TEXT NOT NULL DEFAULT '[]',
  output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX IF NOT EXISTS ix_workflow_graph_node_run_position ON workflow_graph_nodes(run_id, position);
CREATE TABLE IF NOT EXISTS workflow_graph_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
`

export function utcNow(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.${pad(now.getUTCMilliseconds(), 3)}+00:00`
  )
}

export class WorkflowGraphRuntime {
  readonly runner: (step: WorkflowStepDefinition, context: Record<string, unknown>) => Promise<string>
  readonly maxParallelLimit: number
  readonly ownerId: string
  private readonly database: WorkflowDatabase
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => string
  private readonly loops = new Set<string>()

  constructor(options: WorkflowGraphRuntimeOptions = {}) {
    if (!options.database) {
      throw new WorkflowGraphError("NO_DATABASE", "a workflow database adapter is required")
    }
    this.database = options.database
    this.runner = options.runner ?? (async (step) => step.prompt)
    this.maxParallelLimit = options.maxParallelLimit ?? 8
    this.ownerId = options.ownerId ?? `workflow-${randomUUID().replace(/-/g, "")}`
    this.sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
    this.now = options.now ?? utcNow
  }

  async ensureSchema(): Promise<void> {
    for (const statement of SCHEMA.split(";").filter((part) => part.trim())) {
      await this.database.execute(statement)
    }
  }

  async recoverAbandoned(): Promise<void> {
    const now = this.now()
    await this.database.execute(
      "UPDATE workflow_graph_runs SET status='interrupted', last_error='recovered abandoned workflow run', finished_at=? WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
      [now, now],
    )
  }

  async createRun(input: {
    definition: WorkflowDefinition
    sessionId: string
    workspace: string
    permissionMode?: string
    maxParallel?: number
  }): Promise<RunRecord> {
    validateDefinition(input.definition as unknown as Record<string, unknown>, input.definition.source_path, input.workspace)
    if (!input.sessionId || !input.sessionId.trim()) {
      throw new WorkflowGraphError("INVALID_PARAMS", "session_id is required")
    }
    const maxParallel = input.maxParallel ?? 4
    if (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > this.maxParallelLimit) {
      throw new WorkflowGraphError("INVALID_PARAMS", `max_parallel must be between 1 and ${this.maxParallelLimit}`)
    }
    const permissionMode = input.permissionMode ?? "acceptEdits"
    if (!["plan", "acceptEdits", "fullAccess"].includes(permissionMode)) {
      throw new WorkflowGraphError("INVALID_PARAMS", "permission_mode is invalid")
    }
    const runId = randomUUID().replace(/-/g, "")
    const now = this.now()
    const payload = JSON.stringify(definitionPayload(input.definition))
    await this.database.execute(
      "INSERT INTO workflow_graph_runs(run_id, session_id, name, description, source_path, workspace, definition_json, permission_mode, status, control, max_parallel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', '', ?, ?, ?)",
      [
        runId,
        input.sessionId.trim(),
        input.definition.name,
        input.definition.description,
        input.definition.source_path,
        resolve(input.workspace),
        payload,
        permissionMode,
        maxParallel,
        now,
        now,
      ],
    )
    for (const [position, step] of input.definition.steps.entries()) {
      await this.database.execute(
        "INSERT INTO workflow_graph_nodes(run_id, node_id, position, title, kind, access, status, max_attempts, depends_on_json, continue_on_error, when_step, when_statuses_json) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
        [
          runId,
          step.id,
          position,
          step.title,
          step.kind,
          step.access,
          step.max_attempts,
          JSON.stringify([...step.depends_on]),
          step.continue_on_error ? 1 : 0,
          step.when_step,
          JSON.stringify([...step.when_statuses]),
        ],
      )
    }
    await this.appendEvent(runId, "graph.created", "", { name: input.definition.name, nodes: input.definition.steps.length })
    await this.prune()
    return this.getRun(runId)
  }

  async start(runId: string): Promise<RunRecord> {
    const run = await this.requireRun(runId)
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === "waiting_approval" || this.loops.has(runId)) {
      return run
    }
    const now = this.now()
    const claimed = await this.database.execute(
      "UPDATE workflow_graph_runs SET status='running', control='', updated_at=?, started_at=COALESCE(started_at, ?), finished_at=NULL, last_error='', lease_owner=?, lease_expires_at=? WHERE run_id=? AND (lease_owner='' OR lease_owner=? OR lease_expires_at IS NULL OR lease_expires_at<=?)",
      [now, now, this.ownerId, leaseDeadline(this.now), runId, this.ownerId, now],
    )
    if (!claimed) {
      throw new WorkflowGraphError("RUN_BUSY", "workflow run is active in another Arforge process")
    }
    await this.appendEvent(runId, "graph.started")
    this.loops.add(runId)
    void this.driveLoop(runId).finally(() => this.loops.delete(runId))
    return this.getRun(runId)
  }

  async pause(runId: string): Promise<RunRecord> {
    return this.requestControl(runId, "pause")
  }

  async cancel(runId: string): Promise<RunRecord> {
    return this.requestControl(runId, "cancel")
  }

  async resume(runId: string): Promise<RunRecord> {
    return this.restart(runId)
  }

  async decideApproval(runId: string, nodeId: string, approved: boolean, comment = ""): Promise<RunRecord> {
    const node = await this.requireNode(runId, nodeId)
    if (node.status !== "waiting_approval") {
      throw new WorkflowGraphError("NODE_NOT_PENDING", `node is not waiting for approval: ${nodeId}`)
    }
    const now = this.now()
    if (approved) {
      await this.database.execute(
        "UPDATE workflow_graph_nodes SET status='completed', output=?, finished_at=? WHERE run_id=? AND node_id=?",
        [JSON.stringify({ approved: true, comment }), now, runId, nodeId],
      )
      await this.appendEvent(runId, "node.approved", nodeId, { comment })
    } else {
      await this.database.execute(
        "UPDATE workflow_graph_nodes SET status='failed', error=?, finished_at=? WHERE run_id=? AND node_id=?",
        [comment || "approval rejected", now, runId, nodeId],
      )
      await this.appendEvent(runId, "node.rejected", nodeId, { comment })
    }
    return this.restart(runId)
  }

  async retryNode(runId: string, nodeId: string, includeDescendants = false): Promise<RunRecord> {
    const node = await this.requireNode(runId, nodeId)
    if (!FAILURE_NODE_STATUSES.has(node.status)) {
      throw new WorkflowGraphError("NODE_NOT_RETRYABLE", `node cannot be retried in status ${node.status}`)
    }
    const now = this.now()
    const descendants = includeDescendants ? await this.failedDescendants(runId, nodeId) : []
    const affected = [nodeId, ...descendants]
    for (const id of affected) {
      await this.database.execute(
        "UPDATE workflow_graph_nodes SET status='pending', attempt=0, output='', error='', started_at=NULL, finished_at=NULL WHERE run_id=? AND node_id=?",
        [runId, id],
      )
    }
    await this.appendEvent(runId, "node.retry_requested", nodeId, { descendants: affected.length - 1 })
    return this.restart(runId)
  }

  async getRun(runId: string): Promise<RunRecord> {
    const rows = await this.database.query("SELECT * FROM workflow_graph_runs WHERE run_id = ?", [runId])
    if (rows.length === 0) throw new WorkflowGraphError("RUN_NOT_FOUND", `workflow run not found: ${runId}`)
    return rowToRun(rows[0])
  }

  async listRuns(input: { sessionId?: string; limit?: number } = {}): Promise<{ schema_version: number; count: number; items: Array<Record<string, unknown>> }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const rows = input.sessionId
      ? await this.database.query("SELECT * FROM workflow_graph_runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?", [input.sessionId, limit])
      : await this.database.query("SELECT * FROM workflow_graph_runs ORDER BY updated_at DESC LIMIT ?", [limit])
    return { schema_version: 1, count: rows.length, items: rows.map((row) => publicRun(rowToRun(row), rows.length === 0)) }
  }

  async events(runId: string, after = 0, limit = 200): Promise<{ schema_version: number; count: number; items: GraphEvent[] }> {
    await this.requireRun(runId)
    const rows = await this.database.query(
      "SELECT * FROM workflow_graph_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      [runId, after, limit],
    )
    return { schema_version: 1, count: rows.length, items: rows.map(rowToEvent) }
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<RunRecord> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const run = await this.getRun(runId)
      if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === "waiting_approval") return run
      await this.sleep(200)
    }
    return this.getRun(runId)
  }

  // ---------------------------------------------------------------------------
  // Drive loop
  // ---------------------------------------------------------------------------

  private async driveLoop(runId: string): Promise<void> {
    try {
      for (;;) {
        const run = await this.getRun(runId)
        if (run.control) {
          await this.finishControl(runId, run.control)
          return
        }
        const definition = definitionFromPayload(JSON.parse(run.definition_json) as Record<string, unknown>)
        const steps = new Map(definition.steps.map((step) => [step.id, step]))
        const nodes = await this.nodesFor(runId)
        const pending = [...nodes.values()].filter((node) => node.status === "pending")
        const runnable: WorkflowStepDefinition[] = []
        let stateChanged = false
        for (const node of pending) {
          const step = steps.get(node.node_id)
          if (!step) continue
          const dependencies = step.depends_on.map((id) => nodes.get(id)).filter((item): item is NodeRecord => item !== undefined)
          if (dependencies.some((item) => !TERMINAL_NODE_STATUSES.has(item.status))) continue
          const failedDependencies = dependencies.filter(
            (item) => FAILURE_NODE_STATUSES.has(item.status) && !item.continue_on_error,
          )
          if (failedDependencies.length > 0) {
            await this.settleNode(runId, step.id, "blocked", `blocked by failed dependency: ${failedDependencies.map((item) => item.node_id).join(", ")}`)
            stateChanged = true
            continue
          }
          if (step.when_step) {
            const actual = nodes.get(step.when_step)?.status
            if (!step.when_statuses.includes(actual ?? "")) {
              await this.settleNode(runId, step.id, "skipped", `condition not met: ${step.when_step}=${actual}`)
              stateChanged = true
              continue
            }
          }
          if (step.kind === "approval") {
            await this.markWaitingApproval(runId, step)
            stateChanged = true
            continue
          }
          if (step.kind === "checkpoint") {
            await this.settleNode(runId, step.id, "completed", step.prompt || "workflow checkpoint reached")
            stateChanged = true
            continue
          }
          runnable.push(step)
        }
        if (stateChanged && runnable.length === 0) continue
        if (runnable.length === 0) {
          const statuses = new Set([...nodes.values()].map((node) => node.status))
          if (statuses.has("waiting_approval")) {
            await this.finishRun(runId, "waiting_approval")
          } else if ([...statuses].every((status) => SUCCESS_NODE_STATUSES.has(status))) {
            await this.finishRun(runId, "completed")
          } else if ([...statuses].some((status) => FAILURE_NODE_STATUSES.has(status))) {
            await this.finishRun(runId, "failed", "one or more workflow nodes did not complete")
          } else {
            await this.finishRun(runId, "interrupted", "workflow graph has no runnable nodes")
          }
          return
        }
        const writeNode = runnable.find((step) => step.access === "write")
        const batch = writeNode ? [writeNode] : runnable.slice(0, run.max_parallel)
        const now = this.now()
        for (const step of batch) {
          await this.database.execute(
            "UPDATE workflow_graph_nodes SET status='running', started_at=?, finished_at=NULL WHERE run_id=? AND node_id=?",
            [now, runId, step.id],
          )
          await this.appendEvent(runId, "node.started", step.id, { kind: step.kind, access: step.access })
        }
        const results = await Promise.all(
          batch.map(async (step) => {
            const context: NodeContext = {
              run_id: runId,
              session_id: run.session_id,
              workspace: run.workspace,
              permission_mode: step.access === "read" ? "plan" : run.permission_mode,
              dependencies: Object.fromEntries(
                step.depends_on.map((dependency) => {
                  const node = nodes.get(dependency)
                  return [dependency, { status: node?.status ?? "missing", output: node?.output ?? "" }]
                }),
              ),
            }
            return this.executeNode(runId, step, context)
          }),
        )
        for (const [index, step] of batch.entries()) {
          const [status, output, error, attempts] = results[index]
          await this.settleNode(runId, step.id, status, error || output, error)
          await this.database.execute("UPDATE workflow_graph_nodes SET attempt=? WHERE run_id=? AND node_id=?", [attempts, runId, step.id])
          await this.appendEvent(runId, `node.${status}`, step.id, { attempts })
        }
      }
    } catch (error) {
      await this.database.execute("UPDATE workflow_graph_runs SET status='interrupted', last_error=?, updated_at=?, finished_at=? WHERE run_id=?", [
        error instanceof Error ? error.message.slice(0, MAX_ERROR_CHARS) : "workflow drive failed",
        this.now(),
        this.now(),
        runId,
      ])
    }
  }

  private async executeNode(runId: string, step: WorkflowStepDefinition, context: NodeContext): Promise<[string, string, string, number]> {
    let lastError = ""
    for (let attempt = 1; attempt <= step.max_attempts; attempt++) {
      await this.database.execute("UPDATE workflow_graph_nodes SET attempt=? WHERE run_id=? AND node_id=?", [attempt, runId, step.id])
      if (attempt > 1) {
        await this.appendEvent(runId, "node.retrying", step.id, { attempt })
      }
      try {
        let output: string
        if (step.kind === "command") {
          output = await this.runCommandNode(step, context)
        } else {
          output = await this.runner(step, context as unknown as Record<string, unknown>)
        }
        return ["completed", sanitizeForStorage(output).slice(0, MAX_OUTPUT_CHARS), "", attempt]
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS)
      }
    }
    return ["failed", "", lastError, step.max_attempts]
  }

  /**
   * Command nodes are intentionally unavailable until they carry a canonical
   * ActionGateway identity. Keeping the old raw spawn here would let a
   * workflow request bypass the same authorization boundary as every other
   * product process execution.
   */
  private runCommandNode(_step: WorkflowStepDefinition, _context: NodeContext): Promise<string> {
    return Promise.reject(
      new WorkflowGraphError(
        "GATEWAY_REQUIRED",
        "workflow command nodes are hard-blocked until execution is bound to ActionGateway",
      ),
    )
  }

  private async settleNode(runId: string, nodeId: string, status: string, output = "", error = ""): Promise<void> {
    await this.database.execute(
      "UPDATE workflow_graph_nodes SET status=?, output=?, error=?, finished_at=? WHERE run_id=? AND node_id=?",
      [status, sanitizeForStorage(output).slice(0, MAX_OUTPUT_CHARS), sanitizeForStorage(error).slice(0, MAX_ERROR_CHARS), this.now(), runId, nodeId],
    )
  }

  private async markWaitingApproval(runId: string, step: WorkflowStepDefinition): Promise<void> {
    await this.database.execute(
      "UPDATE workflow_graph_nodes SET status='waiting_approval', started_at=?, finished_at=NULL WHERE run_id=? AND node_id=?",
      [this.now(), runId, step.id],
    )
    await this.appendEvent(runId, "node.approval_requested", step.id, { title: step.title, prompt: step.prompt })
  }

  private async finishRun(runId: string, status: string, error = ""): Promise<void> {
    await this.database.execute(
      "UPDATE workflow_graph_runs SET status=?, last_error=?, updated_at=?, finished_at=?, lease_owner='', lease_expires_at=NULL WHERE run_id=?",
      [status, error.slice(0, MAX_ERROR_CHARS), this.now(), this.now(), runId],
    )
    await this.appendEvent(runId, `graph.${status}`)
  }

  private async finishControl(runId: string, control: string): Promise<void> {
    if (control === "pause") {
      await this.database.execute(
        "UPDATE workflow_graph_runs SET status='paused', control='', updated_at=? WHERE run_id=?",
        [this.now(), runId],
      )
    } else {
      await this.database.execute(
        "UPDATE workflow_graph_runs SET status='cancelled', control='', updated_at=?, finished_at=?, lease_owner='', lease_expires_at=NULL WHERE run_id=?",
        [this.now(), this.now(), runId],
      )
    }
    await this.appendEvent(runId, `graph.${control === "pause" ? "paused" : "cancelled"}`)
  }

  private async requestControl(runId: string, control: string): Promise<RunRecord> {
    const run = await this.requireRun(runId)
    if (TERMINAL_RUN_STATUSES.has(run.status) || run.status === "waiting_approval") return run
    await this.database.execute("UPDATE workflow_graph_runs SET control=? WHERE run_id=?", [control, runId])
    return this.getRun(runId)
  }

  private async restart(runId: string): Promise<RunRecord> {
    const now = this.now()
    await this.database.execute(
      "UPDATE workflow_graph_runs SET status='running', control='', updated_at=?, started_at=COALESCE(started_at, ?), finished_at=NULL, last_error='', lease_owner=?, lease_expires_at=? WHERE run_id=?",
      [now, now, this.ownerId, leaseDeadline(this.now), runId],
    )
    if (this.loops.has(runId)) return this.getRun(runId)
    this.loops.add(runId)
    void this.driveLoop(runId).finally(() => this.loops.delete(runId))
    return this.getRun(runId)
  }

  private async failedDescendants(runId: string, nodeId: string): Promise<string[]> {
    const nodes = await this.nodesFor(runId)
    const failed: string[] = []
    const walk = (id: string) => {
      for (const node of nodes.values()) {
        const depends = JSON.parse(node.depends_on_json) as string[]
        if (depends.includes(id)) {
          if (FAILURE_NODE_STATUSES.has(node.status) || node.status === "pending") failed.push(node.node_id)
          walk(node.node_id)
        }
      }
    }
    walk(nodeId)
    return failed
  }

  async nodesFor(runId: string): Promise<Map<string, NodeRecord>> {
    const rows = await this.database.query("SELECT * FROM workflow_graph_nodes WHERE run_id=? ORDER BY position", [runId])
    return new Map(rows.map((row) => [String(row.node_id), rowToNode(row)]))
  }

  private async requireNode(runId: string, nodeId: string): Promise<NodeRecord> {
    const rows = await this.database.query("SELECT * FROM workflow_graph_nodes WHERE run_id=? AND node_id=?", [runId, nodeId])
    if (rows.length === 0) throw new WorkflowGraphError("NODE_NOT_FOUND", `workflow node not found: ${nodeId}`)
    return rowToNode(rows[0])
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    return this.getRun(runId)
  }

  private async appendEvent(runId: string, eventType: string, nodeId = "", data: Record<string, unknown> = {}): Promise<void> {
    const rows = await this.database.query("SELECT COALESCE(MAX(sequence), 0) AS seq FROM workflow_graph_events WHERE run_id=?", [runId])
    const sequence = Number(rows[0]?.seq ?? 0) + 1
    await this.database.execute(
      "INSERT INTO workflow_graph_events(run_id, sequence, event_type, node_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, sequence, eventType, nodeId, JSON.stringify(data), this.now()],
    )
  }

  private async prune(): Promise<void> {
    const rows = await this.database.query(
      "SELECT run_id FROM workflow_graph_runs WHERE status IN ('completed', 'failed', 'cancelled') ORDER BY updated_at DESC LIMIT -1 OFFSET 100",
    )
    for (const row of rows) {
      await this.database.execute("DELETE FROM workflow_graph_events WHERE run_id=?", [String(row.run_id)])
      await this.database.execute("DELETE FROM workflow_graph_nodes WHERE run_id=?", [String(row.run_id)])
      await this.database.execute("DELETE FROM workflow_graph_runs WHERE run_id=?", [String(row.run_id)])
    }
  }
}

// ---------------------------------------------------------------------------
// Definition discovery / loading / preview (native port of workflow_runtime.py)
// ---------------------------------------------------------------------------

const SAFE_STEP_ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

export function discoverWorkflows(workspace: string): string[] {
  const paths: string[] = []
  for (const candidate of [join(workspace, ".arforge", "workflows"), join(workspace, "workflows")]) {
    if (!existsSync(candidate)) continue
    for (const entry of readdirSync(candidate, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) paths.push(join(candidate, entry.name))
    }
  }
  return paths.sort()
}

export function loadWorkflow(filePath: string, workspace = process.cwd()): WorkflowDefinition {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>
  } catch (error) {
    throw new WorkflowGraphError("INVALID_DEFINITION", `workflow definition is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateDefinition(payload, filePath, workspace)
}

export function previewWorkflow(definition: WorkflowDefinition): { schema_version: number; name: string; description: string; source_path: string; steps: number; edges: Array<{ from: string; to: string }> } {
  return {
    schema_version: definition.schema_version,
    name: definition.name,
    description: definition.description,
    source_path: definition.source_path,
    steps: definition.steps.length,
    edges: definition.steps.flatMap((step) => step.depends_on.map((dependency) => ({ from: dependency, to: step.id }))),
  }
}

export function validateDefinition(payload: Record<string, unknown>, sourcePath: string, workspace: string): WorkflowDefinition {
  const name = String(payload.name ?? "").trim()
  if (!name) throw new WorkflowGraphError("INVALID_DEFINITION", "workflow definition name is required")
  const stepsRaw = payload.steps
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new WorkflowGraphError("INVALID_DEFINITION", "workflow definition must declare at least one step")
  }
  const steps: WorkflowStepDefinition[] = []
  const ids = new Set<string>()
  for (const raw of stepsRaw) {
    if (typeof raw !== "object" || raw === null) throw new WorkflowGraphError("INVALID_DEFINITION", "workflow step must be an object")
    const record = raw as Record<string, unknown>
    const id = String(record.id ?? "").trim()
    if (!SAFE_STEP_ID.test(id)) throw new WorkflowGraphError("INVALID_DEFINITION", `step id must be URL-safe: ${id}`)
    if (ids.has(id)) throw new WorkflowGraphError("INVALID_DEFINITION", `duplicate step id: ${id}`)
    ids.add(id)
    const kind = String(record.kind ?? "agent")
    if (!["agent", "command", "approval", "checkpoint"].includes(kind)) {
      throw new WorkflowGraphError("INVALID_DEFINITION", `step kind must be agent, command, approval, or checkpoint: ${kind}`)
    }
    const dependsOn = (Array.isArray(record.depends_on) ? record.depends_on : []).map((item) => String(item))
    for (const dependency of dependsOn) {
      if (!ids.has(dependency) && dependency !== "") throw new WorkflowGraphError("INVALID_DEFINITION", `step depends on unknown step: ${dependency}`)
    }
    steps.push({
      id,
      title: String(record.title ?? id).slice(0, 200),
      prompt: String(record.prompt ?? "").slice(0, 10_000),
      depends_on: dependsOn,
      continue_on_error: Boolean(record.continue_on_error),
      kind: kind as WorkflowStepDefinition["kind"],
      max_attempts: Math.max(1, Math.min(Number(record.max_attempts ?? 1), 10)),
      when_step: String(record.when_step ?? ""),
      when_statuses: (Array.isArray(record.when_statuses) ? record.when_statuses : []).map((item) => String(item)),
      access: record.access === "write" ? "write" : "read",
    })
  }
  return {
    schema_version: 1,
    name,
    description: String(payload.description ?? ""),
    source_path: relative(resolve(workspace), resolve(sourcePath)).replaceAll("\\", "/"),
    steps,
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function definitionPayload(definition: WorkflowDefinition): Record<string, unknown> {
  return {
    schema_version: definition.schema_version,
    name: definition.name,
    description: definition.description,
    source_path: definition.source_path,
    steps: definition.steps.map((step) => ({
      id: step.id,
      title: step.title,
      prompt: step.prompt,
      depends_on: [...step.depends_on],
      continue_on_error: step.continue_on_error,
      kind: step.kind,
      max_attempts: step.max_attempts,
      when_step: step.when_step,
      when_statuses: [...step.when_statuses],
      access: step.access,
    })),
  }
}

function definitionFromPayload(payload: Record<string, unknown>): WorkflowDefinition {
  return validateDefinition(payload, payload.source_path as string, process.cwd())
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    run_id: String(row.run_id ?? ""),
    session_id: String(row.session_id ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    source_path: String(row.source_path ?? ""),
    workspace: String(row.workspace ?? ""),
    definition_json: String(row.definition_json ?? "{}"),
    permission_mode: String(row.permission_mode ?? ""),
    status: String(row.status ?? ""),
    control: String(row.control ?? ""),
    max_parallel: Number(row.max_parallel ?? 1),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    started_at: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    last_error: String(row.last_error ?? ""),
    lease_owner: String(row.lease_owner ?? ""),
    lease_expires_at: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : String(row.lease_expires_at),
  }
}

function rowToNode(row: Record<string, unknown>): NodeRecord {
  return {
    run_id: String(row.run_id ?? ""),
    node_id: String(row.node_id ?? ""),
    position: Number(row.position ?? 0),
    title: String(row.title ?? ""),
    kind: String(row.kind ?? ""),
    access: String(row.access ?? "read"),
    status: String(row.status ?? ""),
    attempt: Number(row.attempt ?? 0),
    max_attempts: Number(row.max_attempts ?? 1),
    depends_on_json: String(row.depends_on_json ?? "[]"),
    continue_on_error: Boolean(row.continue_on_error),
    when_step: String(row.when_step ?? ""),
    when_statuses_json: String(row.when_statuses_json ?? "[]"),
    output: String(row.output ?? ""),
    error: String(row.error ?? ""),
    started_at: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    ...(row.budget_reserved_attempts !== undefined
      ? { budget_reserved_attempts: Math.max(0, Number(row.budget_reserved_attempts ?? 0)) }
      : {}),
    ...(typeof row.child_run_id === "string" && row.child_run_id.length > 0 ? { child_run_id: row.child_run_id } : {}),
  }
}

function rowToEvent(row: Record<string, unknown>): GraphEvent {
  return {
    run_id: String(row.run_id ?? ""),
    sequence: Number(row.sequence ?? 0),
    event_type: String(row.event_type ?? ""),
    node_id: String(row.node_id ?? ""),
    data_json: String(row.data_json ?? "{}"),
    created_at: String(row.created_at ?? ""),
  }
}

function publicRun(run: RunRecord, _placeholder: boolean): Record<string, unknown> {
  return {
    run_id: run.run_id,
    session_id: run.session_id,
    name: run.name,
    description: run.description,
    source_path: run.source_path,
    status: run.status,
    permission_mode: run.permission_mode,
    max_parallel: run.max_parallel,
    created_at: run.created_at,
    updated_at: run.updated_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    last_error: run.last_error,
    ...(run.definition_digest ? { definition_digest: run.definition_digest } : {}),
    ...(run.budget ? { budget: run.budget } : {}),
    ...(run.scheduling ? { scheduling: run.scheduling } : {}),
  }
}

function leaseDeadline(_now: () => string): string {
  const date = new Date(Date.now() + LEASE_SECONDS * 1000)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}+00:00`
  )
}

function sanitizeForStorage(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  let cleaned = text
  cleaned = cleaned.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_SECRET]")
  cleaned = cleaned.replace(/\bghp_[A-Za-z0-9]{36}\b/g, "[REDACTED_SECRET]")
  cleaned = cleaned.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]")
  return cleaned
}

export function digestWorkflowPath(workspace: string, name: string): string {
  return createHash("sha256").update(`arforge-workflow\0${workspace}\0${name}`).digest("hex").slice(0, 16)
}
