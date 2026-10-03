export * as PersonalWorkspaceV2 from "./personal-workspace"

import { PersonalWorkspace } from "@arforge-ai/schema/personal-workspace"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { DateTime, Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq, inArray, or } from "drizzle-orm"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { MemoryCandidateTable } from "./memory/sql"
import { PersonalJobV2 } from "./personal-job"
import { SessionTable } from "./session/sql"
import { TaskGraphV2 } from "./task-graph"
import { DurableRun } from "./runtime/durable-run"
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "./identity/sql"

export class CorruptHistoryError extends Schema.TaggedErrorClass<CorruptHistoryError>()(
  "PersonalWorkspace.CorruptHistoryError",
  { reason: Schema.String },
) {}

export interface Interface {
  /** Read-only, bounded, safe projection for the Personal Workspace UI. */
  readonly snapshot: (input?: {
    readonly limit?: number
  }) => Effect.Effect<PersonalWorkspace.Snapshot, CorruptHistoryError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PersonalWorkspace") {}

const sessionState = (
  states: ReadonlyArray<PersonalWorkspace.AutomationState>,
): PersonalWorkspace.AutomationState => {
  if (states.includes("needs_human")) return "needs_human"
  if (states.includes("system_automatic")) return "system_automatic"
  if (states.length > 0 && states.every((state) => state === "settled")) return "settled"
  return "human_visible"
}

const taskState = (task: string, unresolvedBlockers: number): PersonalWorkspace.AutomationState => {
  if (task === "completed" || task === "cancelled") return "settled"
  if (unresolvedBlockers > 0) return "needs_human"
  return "system_automatic"
}

const runState = (status: AgentRuntime.RunStatus): PersonalWorkspace.AutomationState => {
  if (status === "completed" || status === "cancelled") return "settled"
  if (status === "awaiting_authorization" || status === "paused" || status === "recovering" || status === "failed")
    return "needs_human"
  return "system_automatic"
}

const jobState = (job: PersonalJob.Info): PersonalWorkspace.AutomationState => {
  if (job.status === "completed" || job.status === "cancelled") return "settled"
  if (job.approvalState === "pending" || job.status === "paused" || job.status === "failed") return "needs_human"
  return "system_automatic"
}

const isActiveRun = (status: AgentRuntime.RunStatus) =>
  status !== "completed" && status !== "failed" && status !== "cancelled"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const location = yield* Location.Service
    const tasks = yield* TaskGraphV2.Service
    const runs = yield* DurableRun.Service
    const jobs = yield* PersonalJobV2.Service
    const workspacePath = String(location.directory).replaceAll("\\", "/").replace(/\/+$/, "") || "/"
    const normalizedWorkspacePath =
      process.platform === "win32" ? workspacePath.toLocaleLowerCase("en-US") : workspacePath

