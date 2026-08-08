export * as AgentCapability from "./agent-capability"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "./schema"

export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  brand: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  python: Schema.NonEmptyString,
  python_supported: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.Health" })
export interface Health extends Schema.Schema.Type<typeof Health> {}

export const Info = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  kind: Schema.NonEmptyString,
  keywords: Schema.Array(Schema.String),
  priority: Schema.Int,
  enabled: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const List = Schema.Struct({
  count: NonNegativeInt,
  items: Schema.Array(Info),
}).annotate({ identifier: "AgentCapability.List" })
export interface List extends Schema.Schema.Type<typeof List> {}

export const SystemOverviewSection = Schema.Struct({
  id: Schema.Literals([
    "status",
    "runtime-stats",
    "runtime-metrics",
    "sandbox",
    "tools",
    "subagent-roles",
    "cost-optimization",
  ]),
  title: Schema.NonEmptyString,
  data: Schema.Unknown,
}).annotate({ identifier: "AgentCapability.SystemOverviewSection" })
export interface SystemOverviewSection extends Schema.Schema.Type<typeof SystemOverviewSection> {}

export const SystemOverview = Schema.Struct({
  schema_version: Schema.Literal(1),
  sections: Schema.Array(SystemOverviewSection),
}).annotate({ identifier: "AgentCapability.SystemOverview" })
export interface SystemOverview extends Schema.Schema.Type<typeof SystemOverview> {}

export const DeepInsightSection = Schema.Struct({
  id: Schema.Literals([
    "features",
    "file-state",
    "permission-rules",
    "permission-mode",
    "self-correct",
    "release-gates",
    "release-remediation",
  ]),
  title: Schema.NonEmptyString,
  data: Schema.Unknown,
}).annotate({ identifier: "AgentCapability.DeepInsightSection" })
export interface DeepInsightSection extends Schema.Schema.Type<typeof DeepInsightSection> {}

export const DeepInsights = Schema.Struct({
  schema_version: Schema.Literal(1),
  sections: Schema.Array(DeepInsightSection),
}).annotate({ identifier: "AgentCapability.DeepInsights" })
export interface DeepInsights extends Schema.Schema.Type<typeof DeepInsights> {}

export const QualityIssue = Schema.Struct({
  level: Schema.Literals(["error", "warning"]),
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  file: Schema.String,
}).annotate({ identifier: "AgentCapability.QualityIssue" })
export interface QualityIssue extends Schema.Schema.Type<typeof QualityIssue> {}

export const QualityDiffStats = Schema.Struct({
  files: Schema.Array(Schema.String),
  files_changed: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changed_lines: NonNegativeInt,
  hunks: NonNegativeInt,
  new_files: NonNegativeInt,
  deleted_files: NonNegativeInt,
}).annotate({ identifier: "AgentCapability.QualityDiffStats" })
export interface QualityDiffStats extends Schema.Schema.Type<typeof QualityDiffStats> {}

export const QualityAssessment = Schema.Struct({
  passed: Schema.Boolean,
  score: NonNegativeInt,
  files_checked: NonNegativeInt,
  diff_stats: QualityDiffStats.pipe(optional),
  issues: Schema.Array(QualityIssue),
  summary: Schema.NonEmptyString,
}).annotate({ identifier: "AgentCapability.QualityAssessment" })
export interface QualityAssessment extends Schema.Schema.Type<typeof QualityAssessment> {}

export const RepoScaleFile = Schema.Struct({
  path: Schema.NonEmptyString,
  suffix: Schema.String,
  bytes: NonNegativeInt,
}).annotate({ identifier: "AgentCapability.RepoScaleFile" })
export interface RepoScaleFile extends Schema.Schema.Type<typeof RepoScaleFile> {}

export const RepoScaleSearchItem = Schema.Struct({
  path: Schema.NonEmptyString,
  line: PositiveInt,
  score: PositiveInt,
  matched_terms: Schema.Array(Schema.NonEmptyString),
  preview: Schema.String,
}).annotate({ identifier: "AgentCapability.RepoScaleSearchItem" })
export interface RepoScaleSearchItem extends Schema.Schema.Type<typeof RepoScaleSearchItem> {}

