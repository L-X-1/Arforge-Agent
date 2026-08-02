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

export const RunID = Schema.String.check(
  Schema.isPattern(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
).annotate({ identifier: "AgentCapability.RunID" })
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
