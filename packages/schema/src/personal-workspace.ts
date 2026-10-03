export * as PersonalWorkspace from "./personal-workspace"

import { AgentRuntime } from "./agent-runtime"
import * as MemoryCandidate from "./memory-candidate"
import { PersonalJob } from "./personal-job"
import { Project } from "./project"
import { Session } from "./session"
import { TaskGraph } from "./task-graph"
import { Workspace } from "./workspace"
import { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath, optional } from "./schema"
import { Schema } from "effect"

/** Safe UI state: it describes who must act without exposing execution input. */
export const AutomationState = Schema.Literals([
  "system_automatic",
  "needs_human",
  "human_visible",
  "settled",
]).annotate({ identifier: "PersonalWorkspace.AutomationState" })
export type AutomationState = typeof AutomationState.Type

export const ProjectSummary = Schema.Struct({
  id: Project.ID,
  directory: AbsolutePath,
}).annotate({ identifier: "PersonalWorkspace.ProjectSummary" })
export interface ProjectSummary extends Schema.Schema.Type<typeof ProjectSummary> {}

export const LocationSummary = Schema.Struct({
  directory: AbsolutePath,
  workspaceID: Workspace.ID.pipe(optional),
  projectID: Project.ID,
  projectDirectory: AbsolutePath,
}).annotate({ identifier: "PersonalWorkspace.LocationSummary" })
export interface LocationSummary extends Schema.Schema.Type<typeof LocationSummary> {}

export const SessionSummary = Schema.Struct({
  id: Session.ID,
  title: Schema.String,
  projectID: Project.ID,
  subpath: RelativePath.pipe(optional),
  state: AutomationState,
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
  taskCount: NonNegativeInt,
  runCount: NonNegativeInt,
  personalJobCount: NonNegativeInt,
  attentionCount: NonNegativeInt,
}).annotate({ identifier: "PersonalWorkspace.SessionSummary" })
export interface SessionSummary extends Schema.Schema.Type<typeof SessionSummary> {}

export const TaskSummary = Schema.Struct({
  id: TaskGraph.ID,
  sessionID: Session.ID,
  title: Schema.String,
  status: TaskGraph.Status,
  state: AutomationState,
  unresolvedBlockers: NonNegativeInt,
  revision: PositiveInt,
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PersonalWorkspace.TaskSummary" })
export interface TaskSummary extends Schema.Schema.Type<typeof TaskSummary> {}

export const RunBudget = Schema.Struct({
  attemptsUsed: NonNegativeInt,
  maxAttempts: PositiveInt,
  durationMsUsed: NonNegativeInt,
  maxDurationMs: PositiveInt,
  costMicrosUsed: NonNegativeInt,
  maxCostMicros: NonNegativeInt,
}).annotate({ identifier: "PersonalWorkspace.RunBudget" })
export interface RunBudget extends Schema.Schema.Type<typeof RunBudget> {}

export const RunSummary = Schema.Struct({
  runID: AgentRuntime.RunID,
  sessionID: Session.ID,
  status: AgentRuntime.RunStatus,
  initiator: AgentRuntime.Initiator,
  authority: AgentRuntime.Authority,
  riskTier: AgentRuntime.RiskTier,
  state: AutomationState,
  recoveryRequired: Schema.Boolean,
  budget: RunBudget,
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
  startedAt: DateTimeUtcFromMillis.pipe(optional),
  finishedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "PersonalWorkspace.RunSummary" })
export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}

export const JobBudget = Schema.Struct({
  attemptsUsed: NonNegativeInt,
  maxAttempts: PositiveInt,
  durationMsUsed: NonNegativeInt,
  maxDurationMs: PositiveInt,
  costMicrosUsed: NonNegativeInt,
  maxCostMicros: NonNegativeInt,
}).annotate({ identifier: "PersonalWorkspace.JobBudget" })
export interface JobBudget extends Schema.Schema.Type<typeof JobBudget> {}

export const PersonalJobSummary = Schema.Struct({
  id: PersonalJob.ID,
  sessionID: Session.ID,
  title: PersonalJob.Title,
  status: PersonalJob.Status,
  visibility: PersonalJob.Visibility,
  scheduleLabel: Schema.String,
  nextRunAt: DateTimeUtcFromMillis,
  approvalState: PersonalJob.ApprovalState,
  state: AutomationState,
  needsHuman: Schema.Boolean,
  budget: JobBudget,
  artifactCount: NonNegativeInt,
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PersonalWorkspace.PersonalJobSummary" })
export interface PersonalJobSummary extends Schema.Schema.Type<typeof PersonalJobSummary> {}

export const MemoryCandidateSummary = Schema.Struct({
  candidateID: MemoryCandidate.CandidateID,
  status: MemoryCandidate.Status,
  sensitivity: MemoryCandidate.Sensitivity,
  confidence: MemoryCandidate.Confidence,
  state: AutomationState,
  needsHuman: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PersonalWorkspace.MemoryCandidateSummary" })
export interface MemoryCandidateSummary extends Schema.Schema.Type<typeof MemoryCandidateSummary> {}

export const AttentionKind = Schema.Literals([
  "pending_approval",
  "recovery_required",
  "artifact_ready",
  "memory_candidate",
  "cost_review",
]).annotate({ identifier: "PersonalWorkspace.AttentionKind" })
export type AttentionKind = typeof AttentionKind.Type

export const AttentionSeverity = Schema.Literals(["info", "warning", "critical"]).annotate({
  identifier: "PersonalWorkspace.AttentionSeverity",
})
export type AttentionSeverity = typeof AttentionSeverity.Type

export const Attention = Schema.Struct({
  kind: AttentionKind,
  severity: AttentionSeverity,
  resourceType: Schema.Literals(["personal_job", "run", "memory_candidate", "workspace"]),
  resourceID: Schema.String,
  sessionID: Session.ID.pipe(optional),
  title: Schema.String,
  detail: Schema.String,
}).annotate({ identifier: "PersonalWorkspace.Attention" })
export interface Attention extends Schema.Schema.Type<typeof Attention> {}

export const Counts = Schema.Struct({
  sessions: NonNegativeInt,
  activeSessions: NonNegativeInt,
  tasks: NonNegativeInt,
  pendingTasks: NonNegativeInt,
  runs: NonNegativeInt,
  activeRuns: NonNegativeInt,
  recoveringRuns: NonNegativeInt,
  personalJobs: NonNegativeInt,
  pendingApprovals: NonNegativeInt,
  artifacts: NonNegativeInt,
  memoryCandidates: NonNegativeInt,
}).annotate({ identifier: "PersonalWorkspace.Counts" })
export interface Counts extends Schema.Schema.Type<typeof Counts> {}

export const Cost = Schema.Struct({
  runUsedMicros: NonNegativeInt,
  runLimitMicros: NonNegativeInt,
  jobUsedMicros: NonNegativeInt,
  jobLimitMicros: NonNegativeInt,
}).annotate({ identifier: "PersonalWorkspace.Cost" })
export interface Cost extends Schema.Schema.Type<typeof Cost> {}

export const Snapshot = Schema.Struct({
  asOf: DateTimeUtcFromMillis,
  project: ProjectSummary,
  location: LocationSummary,
  sessions: Schema.Array(SessionSummary),
  tasks: Schema.Array(TaskSummary),
  runs: Schema.Array(RunSummary),
  personalJobs: Schema.Array(PersonalJobSummary),
  memoryCandidates: Schema.Array(MemoryCandidateSummary),
  attention: Schema.Array(Attention),
  counts: Counts,
  cost: Cost,
}).annotate({ identifier: "PersonalWorkspace.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