    const snapshot: Interface["snapshot"] = Effect.fn("PersonalWorkspace.snapshot")(function* (input) {
      const requestedLimit = input?.limit
      const limit =
        requestedLimit === undefined
          ? 50
          : Number.isSafeInteger(requestedLimit)
            ? Math.min(Math.max(requestedLimit, 1), 100)
            : 1
      const principal = yield* Database.CurrentPrincipal
      const tenantID = principal?.tenantID ?? LOCAL_TENANT_ID
      const userID = principal?.userID ?? LOCAL_USER_ID
      const sessionInfos = yield* database.db
        .select({
          id: SessionTable.id,
          title: SessionTable.title,
          projectID: SessionTable.project_id,
          timeCreated: SessionTable.time_created,
          timeUpdated: SessionTable.time_updated,
        })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, location.project.id),
            eq(SessionTable.tenant_id, tenantID),
            eq(SessionTable.owner_user_id, userID),
          ),
        )
        .orderBy(desc(SessionTable.time_created))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)

      const projected = yield* Effect.forEach(sessionInfos, (session) =>
        Effect.gen(function* () {
          const taskPage = yield* tasks.list({ sessionID: session.id })
          const sessionRuns = yield* runs.list({ sessionID: session.id, limit, skipCorrupt: false }).pipe(
            Effect.mapError(
              () =>
                new CorruptHistoryError({
                  reason: `Durable run history for ${session.id} is not readable.`,
                }),
            ),
          )
          const sessionJobs = (yield* jobs.list({ sessionID: session.id }).pipe(
            Effect.mapError(
              () =>
                new CorruptHistoryError({
                  reason: `Personal Job history for ${session.id} is not readable.`,
                }),
            ),
          )).slice(0, limit)

          const taskSummaries = taskPage.items.slice(0, limit).map((task) => ({
            id: task.id,
            sessionID: task.sessionID,
            title: task.title,
            status: task.status,
            state: taskState(task.status, task.unresolvedBlockers),
            unresolvedBlockers: task.unresolvedBlockers,
            revision: task.revision,
            createdAt: task.time.created,
            updatedAt: task.time.updated,
          })) satisfies ReadonlyArray<PersonalWorkspace.TaskSummary>

          const runSummaries = sessionRuns.flatMap((snapshot) => {
            if (!("sessionID" in snapshot.run)) return []
            const run = snapshot.run
            const recoveryRequired = run.status === "recovering" || run.status === "failed"
            return [
              {
                runID: run.id,
                sessionID: run.sessionID,
                status: run.status,
                initiator: run.initiator,
                authority: run.authority,
                riskTier: run.riskTier,
                state: runState(run.status),
                recoveryRequired,
                budget: {
                  attemptsUsed: run.budget.attemptsUsed,
                  maxAttempts: run.budget.maxAttempts,
                  durationMsUsed: run.budget.durationMsUsed,
                  maxDurationMs: run.budget.maxDurationMs,
                  costMicrosUsed: run.budget.costMicrosUsed,
                  maxCostMicros: run.budget.maxCostMicros,
                },
                createdAt: run.time.created,
                updatedAt: run.time.updated,
                ...(run.time.started ? { startedAt: run.time.started } : {}),
                ...(run.time.finished ? { finishedAt: run.time.finished } : {}),
              } satisfies PersonalWorkspace.RunSummary,
            ]
          })

          const jobSummaries = sessionJobs.map(
            (job) =>
              ({
                id: job.id,
                sessionID: job.sessionID,
                title: job.title,
                status: job.status,
                visibility: job.visibility,
                scheduleLabel: job.schedule.label,
                nextRunAt: job.schedule.nextRunAt,
                approvalState: job.approvalState,
                state: jobState(job),
                needsHuman: jobState(job) === "needs_human",
                budget: {
                  attemptsUsed: job.budget.attemptsUsed,
                  maxAttempts: job.budget.maxAttempts,
                  durationMsUsed: job.budget.durationMsUsed,
                  maxDurationMs: job.budget.maxDurationMs,
                  costMicrosUsed: job.budget.costMicrosUsed,
                  maxCostMicros: job.budget.maxCostMicros,
                },
                artifactCount: job.result?.artifactRefs.length ?? 0,
                createdAt: job.time.created,
                updatedAt: job.time.updated,
              }) satisfies PersonalWorkspace.PersonalJobSummary,
          )

          return {
            active:
              runSummaries.some((run) => isActiveRun(run.status)) ||
              jobSummaries.some((job) => job.state === "system_automatic"),
            session: {
              id: session.id,
              title: session.title,
              projectID: session.projectID,
              state: sessionState([
                ...taskSummaries.map((task) => task.state),
                ...runSummaries.map((run) => run.state),
                ...jobSummaries.map((job) => job.state),
              ]),
              createdAt: DateTime.makeUnsafe(session.timeCreated),
              updatedAt: DateTime.makeUnsafe(session.timeUpdated),
              taskCount: taskSummaries.length,
              runCount: runSummaries.length,
              personalJobCount: jobSummaries.length,
              attentionCount:
                jobSummaries.filter((job) => job.needsHuman).length +
                runSummaries.filter((run) => run.recoveryRequired).length +
                runSummaries.filter((run) => run.status === "awaiting_authorization").length +
                jobSummaries.filter((job) => job.artifactCount > 0).length,
            } satisfies PersonalWorkspace.SessionSummary,
            tasks: taskSummaries,
            runs: runSummaries,
            jobs: jobSummaries,
          }
        }),
      )

      const taskSummaries = projected.flatMap((item) => item.tasks)
      const runSummaries = projected.flatMap((item) => item.runs)
      const jobSummaries = projected.flatMap((item) => item.jobs)
      const candidateRows = yield* database.db
        .select({
          id: MemoryCandidateTable.id,
          status: MemoryCandidateTable.status,
          sensitivity: MemoryCandidateTable.sensitivity,
          confidence: MemoryCandidateTable.confidence,
          timeCreated: MemoryCandidateTable.time_created,
          timeUpdated: MemoryCandidateTable.time_updated,
          policyStatus: MemoryCandidateTable.policy_status,
        })
        .from(MemoryCandidateTable)
        .where(
          and(
            eq(MemoryCandidateTable.tenant_id, tenantID),
            eq(MemoryCandidateTable.owner_user_id, userID),
            or(
              eq(MemoryCandidateTable.scope, "global"),
              and(
                eq(MemoryCandidateTable.project_id, String(location.project.id)),
                eq(MemoryCandidateTable.workspace_path, normalizedWorkspacePath),
              ),
            ),
            inArray(MemoryCandidateTable.status, ["proposed", "approved"]),
          ),
        )
        .orderBy(desc(MemoryCandidateTable.time_updated))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)

      const memoryCandidates = candidateRows.map(
        (candidate) =>
          ({
            candidateID: candidate.id,
            status: candidate.status,
            sensitivity: candidate.sensitivity,
            confidence: candidate.confidence,
            state:
              candidate.policyStatus === "deny"
                ? "human_visible"
                : candidate.status === "proposed" || candidate.status === "approved"
                  ? "needs_human"
                  : "system_automatic",
            needsHuman:
              (candidate.status === "proposed" || candidate.status === "approved") && candidate.policyStatus !== "deny",
            createdAt: DateTime.makeUnsafe(candidate.timeCreated),
            updatedAt: DateTime.makeUnsafe(candidate.timeUpdated),
          }) satisfies PersonalWorkspace.MemoryCandidateSummary,
      )

      const attention: PersonalWorkspace.Attention[] = []
      for (const job of jobSummaries) {
        if (job.approvalState === "pending")
          attention.push({
            kind: "pending_approval",
            severity: "warning",
            resourceType: "personal_job",
            resourceID: job.id,
            sessionID: job.sessionID,
            title: job.title,
            detail: "后台自动任务等待人工批准。",
          })
        if (job.artifactCount > 0)
          attention.push({
            kind: "artifact_ready",
            severity: "info",
            resourceType: "personal_job",
            resourceID: job.id,
            sessionID: job.sessionID,
            title: job.title,
            detail: `任务已产生 ${job.artifactCount} 个 artifact。`,
          })
      }
      for (const run of runSummaries) {
        if (run.status === "awaiting_authorization")
          attention.push({
            kind: "pending_approval",
            severity: "warning",
            resourceType: "run",
            resourceID: run.runID,
            sessionID: run.sessionID,
            title: `Run ${run.runID}`,
            detail: "Run 正在等待人工授权。",
          })
        if (run.recoveryRequired)
          attention.push({
            kind: "recovery_required",
            severity: "critical",
            resourceType: "run",
            resourceID: run.runID,
            sessionID: run.sessionID,
            title: `Run ${run.runID}`,
            detail: "Run 需要恢复或人工检查。",
          })
      }
      for (const candidate of memoryCandidates) {
        if (!candidate.needsHuman) continue
        attention.push({
          kind: "memory_candidate",
          severity: "warning",
          resourceType: "memory_candidate",
          resourceID: candidate.candidateID,
          title: `Memory Candidate ${candidate.candidateID}`,
          detail: "Memory Candidate 等待人工审查。",
        })
      }

      const runUsedMicros = runSummaries.reduce((sum, run) => sum + run.budget.costMicrosUsed, 0)
      const runLimitMicros = runSummaries.reduce((sum, run) => sum + run.budget.maxCostMicros, 0)
      const jobUsedMicros = jobSummaries.reduce((sum, job) => sum + job.budget.costMicrosUsed, 0)
      const jobLimitMicros = jobSummaries.reduce((sum, job) => sum + job.budget.maxCostMicros, 0)
      if (runUsedMicros + jobUsedMicros > 0)
        attention.push({
          kind: "cost_review",
          severity: "info",
          resourceType: "workspace",
          resourceID: location.project.id,
          title: "Cost",
          detail: "查看 Personal Workspace 的累计预算与已使用成本。",
        })

      return {
        asOf: DateTime.makeUnsafe(Date.now()),
        project: { id: location.project.id, directory: location.project.directory },
        location: {
          directory: location.directory,
          ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
          projectID: location.project.id,
          projectDirectory: location.project.directory,
        },
        sessions: projected.map((item) => item.session),
        tasks: taskSummaries,
        runs: runSummaries,
        personalJobs: jobSummaries,
        memoryCandidates,
        attention,
        counts: {
          sessions: sessionInfos.length,
          activeSessions: projected.filter((item) => item.active).length,
          tasks: taskSummaries.length,
          pendingTasks: taskSummaries.filter((task) => task.status === "pending").length,
          runs: runSummaries.length,
          activeRuns: runSummaries.filter((run) => isActiveRun(run.status)).length,
          recoveringRuns: runSummaries.filter((run) => run.recoveryRequired).length,
          personalJobs: jobSummaries.length,
          pendingApprovals: jobSummaries.filter((job) => job.approvalState === "pending").length,
          artifacts: jobSummaries.reduce((sum, job) => sum + job.artifactCount, 0),
          memoryCandidates: memoryCandidates.length,
        },
        cost: { runUsedMicros, runLimitMicros, jobUsedMicros, jobLimitMicros },
      } satisfies PersonalWorkspace.Snapshot
    })

    return Service.of({ snapshot })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Location.node, TaskGraphV2.node, DurableRun.node, PersonalJobV2.node],
})
