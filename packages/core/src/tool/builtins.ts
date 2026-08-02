export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { GoalUpdateTool } from "./goal-update"
import { CooperativeWaitTool } from "./cooperative-wait"
import { NotebookTools } from "./notebook"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { ToolSearchTool } from "./search"
import { TodoWriteTool } from "./todowrite"
import { TaskGraphTools } from "./task-graph"
import { TeamTools } from "./team"
import { TriggerTools } from "./trigger"
import { PrimaryDeliveryTool } from "./primary-delivery"
import { MultimodalDiagnoseTool } from "./multimodal-diagnose"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task, LSP,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    GoalUpdateTool.node,
    CooperativeWaitTool.node,
    NotebookTools.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    ToolSearchTool.node,
    TodoWriteTool.node,
    TaskGraphTools.node,
    TeamTools.node,
    TriggerTools.node,
    PrimaryDeliveryTool.node,
    MultimodalDiagnoseTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})
