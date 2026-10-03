import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@arforge-ai/core/observability"

import { FSUtil } from "@arforge-ai/core/fs-util"
import { Database } from "@arforge-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@arforge-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { SessionShareReadonlyLocal } from "@/share/readonly-local"
import { SessionShareReceiptStore } from "@/share/receipt-store"
import { Npm } from "@arforge-ai/core/npm"
import { memoMap } from "@arforge-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { SubagentControlRecovery } from "@arforge-ai/core/runtime/subagent-control-recovery"
import { RuntimeInvariants } from "@arforge-ai/core/runtime"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionExecutionFormal } from "@/session/execution-formal"

export const AppLayer = AppNodeBuilderV1.build(
  LayerNode.group([
    Npm.node,
    FSUtil.node,
    Database.node,
    Auth.node,
    Account.node,
    Config.node,
    Git.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelsDev.node,
    Provider.node,
    ProviderAuth.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    Todo.node,
    Session.node,
    SessionExecution.node,
    SessionProjector.node,
    SessionStatus.node,
    BackgroundJob.node,
    SubagentProvider.node,
    SubagentChildExecutor.node,
    SubagentControlRecovery.node,
    RuntimeInvariants.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    SessionProcessor.node,
    SessionCompaction.node,
    SessionRevert.node,
    SessionSummary.node,
    SessionPrompt.node,
    Instruction.node,
    LLM.node,
    LSP.node,
    MCP.node,
    LocationServiceMap.node,
    McpAuth.node,
    Command.node,
    Truncate.node,
    ToolRegistry.node,
    Format.node,
    InstanceStore.node,
    Project.node,
    Vcs.node,
    Workspace.node,
    Worktree.node,
    Installation.node,
    ShareNext.node,
    SessionShare.node,
    SessionShareReadonlyLocal.node,
    SessionShareReceiptStore.node,
    RollbackArtifact.node,
  ]),
  [[SessionExecution.node, SessionExecutionFormal.node]],
).pipe(Layer.provideMerge(AppNodeBuilderV1.build(Ripgrep.node)), Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