export const RepoScaleReport = Schema.Struct({
  schema_version: Schema.Literal(1),
  root: Schema.NonEmptyString,
  budget: Schema.Struct({
    max_files: PositiveInt,
    suffixes: Schema.Array(Schema.String),
  }),
  scan: Schema.Struct({
    total: NonNegativeInt,
    added: NonNegativeInt,
    changed: NonNegativeInt,
    unchanged: NonNegativeInt,
    removed: NonNegativeInt,
    incremental: Schema.Boolean,
    scan_time_ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    truncated: Schema.Boolean,
    total_files_estimate: NonNegativeInt,
    code_files_estimate: NonNegativeInt,
  }),
  suffix_counts: Schema.Record(Schema.String, NonNegativeInt),
  largest_files: Schema.Array(RepoScaleFile),
  search: Schema.Struct({
    query: Schema.String,
    total: NonNegativeInt,
    items: Schema.Array(RepoScaleSearchItem),
    searched_files: NonNegativeInt,
    truncated: Schema.Boolean,
  }),
  recommendations: Schema.Array(Schema.NonEmptyString),
}).annotate({ identifier: "AgentCapability.RepoScaleReport" })
export interface RepoScaleReport extends Schema.Schema.Type<typeof RepoScaleReport> {}

export const RunID = Schema.String.check(Schema.isPattern(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)).annotate({
  identifier: "AgentCapability.RunID",
})
export type RunID = typeof RunID.Type

export const RunSummary = Schema.Struct({
  run_id: RunID,
  created: Schema.String,
  has_transaction: Schema.Boolean,
  has_trace: Schema.Boolean,
  has_messages: Schema.Boolean,
  changed_files: NonNegativeInt,
  trace_events: NonNegativeInt,
  messages_count: NonNegativeInt,
  answer_preview: Schema.String,
}).annotate({ identifier: "AgentCapability.RunSummary" })
export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}

export const RunList = Schema.Struct({
  schema_version: Schema.Literal(1),
  count: NonNegativeInt,
  items: Schema.Array(RunSummary),
}).annotate({ identifier: "AgentCapability.RunList" })
export interface RunList extends Schema.Schema.Type<typeof RunList> {}

export const RunCommand = Schema.Struct({
  command: Schema.String,
  success: Schema.Boolean,
  returncode: Schema.Union([Schema.Int, Schema.Null]),
}).annotate({ identifier: "AgentCapability.RunCommand" })
export interface RunCommand extends Schema.Schema.Type<typeof RunCommand> {}

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

export const RunReport = Schema.Struct({
  schema_version: Schema.Literal(1),
  run_id: RunID,
  created: Schema.String,
  has_transaction: Schema.Boolean,
  has_trace: Schema.Boolean,
  has_messages: Schema.Boolean,
  changed_files: Schema.Array(Schema.String),
  commands_run: Schema.Array(RunCommand),
  trace_events: NonNegativeInt,
  messages_count: NonNegativeInt,
  answer: Schema.String,
  observability: JsonObject,
  self_correct: JsonObject,
  trace: Schema.Array(JsonObject),
  trace_truncated: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.RunReport" })
export interface RunReport extends Schema.Schema.Type<typeof RunReport> {}

export const RunReportResult = Schema.Union([
  Schema.Struct({
    schema_version: Schema.Literal(1),
    found: Schema.Literal(false),
    run_id: Schema.String,
    report: Schema.Null,
  }),
  Schema.Struct({
    schema_version: Schema.Literal(1),
    found: Schema.Literal(true),
    run_id: RunID,
    report: RunReport,
  }),
]).annotate({ identifier: "AgentCapability.RunReportResult" })
export type RunReportResult = typeof RunReportResult.Type

export const ManagedSkill = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.String,
  version: Schema.String,
  source: Schema.String,
  path: Schema.String,
  entrypoint: Schema.String,
  license: Schema.String,
  tags: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  problems: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentCapability.ManagedSkill" })
export interface ManagedSkill extends Schema.Schema.Type<typeof ManagedSkill> {}

export const ManagedSkillList = Schema.Struct({
  count: NonNegativeInt,
  enabled_count: NonNegativeInt,
  items: Schema.Array(ManagedSkill),
  roots: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentCapability.ManagedSkillList" })
export interface ManagedSkillList extends Schema.Schema.Type<typeof ManagedSkillList> {}

export const ManagedSkillMutation = Schema.Struct({
  skill_id: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  changed: Schema.Boolean,
  skills: ManagedSkillList,
}).annotate({ identifier: "AgentCapability.ManagedSkillMutation" })
export interface ManagedSkillMutation extends Schema.Schema.Type<typeof ManagedSkillMutation> {}

export const SkillReadResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    manifest: ManagedSkill,
    content: Schema.String,
    truncated: Schema.Boolean,
    resources: Schema.Array(Schema.String),
  }),
]).annotate({ identifier: "AgentCapability.SkillReadResult" })
export type SkillReadResult = typeof SkillReadResult.Type

export const SkillRoute = Schema.Struct({
  mode: Schema.NonEmptyString,
  selected: Schema.Array(Schema.String),
  phases: Schema.Array(Schema.String),
  reasons: Schema.Record(Schema.String, Schema.String),
  missing: Schema.Array(Schema.String),
  relationship: Schema.String,
}).annotate({ identifier: "AgentCapability.SkillRoute" })
export interface SkillRoute extends Schema.Schema.Type<typeof SkillRoute> {}

export const CustomCommand = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  template: Schema.String,
  source: Schema.String,
  path: Schema.String,
  category: Schema.String,
  problems: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentCapability.CustomCommand" })
export interface CustomCommand extends Schema.Schema.Type<typeof CustomCommand> {}

export const CustomHook = Schema.Struct({
  name: Schema.NonEmptyString,
  event: Schema.String,
  description: Schema.String,
  source: Schema.String,
  path: Schema.String,
  priority: Schema.Int,
  enabled: Schema.Boolean,
  matcher: Schema.String,
  timeout_seconds: PositiveInt,
  problems: Schema.Array(Schema.String),
  command_configured: Schema.Boolean,
  executable: Schema.String,
}).annotate({ identifier: "AgentCapability.CustomHook" })
export interface CustomHook extends Schema.Schema.Type<typeof CustomHook> {}

export const CustomizationList = Schema.Struct({
  commands: Schema.Struct({
    count: NonNegativeInt,
    enabled_count: NonNegativeInt,
    items: Schema.Array(CustomCommand),
  }),
  hooks: Schema.Struct({
    count: NonNegativeInt,
    enabled_count: NonNegativeInt,
    items: Schema.Array(CustomHook),
  }),
  roots: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentCapability.CustomizationList" })
export interface CustomizationList extends Schema.Schema.Type<typeof CustomizationList> {}

export const CustomizationRender = Schema.Struct({
  name: Schema.NonEmptyString,
  rendered: Schema.String,
}).annotate({ identifier: "AgentCapability.CustomizationRender" })
export interface CustomizationRender extends Schema.Schema.Type<typeof CustomizationRender> {}

export const PlanPreview = Schema.Struct({
  schema_version: Schema.Literal(1),
  mode: Schema.Literal("plan"),
  approval_required: Schema.Boolean,
  execution_mode_after_approval: Schema.String,
  task: Schema.NonEmptyString,
  summary: Schema.String,
  affected_files: Schema.Array(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      index: PositiveInt,
      content: Schema.String,
      status: Schema.String,
    }),
  ),
  risks: Schema.Array(Schema.String),
  rollback: Schema.Array(Schema.String),
  estimated_steps: PositiveInt,
  raw_plan: Schema.String,
}).annotate({ identifier: "AgentCapability.PlanPreview" })
export interface PlanPreview extends Schema.Schema.Type<typeof PlanPreview> {}

export const RunTraceExport = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("json"),
    mime_type: Schema.Literal("application/json"),
    filename: Schema.Literal(""),
    content: Schema.Literal(""),
    trace_events: Schema.Literal(0),
    found: Schema.Literal(false),
  }),
  Schema.Struct({
    format: Schema.Literal("json"),
    mime_type: Schema.Literal("application/json"),
    filename: Schema.NonEmptyString,
    content: Schema.String,
    trace_events: NonNegativeInt,
  }),
]).annotate({ identifier: "AgentCapability.RunTraceExport" })
export type RunTraceExport = typeof RunTraceExport.Type

export const WorkflowEvent = Schema.Struct({
  sequence: PositiveInt,
  type: Schema.NonEmptyString,
  node_id: Schema.String,
  data: Schema.Unknown,
  created_at: Schema.String,
}).annotate({ identifier: "AgentCapability.WorkflowEvent" })
export interface WorkflowEvent extends Schema.Schema.Type<typeof WorkflowEvent> {}

export const WorkflowEventList = Schema.Struct({
  schema_version: Schema.Literal(1),
  run_id: Schema.NonEmptyString,
  items: Schema.Array(WorkflowEvent),
  count: NonNegativeInt,
  next_after: NonNegativeInt,
}).annotate({ identifier: "AgentCapability.WorkflowEventList" })
export interface WorkflowEventList extends Schema.Schema.Type<typeof WorkflowEventList> {}

export const PluginTool = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "AgentCapability.PluginTool" })

export const ManagedPlugin = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.String,
  description: Schema.String,
  hooks: Schema.Array(Schema.String),
  tools: Schema.Array(PluginTool),
  manifest_path: Schema.String,
  entrypoint: Schema.String,
  enabled: Schema.Boolean,
  problems: Schema.Array(Schema.String),
  managed: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.ManagedPlugin" })
export interface ManagedPlugin extends Schema.Schema.Type<typeof ManagedPlugin> {}

export const ManagedPluginList = Schema.Struct({
  count: NonNegativeInt,
  items: Schema.Array(ManagedPlugin),
  roots: Schema.Array(Schema.String),
}).annotate({ identifier: "AgentCapability.ManagedPluginList" })
export interface ManagedPluginList extends Schema.Schema.Type<typeof ManagedPluginList> {}

export const PluginInspection = Schema.Struct({
  token: Schema.NonEmptyString,
  source: Schema.String,
  expires_in_seconds: PositiveInt,
  selection_required: Schema.Boolean,
  candidates: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      version: Schema.String,
      description: Schema.String,
      hooks: Schema.Array(Schema.String),
      tools: Schema.Array(PluginTool),
      manifest_path: Schema.String,
      entrypoint: Schema.String,
      enabled: Schema.Boolean,
      problems: Schema.Array(Schema.String),
      sha256: Schema.NonEmptyString,
    }),
  ),
}).annotate({ identifier: "AgentCapability.PluginInspection" })
export interface PluginInspection extends Schema.Schema.Type<typeof PluginInspection> {}

export const PluginTransactionResult = Schema.Struct({
  transaction: Schema.Unknown,
  plugins: ManagedPluginList,
}).annotate({ identifier: "AgentCapability.PluginTransactionResult" })
export interface PluginTransactionResult extends Schema.Schema.Type<typeof PluginTransactionResult> {}

export const WorkflowDefinition = Schema.Struct({
  path: Schema.NonEmptyString,
  valid: Schema.Boolean,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  schema_version: PositiveInt.pipe(optional),
  nodes: NonNegativeInt.pipe(optional),
  edges: NonNegativeInt.pipe(optional),
  has_approval: Schema.Boolean.pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "AgentCapability.WorkflowDefinition" })
export interface WorkflowDefinition extends Schema.Schema.Type<typeof WorkflowDefinition> {}

export const WorkflowDefinitionList = Schema.Struct({
  schema_version: Schema.Literal(1),
  items: Schema.Array(WorkflowDefinition),
  count: NonNegativeInt,
}).annotate({ identifier: "AgentCapability.WorkflowDefinitionList" })
export interface WorkflowDefinitionList extends Schema.Schema.Type<typeof WorkflowDefinitionList> {}

export const WorkflowPreview = Schema.Struct({
  schema_version: PositiveInt,
  name: Schema.NonEmptyString,
  source_path: Schema.String,
  success: Schema.Boolean,
  dry_run: Schema.Boolean,
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      title: Schema.String,
      status: Schema.String,
      output: Schema.String,
      error: Schema.String,
    }),
  ),
  edges: Schema.Array(Schema.Struct({ from: Schema.NonEmptyString, to: Schema.NonEmptyString })),
  node_kinds: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "AgentCapability.WorkflowPreview" })
export interface WorkflowPreview extends Schema.Schema.Type<typeof WorkflowPreview> {}

const NullableString = Schema.Union([Schema.String, Schema.Null])

export const WorkflowNode = Schema.Struct({
  node_id: Schema.NonEmptyString,
  title: Schema.String,
  kind: Schema.String,
  access: Schema.String,
  status: Schema.String,
  attempt: NonNegativeInt,
  max_attempts: PositiveInt,
  depends_on: Schema.Array(Schema.String),
  continue_on_error: Schema.Boolean,
  condition: Schema.Unknown,
  output: Schema.String,
  error: Schema.String,
  started_at: NullableString,
  finished_at: NullableString,
}).annotate({ identifier: "AgentCapability.WorkflowNode" })
export interface WorkflowNode extends Schema.Schema.Type<typeof WorkflowNode> {}

export const WorkflowRun = Schema.Struct({
  schema_version: Schema.Literal(1),
  run_id: Schema.NonEmptyString,
  session_id: Schema.String,
  name: Schema.NonEmptyString,
  description: Schema.String,
  source_path: Schema.String,
  workspace: Schema.String,
  permission_mode: Schema.String,
  status: Schema.String,
  max_parallel: PositiveInt,
  created_at: Schema.String,
  updated_at: Schema.String,
  started_at: NullableString,
  finished_at: NullableString,
  last_error: Schema.String,
  progress: Schema.Struct({
    settled: NonNegativeInt,
    total: NonNegativeInt,
    percent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    by_status: Schema.Record(Schema.String, NonNegativeInt),
  }),
  nodes: Schema.Array(WorkflowNode),
}).annotate({ identifier: "AgentCapability.WorkflowRun" })
export interface WorkflowRun extends Schema.Schema.Type<typeof WorkflowRun> {}

export const WorkflowRunList = Schema.Struct({
  schema_version: Schema.Literal(1),
  items: Schema.Array(WorkflowRun),
  count: NonNegativeInt,
}).annotate({ identifier: "AgentCapability.WorkflowRunList" })
export interface WorkflowRunList extends Schema.Schema.Type<typeof WorkflowRunList> {}

export const EvolutionCandidateState = Schema.Struct({
  schema_version: Schema.Literal(1),
  candidate_id: Schema.NonEmptyString,
  artifact_digest: Schema.NonEmptyString,
  status: Schema.Literals(["proposed", "evaluated", "approved", "rejected", "canary", "promoted", "rolled_back"]),
  revision: PositiveInt,
  updated_at: Schema.NonEmptyString,
  evaluation_id: Schema.String,
  approval: Schema.Unknown,
  deployment: Schema.Unknown,
  rollback: Schema.Unknown,
}).annotate({ identifier: "AgentCapability.EvolutionCandidateState" })
export interface EvolutionCandidateState extends Schema.Schema.Type<typeof EvolutionCandidateState> {}

export const EvolutionEvaluationCase = Schema.Struct({
  case_id: Schema.NonEmptyString,
  category: Schema.NonEmptyString,
  passed: Schema.Boolean,
  score: Schema.Finite,
  baseline_score: Schema.Finite,
  detail: Schema.String,
  required: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.EvolutionEvaluationCase" })

export const EvolutionEvaluation = Schema.Struct({
  schema_version: Schema.Literal(1),
  candidate_id: Schema.NonEmptyString,
  candidate_digest: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  isolation: Schema.Literal("temporary_directory"),
  workspace_retained: Schema.Literal(false),
  gate_passed: Schema.Boolean,
  cases: Schema.Array(EvolutionEvaluationCase),
  evaluation_id: Schema.NonEmptyString,
  report_digest: Schema.NonEmptyString,
}).annotate({ identifier: "AgentCapability.EvolutionEvaluation" })

export const EvolutionCandidate = Schema.Struct({
  schema_version: Schema.Literal(1),
  candidate_type: Schema.Literal("strategy_rule"),
  title: Schema.NonEmptyString,
  target: Schema.Literals(["learning.failure", "learning.fix", "learning.preference", "routing.advice", "tool.advice"]),
  instruction: Schema.NonEmptyString,
  rationale: Schema.NonEmptyString,
  evidence_refs: Schema.Array(Schema.NonEmptyString),
  created_by: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  constitution_version: Schema.NonEmptyString,
  candidate_id: Schema.NonEmptyString,
  artifact_digest: Schema.NonEmptyString,
  state: EvolutionCandidateState,
  evaluation: EvolutionEvaluation.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionCandidate" })
export interface EvolutionCandidate extends Schema.Schema.Type<typeof EvolutionCandidate> {}

export const EvolutionCandidateList = Schema.Struct({
  schema_version: Schema.Literal(1),
  count: NonNegativeInt,
  items: Schema.Array(EvolutionCandidate),
}).annotate({ identifier: "AgentCapability.EvolutionCandidateList" })
export interface EvolutionCandidateList extends Schema.Schema.Type<typeof EvolutionCandidateList> {}

export const EvolutionStatus = Schema.Struct({
  schema_version: Schema.Literal(1),
  counts: Schema.Record(Schema.String, NonNegativeInt),
  total: NonNegativeInt,
  active: NonNegativeInt,
  constitution: Schema.Struct({
    version: Schema.NonEmptyString,
    allowed_targets: Schema.Array(Schema.String),
    protected_prefixes: Schema.Array(Schema.String),
    self_approval_allowed: Schema.Literal(false),
    source_mutation_allowed: Schema.Literal(false),
  }),
  audit: Schema.Struct({
    schema_version: Schema.Literal(1),
    valid: Schema.Boolean,
    events: NonNegativeInt,
    head_hash: Schema.String.pipe(optional),
    issue: Schema.String,
  }),
  policy: Schema.Struct({
    min_auto_proposal_frequency: PositiveInt,
    min_auto_proposal_confidence: Schema.Finite,
    min_canary_observations: NonNegativeInt,
    min_control_observations: NonNegativeInt,
    min_canary_success_rate: Schema.Finite,
    min_success_rate_delta: Schema.Finite,
    default_traffic_percent: PositiveInt,
    auto_rollback_min_observations: NonNegativeInt,
    auto_rollback_success_rate: Schema.Finite,
    max_active_candidates: PositiveInt,
  }),
}).annotate({ identifier: "AgentCapability.EvolutionStatus" })
export interface EvolutionStatus extends Schema.Schema.Type<typeof EvolutionStatus> {}

export const EvolutionOpportunity = Schema.Struct({
  kind: Schema.NonEmptyString,
  source_ref: Schema.NonEmptyString,
  category: Schema.String,
  proposal_available: Schema.Boolean,
  frequency: NonNegativeInt.pipe(optional),
  confidence: Schema.Finite.pipe(optional),
  stop_reason: Schema.String.pipe(optional),
  count: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionOpportunity" })

export const EvolutionOpportunityList = Schema.Struct({
  schema_version: Schema.Literal(1),
  count: NonNegativeInt,
  items: Schema.Array(EvolutionOpportunity),
}).annotate({ identifier: "AgentCapability.EvolutionOpportunityList" })
export interface EvolutionOpportunityList extends Schema.Schema.Type<typeof EvolutionOpportunityList> {}

export const EvolutionCanaryReport = Schema.Struct({
  schema_version: Schema.Literal(1),
  candidate_id: Schema.NonEmptyString,
  candidate_digest: Schema.NonEmptyString,
  candidate_observations: NonNegativeInt,
  control_observations: NonNegativeInt,
  candidate_success_rate: Schema.Finite,
  control_success_rate: Schema.Finite,
  success_rate_delta: Schema.Finite,
  safety_incidents: NonNegativeInt,
  control_safety_incidents: NonNegativeInt,
  checks: Schema.Record(Schema.String, Schema.Boolean),
  gate_passed: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.EvolutionCanaryReport" })
export interface EvolutionCanaryReport extends Schema.Schema.Type<typeof EvolutionCanaryReport> {}

export const EvolutionContextPreview = Schema.Struct({
  schema_version: Schema.Literal(1),
  text: Schema.String,
  candidate_ids: Schema.Array(Schema.String),
  cohorts: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "AgentCapability.EvolutionContextPreview" })
export interface EvolutionContextPreview extends Schema.Schema.Type<typeof EvolutionContextPreview> {}

export const EvolutionExposureAssignment = Schema.Struct({
  candidate_id: Schema.NonEmptyString,
  candidate_digest: Schema.NonEmptyString,
  cohort: Schema.Literals(["candidate", "control"]),
}).annotate({ identifier: "AgentCapability.EvolutionExposureAssignment" })
export interface EvolutionExposureAssignment extends Schema.Schema.Type<typeof EvolutionExposureAssignment> {}

export const EvolutionExposureSource = Schema.Struct({
  kind: Schema.Literal("session_turn"),
  authority: Schema.Literal("typescript-core"),
  session_id: Schema.String.check(Schema.isStartsWith("ses"), Schema.isMaxLength(160)),
  user_message_id: Schema.String.check(Schema.isStartsWith("msg_"), Schema.isMaxLength(160)),
  turn_step: PositiveInt,
}).annotate({ identifier: "AgentCapability.EvolutionExposureSource" })
export interface EvolutionExposureSource extends Schema.Schema.Type<typeof EvolutionExposureSource> {}

export const EvolutionExposureOutcome = Schema.Struct({
  success: Schema.Boolean,
  stop_reason: Schema.String,
  safety_incident: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.EvolutionExposureOutcome" })
export interface EvolutionExposureOutcome extends Schema.Schema.Type<typeof EvolutionExposureOutcome> {}

export const EvolutionExposureReceipt = Schema.Struct({
  receipt_digest: Schema.NonEmptyString,
  recorded_at: Schema.NonEmptyString,
  outcome: Schema.Union([EvolutionExposureOutcome, Schema.Null]),
  observation_count: NonNegativeInt,
  assistant_message_id: Schema.String.check(Schema.isStartsWith("msg_"), Schema.isMaxLength(160)).pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionExposureReceipt" })
export interface EvolutionExposureReceipt extends Schema.Schema.Type<typeof EvolutionExposureReceipt> {}

export const EvolutionExposure = Schema.Struct({
  schema_version: Schema.Literal(1),
  exposure_id: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  cohort_key_digest: Schema.NonEmptyString,
  context_digest: Schema.NonEmptyString,
  injected_candidate_ids: Schema.Array(Schema.NonEmptyString),
  assignments: Schema.Array(EvolutionExposureAssignment),
  status: Schema.Literals(["pending", "recorded"]),
  ticket_digest: Schema.NonEmptyString,
  receipt: Schema.Union([EvolutionExposureReceipt, Schema.Null]),
  source: EvolutionExposureSource.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionExposure" })
export interface EvolutionExposure extends Schema.Schema.Type<typeof EvolutionExposure> {}

export const EvolutionExposureList = Schema.Struct({
  schema_version: Schema.Literal(1),
  count: NonNegativeInt,
  total: NonNegativeInt,
  counts: Schema.Struct({
    pending: NonNegativeInt,
    recorded: NonNegativeInt,
  }),
  truncated: Schema.Boolean,
  items: Schema.Array(EvolutionExposure),
}).annotate({ identifier: "AgentCapability.EvolutionExposureList" })
export interface EvolutionExposureList extends Schema.Schema.Type<typeof EvolutionExposureList> {}

const Sha256Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const EvolutionExposureArchiveItem = Schema.Struct({
  exposure_id: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  ticket_digest: Sha256Digest,
  receipt_digest: Sha256Digest,
  source: EvolutionExposureSource.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveItem" })
export interface EvolutionExposureArchiveItem extends Schema.Schema.Type<typeof EvolutionExposureArchiveItem> {}

export const EvolutionExposureArchivePlan = Schema.Struct({
  schema_version: Schema.Literal(1),
  archive_id: Schema.NonEmptyString,
  plan_digest: Sha256Digest,
  keep_recorded: NonNegativeInt,
  eligible_count: NonNegativeInt,
  counts: Schema.Struct({
    pending: NonNegativeInt,
    recorded: NonNegativeInt,
    retained_recorded: NonNegativeInt,
  }),
  truncated: Schema.Boolean,
  items: Schema.Array(EvolutionExposureArchiveItem),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchivePlan" })
export interface EvolutionExposureArchivePlan extends Schema.Schema.Type<typeof EvolutionExposureArchivePlan> {}

export const EvolutionExposureArchiveResult = Schema.Struct({
  schema_version: Schema.Literal(1),
  applied: Schema.Boolean,
  archive_id: Schema.NonEmptyString,
  plan_digest: Sha256Digest,
  archived_count: NonNegativeInt,
  completed_at: Schema.String,
  active_counts: Schema.Struct({
    pending: NonNegativeInt,
    recorded: NonNegativeInt,
  }),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveResult" })
export interface EvolutionExposureArchiveResult extends Schema.Schema.Type<typeof EvolutionExposureArchiveResult> {}

const EmptyOrSha256Digest = Schema.Union([Schema.Literal(""), Sha256Digest])

export const EvolutionExposureArchiveRestoreStatus = Schema.Struct({
  missing: NonNegativeInt,
  identical: NonNegativeInt,
  conflicts: NonNegativeInt,
  can_restore: Schema.Boolean,
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveRestoreStatus" })

export const EvolutionExposureArchiveSummary = Schema.Struct({
  schema_version: Schema.Literal(1),
  archive_id: Schema.NonEmptyString,
  integrity: Schema.Struct({
    valid: Schema.Boolean,
    issue: Schema.String,
  }),
  published_at: Schema.String,
  completed_at: Schema.String,
  archived_count: NonNegativeInt,
  keep_recorded: NonNegativeInt,
  plan_digest: EmptyOrSha256Digest,
  manifest_digest: EmptyOrSha256Digest,
  completion_digest: EmptyOrSha256Digest,
  evidence_set_digest: EmptyOrSha256Digest,
  restore: EvolutionExposureArchiveRestoreStatus,
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveSummary" })
export interface EvolutionExposureArchiveSummary extends Schema.Schema.Type<typeof EvolutionExposureArchiveSummary> {}

export const EvolutionExposureArchiveList = Schema.Struct({
  schema_version: Schema.Literal(1),
  count: NonNegativeInt,
  total: NonNegativeInt,
  valid_count: NonNegativeInt,
  invalid_count: NonNegativeInt,
  truncated: Schema.Boolean,
  items: Schema.Array(EvolutionExposureArchiveSummary),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveList" })
export interface EvolutionExposureArchiveList extends Schema.Schema.Type<typeof EvolutionExposureArchiveList> {}

export const EvolutionExposureArchiveEvidenceItem = Schema.Struct({
  exposure_id: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  ticket_digest: Sha256Digest,
  receipt_digest: Sha256Digest,
  ticket_file_digest: Sha256Digest,
  receipt_file_digest: Sha256Digest,
  live_status: Schema.Literals(["missing", "identical", "conflict"]),
  source: EvolutionExposureSource.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveEvidenceItem" })

export const EvolutionExposureArchiveDetail = Schema.Struct({
  ...EvolutionExposureArchiveSummary.fields,
  count: NonNegativeInt,
  truncated: Schema.Boolean,
  capacity_exceeded: Schema.Boolean,
  active_total: NonNegativeInt,
  active_after: NonNegativeInt,
  items: Schema.Array(EvolutionExposureArchiveEvidenceItem),
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveDetail" })
export interface EvolutionExposureArchiveDetail extends Schema.Schema.Type<typeof EvolutionExposureArchiveDetail> {}

export const EvolutionExposureRestoreItem = Schema.Struct({
  exposure_id: Schema.NonEmptyString,
  created_at: Schema.NonEmptyString,
  ticket_digest: Sha256Digest,
  receipt_digest: Sha256Digest,
  live_status: Schema.Literals(["missing", "identical", "conflict"]),
  source: EvolutionExposureSource.pipe(optional),
}).annotate({ identifier: "AgentCapability.EvolutionExposureRestoreItem" })

export const EvolutionExposureRestorePlan = Schema.Struct({
  schema_version: Schema.Literal(1),
  restore_id: Schema.String.check(Schema.isPattern(/^xr-[0-9a-f]{24}$/)),
  archive_id: Schema.String.check(Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
  plan_digest: Sha256Digest,
  manifest_digest: Sha256Digest,
  completion_digest: Sha256Digest,
  archived_count: NonNegativeInt,
  counts: Schema.Struct({
    missing: NonNegativeInt,
    already_present: NonNegativeInt,
    conflicts: NonNegativeInt,
    active_total: NonNegativeInt,
    active_after: NonNegativeInt,
  }),
  capacity_exceeded: Schema.Boolean,
  can_apply: Schema.Boolean,
  truncated: Schema.Boolean,
  items: Schema.Array(EvolutionExposureRestoreItem),
}).annotate({ identifier: "AgentCapability.EvolutionExposureRestorePlan" })
export interface EvolutionExposureRestorePlan extends Schema.Schema.Type<typeof EvolutionExposureRestorePlan> {}

export const EvolutionExposureRestoreResult = Schema.Struct({
  schema_version: Schema.Literal(1),
  applied: Schema.Boolean,
  restore_id: Schema.String.check(Schema.isPattern(/^xr-[0-9a-f]{24}$/)),
  archive_id: Schema.String.check(Schema.isPattern(/^xa-[0-9a-f]{24}$/)),
  plan_digest: Sha256Digest,
  restored_count: NonNegativeInt,
  already_present_count: NonNegativeInt,
  completed_at: Schema.String,
  active_counts: Schema.Struct({
    pending: NonNegativeInt,
    recorded: NonNegativeInt,
  }),
}).annotate({ identifier: "AgentCapability.EvolutionExposureRestoreResult" })
export interface EvolutionExposureRestoreResult extends Schema.Schema.Type<typeof EvolutionExposureRestoreResult> {}

export const EvolutionExposureArchiveExport = Schema.Struct({
  schema_version: Schema.Literal(1),
  filename: Schema.String.check(Schema.isPattern(/^arforge-xa-[0-9a-f]{24}-public-audit\.json$/)),
  media_type: Schema.Literal("application/json"),
  sha256: Sha256Digest,
  content: Schema.NonEmptyString,
}).annotate({ identifier: "AgentCapability.EvolutionExposureArchiveExport" })
export interface EvolutionExposureArchiveExport extends Schema.Schema.Type<typeof EvolutionExposureArchiveExport> {}

export const EvolutionAuditEvent = Schema.Struct({
  schema_version: Schema.Literal(1),
  sequence: PositiveInt,
  recorded_at: Schema.NonEmptyString,
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["candidate", "archive", "restore", "exposure", "system"]),
  action: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  reason: Schema.String,
  metadata: JsonObject,
  previous_hash: Schema.String,
  record_hash: Sha256Digest,
}).annotate({ identifier: "AgentCapability.EvolutionAuditEvent" })
export interface EvolutionAuditEvent extends Schema.Schema.Type<typeof EvolutionAuditEvent> {}

export const EvolutionAuditEventList = Schema.Struct({
  schema_version: Schema.Literal(1),
  valid: Schema.Literal(true),
  head_hash: Schema.String,
  total: NonNegativeInt,
  count: NonNegativeInt,
  truncated: Schema.Boolean,
  items: Schema.Array(EvolutionAuditEvent),
}).annotate({ identifier: "AgentCapability.EvolutionAuditEventList" })
export interface EvolutionAuditEventList extends Schema.Schema.Type<typeof EvolutionAuditEventList> {}
