import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { createWriteStream } from "node:fs"
import path from "path"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import os from "os"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRevert } from "./revert"
import { Session } from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"

import { Instruction } from "./instruction"
import { Plugin } from "../plugin"
import { ToolRegistry } from "@/tool/registry"
import { ToolCoreBridge } from "@/tool/core-bridge"
import { MCP } from "../mcp"
import { McpResourceProjection } from "../mcp/resource-projection"
import { LSP } from "@/lsp/lsp"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { NamedError } from "@arforge-ai/core/util/error"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@arforge-ai/core/shell"
import { ShellID } from "@/tool/shell/id"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Image } from "@/image/image"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, DateTime, Effect, Exit, Latch, Layer, Option, Scope, Context, Schema, Types } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { deliverTaskNotification, readRecoveryIntent, TaskRuntime, type TaskPromptOps } from "@/tool/task"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@arforge-ai/core/database/database"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { eq } from "drizzle-orm"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { Prompt as DurablePrompt, RequestSystem as DurableRequestSystem } from "@arforge-ai/schema/prompt"
import { SessionTools } from "./tools"
import { LLMEvent } from "@arforge-ai/llm"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionEvent as CoreSessionEvent } from "@arforge-ai/core/session/event"
import { SessionStore } from "@arforge-ai/core/session/store"
import { CoreMessageCompat } from "./core-message-compat"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { forToolCall } from "@arforge-ai/core/tool/effect-semantics"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { TurnToolCarrier } from "@arforge-ai/core/tool/turn-carrier"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as RunnerInvariants from "@arforge-ai/core/session/runner/invariants"
import type { AnyTool as CoreAnyTool } from "@arforge-ai/core/tool/tool"
import { normalizeGenerated as normalizeGeneratedTitle } from "@arforge-ai/core/session/title"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

// Durable admission must be able to materialize a visible legacy projection
// even when the session has not selected a model yet. This sentinel is only
// used for that projection; the formal runner will fail closed before making
// a provider call if no real model is subsequently selected.
const UNSELECTED_MATERIALIZATION_MODEL = {
  providerID: ProviderV2.ID.make("unselected"),
  modelID: ModelV2.ID.make("unselected"),
} as const

/**
 * Freeze the post-plugin, post-attachment mature user projection into the
 * canonical durable Prompt contract.  Execution remains owned by
 * SessionExecution; this adapter only removes the legacy HTTP admission gap
 * so the formal Core runner observes one stable message identity.
 */
export const durablePromptFromMatureMessage = (
  message: SessionV1.WithParts,
  command?: DurablePrompt["command"],
): DurablePrompt => {
  if (message.info.role !== "user") throw new TypeError("Durable prompt admission requires a user message")
  const inlineTextAttachment = (part: SessionV1.FilePart) => {
    if (part.mime === "text/plain") return undefined
    if (!part.mime.startsWith("text/") && part.mime !== "application/json") return undefined
    const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.url)
    if (!match) return undefined
    try {
      return Buffer.from(match[1]!, "base64").toString("utf8")
    } catch {
      return undefined
    }
  }
  const text = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text]
      if (part.type === "subtask") return [part.prompt]
      if (part.type === "file") {
        const decoded = inlineTextAttachment(part)
        return decoded === undefined ? [] : [decoded]
      }
      return []
    })
    .join("\n")
  const files = message.parts
    // Text attachments are already expanded into bounded synthetic text by
    // `createUserMessage` (data URLs are decoded; local files go through the
    // canonical Read carrier). Keeping the text/plain media URI in the Core
    // prompt would make provider lowering reject an otherwise valid request,
    // because image/audio/video are the only media kinds accepted by the
    // provider-neutral contract. The mature message still retains the file
    // part for replay; the durable Core prompt carries its text projection.
    .filter(
      (part): part is SessionV1.FilePart =>
        part.type === "file" && inlineTextAttachment(part) === undefined && part.mime !== "text/plain",
    )
    .map((part) => ({
      uri: part.url,
      mime: part.mime,
      ...(part.filename ? { name: part.filename } : {}),
      ...(part.source
        ? {
            source: {
              text: part.source.text.value,
              start: part.source.text.start,
              end: part.source.text.end,
            },
          }
        : {}),
    }))
  const agents = message.parts.flatMap((part) => {
    if (part.type === "agent")
      return [
        {
          name: part.name,
          ...(part.source
            ? { source: { text: part.source.value, start: part.source.start, end: part.source.end } }
            : {}),
        },
      ]
    if (part.type === "subtask") return [{ name: part.agent }]
    return []
  })
  const scheduledTasks = message.parts
    .filter((part): part is SessionV1.SubtaskPart => part.type === "subtask")
    .map((part) => ({
      id: part.id,
      prompt: part.prompt,
      description: part.description,
      agent: part.agent,
      ...(part.model
        ? {
            model: {
              id: part.model.modelID,
              providerID: part.model.providerID,
            },
          }
        : {}),
      ...(part.command ? { command: part.command } : {}),
    }))
  const variant = message.info.model.variant
  return DurablePrompt.make({
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(scheduledTasks.length > 0 ? { scheduledTasks } : {}),
    ...(message.info.system?.trim() ? { system: DurableRequestSystem.create(message.info.system) } : {}),
    route: {
      agent: message.info.agent,
      model: {
        id: message.info.model.modelID,
        providerID: message.info.model.providerID,
        ...(variant ? { variant: ModelV2.VariantID.make(variant) } : {}),
      },
    },
    ...(command ? { command } : {}),
    ...(message.info.format ? { format: message.info.format } : {}),
  })
}

function mcpResourceBase64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

export interface Interface {
  readonly recoverTask: (input: {
    readonly child: DurableRun.ChildSnapshot
    readonly runChild: ChildRunExecutor
    readonly wakeSession: (sessionID: SessionID) => Effect.Effect<void>
  }) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** Persists one mature user message without starting a second execution owner. */
  readonly admit: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  /** Admission plus the caller's canonical SessionExecution; no legacy-loop fallback. */
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  /** Returns the latest assistant-side projection after a coordinated drain. */
  readonly latestAssistant: (sessionID: SessionID) => Effect.Effect<SessionV1.WithParts>
  readonly promoteSteers: (input: { sessionID: SessionID; cutoff: number }) => Effect.Effect<number, Image.Error>
  readonly shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  /** Resolves and persists a command without starting a second execution owner. */
  readonly admitCommand: (input: CommandInput) => Effect.Effect<CommandAdmission, Image.Error>
  /** Command admission plus the caller's canonical SessionExecution; no legacy-loop fallback. */
  readonly command: (input: CommandInput) => Effect.Effect<SessionV1.WithParts, Image.Error>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
  /** Canonical scheduled-task tool for the Formal Core runner; creates no Mature shadow. */
  readonly scheduledTaskTool: (input: {
    readonly runChild: ChildRunExecutor
    readonly wakeSession: (sessionID: SessionID) => Effect.Effect<void>
    readonly sessionID: SessionID
    readonly routes: Readonly<Record<string, ToolCoreBridge.ScheduledTaskNativeRoute>>
    readonly abort?: AbortSignal
    readonly metadata: (input: ToolCoreBridge.ScheduledTaskProgress) => Effect.Effect<void>
  }) => Effect.Effect<CoreAnyTool>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionPrompt") {}

export type ChildRunExecutor = (input: {
  readonly sessionID: DurableSessionSchema.ID
  readonly childAttempt: NonNullable<Parameters<TaskPromptOps["prompt"]>[1]>
}) => Effect.Effect<void>

type DirectShellAuthorization = {
  readonly input: ActionGateway.Input
  readonly authorization: ActionGateway.AuthorizationPlan
  readonly gateway: ActionGateway.Interface
  cancellation: "none" | "cancelled-before-execution" | "handoff-in-progress"
}

type DirectShellExecution = {
  readonly output: string
  readonly outputTruncated: boolean
  readonly outputPath?: string
}

class DirectShellExitError extends Schema.TaggedErrorClass<DirectShellExitError>()("DirectShellExitError", {
  exitCode: Schema.Int,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  outputPath: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Shell command exited with code ${this.exitCode}.`
  }
}

const MAX_DURABLE_DIRECT_SHELL_OUTPUT_CHARS = 200_000
const MAX_LIVE_DIRECT_SHELL_OUTPUT_CHARS = 200_000
const DIRECT_SHELL_STREAM_UPDATE_CHARS = 8_192
const MCP_USER_RESOURCE_TOOL = "mcp_attachment_read"

function tailDirectShellOutput(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value
  // JavaScript slices by UTF-16 code unit while the durable/artifact limits
  // are bytes. Move the start forward until the retained preview really fits
  // in the byte budget, instead of treating character count as a proxy.
  let start = Math.max(0, value.length - maxBytes)
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf-8") > maxBytes) start += 256
  return value.slice(start)
}

function truncatedDirectShellOutput(output: string, outputPath: string) {
  return `...output truncated...\n\nFull output saved to: ${outputPath}\n\n${output}`
}

function durableDirectShellResult(value: DirectShellExecution): DirectShellExecution {
  if (value.output.length <= MAX_DURABLE_DIRECT_SHELL_OUTPUT_CHARS) return value
  return {
    output:
      value.output.slice(0, MAX_DURABLE_DIRECT_SHELL_OUTPUT_CHARS) +
      "\n\n<metadata>Output was truncated only in the durable replay record.</metadata>",
    outputTruncated: true,
    outputPath: value.outputPath,
  }
}

function decodeDurableDirectShellResult(value: unknown): DirectShellExecution {
  if (!value || typeof value !== "object" || typeof (value as { output?: unknown }).output !== "string")
    throw new Error("The direct Shell durable result is malformed.")
  return {
    output: (value as { output: string }).output,
    outputTruncated: (value as { outputTruncated?: unknown }).outputTruncated === true,
    outputPath:
      typeof (value as { outputPath?: unknown }).outputPath === "string"
        ? (value as { outputPath: string }).outputPath
        : undefined,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const coreSessions = yield* SessionStore.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const commands = yield* Command.Service
    const config = yield* Config.Service
    const fsys = yield* FSUtil.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const image = yield* Image.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const revert = yield* SessionRevert.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service
    const locationServiceMap = yield* LocationServiceMap.Service
    const database = yield* Database.Service
    const runtimeInvariants = yield* RuntimeInvariants.Service
    const taskRuntime = yield* TaskRuntime
    const background = yield* BackgroundJob.Service
    RunnerInvariants.registerInvariants(runtimeInvariants)
    const { db } = database
    // Keep the currently active direct-shell authorization long enough for an
    // explicit session cancel to terminalize a pre-execution approval. Entries
    // are replaced per session and removed on normal completion; interrupted
    // entries are deliberately retained until cancel has closed the durable
    // action, preventing an orphaned awaiting_approval record.
    const directShellAuthorizations = new Map<SessionID, DirectShellAuthorization>()
    const ops = Effect.fn("SessionPrompt.ops")(function* (
      runChild?: ChildRunExecutor,
      wakeSession?: (sessionID: SessionID) => Effect.Effect<void>,
    ) {
      return {
        ...(wakeSession
          ? {
              notify: (input: PromptInput) =>
                Effect.gen(function* () {
                  if (input.messageID) {
                    if (input.parts.some((part) => part.type !== "text"))
                      return yield* Effect.die("Task notification must be text")
                    const notification = {
                      sessionID: DurableSessionSchema.ID.make(input.sessionID),
                      delivery: "steer" as const,
                      prompt: DurablePrompt.make({
                        text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
                        ...(input.agent ? { route: { agent: input.agent } } : {}),
                      }),
                    }
                    const stored = yield* SessionInput.admit(database.db, events, {
                      id: SessionMessage.ID.make(input.messageID),
                      ...notification,
                    })
                    if (!SessionInput.equivalent(stored, notification))
                      return yield* Effect.die(new Error("Task notification identity does not match its durable input"))
                  } else yield* admit(input)
                  yield* wakeSession(input.sessionID)
                }).pipe(Effect.catch(Effect.die)),
            }
          : {}),
        cancel: (sessionID: SessionID) => cancel(sessionID),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput, childAttempt: Parameters<TaskPromptOps["prompt"]>[1]) =>
          (childAttempt && runChild ? promptChild(input, childAttempt, runChild) : prompt(input)).pipe(
            Effect.catch(Effect.die),
          ),
      } satisfies TaskPromptOps
    })

    const cancelLocal = Effect.fn("SessionPrompt.cancelLocal")(function* (sessionID: SessionID) {
      yield* Effect.logInfo("cancel", { "session.id": sessionID })
      // The Core coordinator's exclusive interrupt hook waits for Shell setup
      // before invoking this cleanup, so the durable identity is available.
      const direct = directShellAuthorizations.get(sessionID)
      if (direct) {
        // Win the durable pending-action CAS before interrupting the runner.
        // If the grant has already crossed into `authorized`, cancellation is
        // intentionally not recorded as a false pre-execution cancellation:
        // the live worker is stopped and recovery is forced into review.
        direct.cancellation = yield* direct.gateway
          .cancelPendingAction(
            direct.input,
            direct.authorization,
            "The user cancelled the direct Shell command before execution was handed off.",
          )
          .pipe(
            Effect.as("cancelled-before-execution" as const),
            Effect.catchTag("ActionGateway.ActionInProgressError", () =>
              direct.gateway
                .blockAuthorizedHandoff(
                  direct.input,
                  direct.authorization,
                  "The user cancelled at the direct Shell authorization handoff; automatic recovery is blocked pending review.",
                )
                .pipe(
                  Effect.as("handoff-in-progress" as const),
                  Effect.catch(() => Effect.succeed("handoff-in-progress" as const)),
                ),
            ),
            // A concurrent approval CAS may surface as RecoveryRequired or a
            // terminal-state error. It is never evidence of a safe cancel.
            Effect.catch(() => Effect.succeed("handoff-in-progress" as const)),
          )
      }
      yield* background.cancelSession(sessionID)
      yield* status.set(sessionID, { type: "idle" })
      if (direct?.cancellation === "cancelled-before-execution" && directShellAuthorizations.get(sessionID) === direct)
        directShellAuthorizations.delete(sessionID)
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      // Resolve at the call boundary, as for prompt/command, to avoid a layer
      // cycle. Legacy cleanup-only callers may have no session executor.
      const execution = yield* Effect.serviceOption(SessionExecution.Service)
      if (Option.isSome(execution)) yield* execution.value.interrupt(DurableSessionSchema.ID.make(sessionID))
      yield* cancelLocal(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: Types.DeepMutable<PromptInput["parts"]> = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]
          if (!name) return
          if (seen.has(name)) return
          seen.add(name)

          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: SessionV1.WithParts[]
      providerID: ProviderV2.ID
      modelID: ModelV2.ID
    }) {
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: SessionV1.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return
      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstUser = context[idx]
      if (!firstUser || firstUser.info.role !== "user") return
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is SessionV1.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const t = normalizeGeneratedTitle(text)
      if (!t) return
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })))
    })

    const scheduledTaskTool = Effect.fn("SessionPrompt.scheduledTaskTool")(function* (input: {
      readonly runChild: ChildRunExecutor
      readonly wakeSession: (sessionID: SessionID) => Effect.Effect<void>
      readonly sessionID: SessionID
      readonly routes: Readonly<Record<string, ToolCoreBridge.ScheduledTaskNativeRoute>>
      readonly abort?: AbortSignal
      readonly metadata: (input: ToolCoreBridge.ScheduledTaskProgress) => Effect.Effect<void>
    }) {
      const ctx = yield* InstanceState.context
      const promptOps = yield* ops(input.runChild, input.wakeSession)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      return ToolCoreBridge.makeScheduledTaskTool(
        taskRuntime,
        taskRuntime.description,
        { plugin, directory: ctx.directory, worktree: ctx.worktree },
        {
          sandboxProfile: SandboxPolicy.profileFromMetadata(session.metadata),
          promptOps,
          metadata: input.metadata,
          route: (callID) => input.routes[callID],
          modelRoute: (context) =>
            coreSessions.context(context.sessionID).pipe(
              Effect.map((messages) => {
                const parent = messages.find((message) => message.id === context.assistantMessageID)
                return parent?.type === "assistant"
                  ? { modelID: String(parent.model.id), providerID: String(parent.model.providerID) }
                  : undefined
              }),
              Effect.orDie,
            ),
          ...(input.abort ? { abort: input.abort } : {}),
        },
      )
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput, ready?: Latch.Latch) {
      const markReady = ready ? ready.open.pipe(Effect.asVoid) : Effect.void
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          if (session.revert) yield* revert.cleanup(session)

          const agent = yield* agents.get(input.agent)
          if (!agent) {
            const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
            const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
            const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
            yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
            throw error
          }

          const model = input.model ?? agent.model ?? (yield* currentModel(input.sessionID))
          const userMessageID = input.messageID ?? MessageID.ascending()
          const existingMessages = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const existingUser = existingMessages.find((message) => message.info.id === userMessageID)
          const userMsg: SessionV1.User =
            existingUser?.info.role === "user"
              ? existingUser.info
              : {
                  id: userMessageID,
                  sessionID: input.sessionID,
                  time: { created: Date.now() },
                  role: "user",
                  agent: input.agent,
                  model: { providerID: model.providerID, modelID: model.modelID },
                }
          let auditPart: SessionV1.TextPart | undefined
          if (!existingUser) {
            yield* sessions.updateMessage(userMsg)
            auditPart = yield* sessions.updatePart({
              type: "text",
              id: PartID.ascending(),
              messageID: userMsg.id,
              sessionID: input.sessionID,
              text: "The user requested the following Shell command; execution is awaiting human confirmation.",
              synthetic: true,
            } satisfies SessionV1.TextPart)
          } else {
            auditPart = existingUser.parts.find(
              (candidate): candidate is SessionV1.TextPart => candidate.type === "text" && candidate.synthetic === true,
            )
          }

          // The desktop supplies a stable MessageID. Deriving both child IDs
          // from it lets a retry/restart reconstruct the same durable action
          // instead of minting a second command execution.
          const assistantMessageID = MessageID.ascending(`msg_shell_${userMsg.id.slice("msg_".length)}`)
          const toolCallID = `shell:${userMsg.id}`
          const existingAssistant = existingMessages.find((message) => message.info.id === assistantMessageID)
          const msg: SessionV1.Assistant =
            existingAssistant?.info.role === "assistant"
              ? existingAssistant.info
              : {
                  id: assistantMessageID,
                  sessionID: input.sessionID,
                  parentID: userMsg.id,
                  mode: input.agent,
                  agent: input.agent,
                  cost: 0,
                  path: { cwd: ctx.directory, root: ctx.worktree },
                  time: { created: Date.now() },
                  role: "assistant",
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  modelID: model.modelID,
                  providerID: model.providerID,
                }
          if (!existingAssistant) yield* sessions.updateMessage(msg)
          const existingPart = existingAssistant?.parts.find(
            (candidate): candidate is SessionV1.ToolPart =>
              candidate.type === "tool" && candidate.tool === ShellID.ToolID && candidate.callID === toolCallID,
          )
          let part: SessionV1.ToolPart =
            existingPart ??
            (yield* sessions.updatePart({
              type: "tool",
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: input.sessionID,
              tool: ShellID.ToolID,
              callID: toolCallID,
              // A direct command has not started while its L3 request is
              // pending. The visible tool state must not imply otherwise.
              state: { status: "pending", input: { command: input.command }, raw: "Waiting for human approval" },
            } satisfies SessionV1.ToolPart))

          const cfg = yield* config.get()
          const sh = Shell.preferred(cfg.shell)
          const args = Shell.args(sh, input.command, ctx.directory)
          const shellInput = { command: input.command, workdir: ctx.directory }
          const inputDigest = canonicalHash({ command: input.command, cwd: ctx.directory, shell: sh })
          if (!inputDigest) throw new Error("Direct Shell input is not canonically hashable")
          const baseSemantics = forToolCall({ name: "shell", input: shellInput, workspace: ctx.worktree })
          const semantics = AgentRuntime.EffectSemantics.make({
            ...baseSemantics,
            // The direct user command is approved exactly, but its effects
            // cannot be honestly reduced to a file/domain allowlist before a
            // complete parser and sandbox exist. Preserve that opacity in the
            // durable record instead of advertising a false precise scope.
            filesystemScope: [`opaque user Shell command (cwd: ${ctx.directory})`],
            networkScope: ["opaque user Shell network effects"],
            secretScope: ["minimal allowlisted child environment; no ambient credentials"],
            externalServices: ["opaque user Shell external services"],
            // A user-entered command may write files or call an external
            // service. Never let generic retry recovery replay it.
            idempotency: "non_idempotent",
            retryability: "never",
            expectedArtifacts: [],
            successCriteria: ["the command result and actual captured output are recorded"],
          })
          const authorization = {
            ...SessionTools.permissionPreflight({
              name: "shell",
              input: shellInput,
              workspace: ctx.worktree,
              locationDirectory: session.directory,
              riskTier: "L3",
            }),
            metadata: {
              source: "action-gateway-preflight",
              tool: "shell",
              riskTier: "L3",
              scope: "opaque-user-shell",
              cwd: ctx.directory,
              shell: sh,
            },
          } satisfies ActionGateway.AuthorizationPlan
          const durableSessionID = DurableSessionSchema.ID.make(input.sessionID)
          const durableAssistantMessageID = SessionMessage.ID.make(msg.id)
          const actionID = ActionGateway.stableActionID({
            sessionID: durableSessionID,
            assistantMessageID: durableAssistantMessageID,
            toolCallID,
          })
          const locationContext = yield* locationServiceMap
            .contextEffect(
              Location.Ref.make({
                directory: AbsolutePath.make(session.directory),
                ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, scope))
          const gateway = Context.get(locationContext, ActionGateway.Service)
          const gatewayInput: ActionGateway.Input = {
            actionID,
            sessionID: durableSessionID,
            agent: AgentV2.ID.make(input.agent),
            assistantMessageID: durableAssistantMessageID,
            toolCallID,
            name: "shell",
            resources: [input.command, `cwd:${ctx.directory}`, `shell:${sh}`, "opaque-user-shell-effects"],
            semantics,
            reasonSummary:
              "Execute the exact Shell command entered by the user; its full effects require fresh human confirmation.",
            initiator: "user",
            traceID: actionID,
            inputDigest,
          }
          const active: DirectShellAuthorization = { input: gatewayInput, authorization, gateway, cancellation: "none" }
          directShellAuthorizations.set(input.sessionID, active)
          // A cancel waits for this point, so it always has the frozen durable
          // identity and plan needed to close a pending approval safely.
          yield* markReady

          let output = ""
          let outputTruncated = false
          let outputPath: string | undefined
          let executionStarted = false
          let unpublishedOutputChars = 0
          let publishedOutput = false
          let publishedOutputArtifact = false
          const publishShellHistory = Effect.fn("SessionPrompt.publishShellHistory")(function* (
            text: string,
            completed: number,
          ) {
            const sessionID = DurableSessionSchema.ID.make(input.sessionID)
            const prior = (yield* coreSessions.context(sessionID).pipe(Effect.orDie)).find(
              (item) => item.id === durableAssistantMessageID,
            )
            if (prior && (prior.type !== "shell" || prior.callID !== toolCallID || prior.command !== input.command))
              return yield* Effect.die(new Error("Direct Shell history identity mismatch"))
            if (!prior)
              yield* events.publish(CoreSessionEvent.Shell.Started, {
                sessionID,
                timestamp: DateTime.makeUnsafe(msg.time.created),
                messageID: durableAssistantMessageID,
                callID: toolCallID,
                command: input.command,
              })
            if (prior?.type === "shell" && prior.time.completed !== undefined) {
              if (prior.output !== text) return yield* Effect.die(new Error("Direct Shell history output mismatch"))
            } else
              yield* events.publish(CoreSessionEvent.Shell.Ended, {
                sessionID,
                timestamp: DateTime.makeUnsafe(completed),
                callID: toolCallID,
                output: text,
              })
          })
          const complete = Effect.uninterruptible(
            Effect.gen(function* () {
              const completed = Date.now()
              if (!msg.time.completed) {
                msg.time.completed = completed
                yield* sessions.updateMessage(msg)
              }
              if (part.state.status === "running" || part.state.status === "pending") {
                const started = part.state.status === "running" ? part.state.time.start : completed
                part = yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "completed",
                    time: { start: started, end: completed },
                    input: part.state.input,
                    title: "",
                    metadata: {
                      output,
                      ...(outputTruncated ? { truncated: true } : {}),
                      ...(outputPath ? { outputPath } : {}),
                    },
                    output,
                  },
                } satisfies SessionV1.ToolPart)
              }
              // Publish the settled receipt through the existing Core Shell
              // history, so subsequent Formal turns see the same output.
              // Stable identity lets a durable result replay finish a partial
              // projection without creating another message or command.
              yield* publishShellHistory(output, completed)
            }),
          )
          const fail = (message: string, exitCode?: number) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const completed = Date.now()
                if (!msg.time.completed) {
                  msg.time.completed = completed
                  yield* sessions.updateMessage(msg)
                }
                const started = part.state.status === "pending" ? completed : part.state.time.start
                part = yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    input: part.state.input,
                    error: message,
                    metadata: {
                      authorization: "blocked",
                      ...(exitCode === undefined ? {} : { exitCode }),
                      ...(output ? { output } : {}),
                      ...(outputTruncated ? { truncated: true } : {}),
                      ...(outputPath ? { outputPath } : {}),
                    },
                    time: { start: started, end: completed },
                  },
                } satisfies SessionV1.ToolPart)
                yield* publishShellHistory(
                  `Shell command failed or was denied: ${message}${output ? `\n\nOutput:\n${output}` : ""}`,
                  completed,
                )
              }),
            )
          const cancelled = (beforeExecution: boolean) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const completed = Date.now()
                if (!msg.time.completed) {
                  msg.time.completed = completed
                  yield* sessions.updateMessage(msg)
                }
                const started = part.state.status === "pending" ? completed : part.state.time.start
                part = yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    input: part.state.input,
                    error: beforeExecution
                      ? "The Shell command was cancelled before it started."
                      : "The Shell command was interrupted after execution started; its durable action is blocked for review.",
                    metadata: {
                      cancelled: true,
                      executionStarted: !beforeExecution,
                      ...(output ? { output } : {}),
                      ...(outputTruncated ? { truncated: true } : {}),
                      ...(outputPath ? { outputPath } : {}),
                    },
                    time: { start: started, end: completed },
                  },
                } satisfies SessionV1.ToolPart)
                yield* publishShellHistory(
                  `${part.state.status === "error" ? part.state.error : "Shell command interrupted"}${output ? `\n\nPartial output:\n${outputTruncated && outputPath ? truncatedDirectShellOutput(output, outputPath) : output}` : ""}`,
                  completed,
                )
              }),
            )
          const handoffUncertain = () =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const completed = Date.now()
                if (!msg.time.completed) {
                  msg.time.completed = completed
                  yield* sessions.updateMessage(msg)
                }
                const started = part.state.status === "pending" ? completed : part.state.time.start
                part = yield* sessions.updatePart({
                  ...part,
                  state: {
                    status: "error",
                    input: part.state.input,
                    error:
                      "Approval reached the execution handoff. Arforge stopped the live worker, but cannot prove whether the command started. The durable action is preserved for recovery and review and will not be automatically replayed.",
                    metadata: {
                      executionHandoffUncertain: true,
                      executionStarted: false,
                      authorization: "handoff-uncertain",
                    },
                    time: { start: started, end: completed },
                  },
                } satisfies SessionV1.ToolPart)
                yield* publishShellHistory(
                  part.state.status === "error"
                    ? part.state.error
                    : "Shell execution handoff is uncertain; do not automatically replay it.",
                  completed,
                )
              }),
            )

          const execution = yield* restore(
            gateway.execute(gatewayInput, {
              authorization,
              execute: () =>
                Effect.gen(function* () {
                  // This is the execution handoff. Process creation remains
                  // below the gateway's fresh L3 authorization. Direct Shell
                  // deliberately does not invoke the mutable `shell.env`
                  // plugin hook: no plugin environment override is declared
                  // or approved by this action's exact permission contract.
                  const started = Date.now()
                  executionStarted = true
                  if (auditPart?.synthetic) {
                    auditPart = yield* sessions.updatePart({
                      ...auditPart,
                      text: "The requested Shell command was approved and started.",
                    } satisfies SessionV1.TextPart)
                  }
                  part = yield* sessions.updatePart({
                    ...part,
                    state: {
                      status: "running",
                      time: { start: started },
                      input: { command: input.command },
                      metadata: { authorization: "approved", cwd: ctx.directory, shell: sh },
                    },
                  } satisfies SessionV1.ToolPart)
                  const limits = yield* truncate.limits()
                  const liveOutputBytes = Math.min(MAX_LIVE_DIRECT_SHELL_OUTPUT_CHARS, limits.maxBytes * 2)
                  let sink: ReturnType<typeof createWriteStream> | undefined
                  const closeSink = Effect.fnUntraced(function* () {
                    const stream = sink
                    if (!stream) return
                    sink = undefined
                    if (stream.destroyed || stream.closed) return
                    yield* Effect.promise(
                      () =>
                        new Promise<void>((resolve) => {
                          let settled = false
                          const done = () => {
                            if (settled) return
                            settled = true
                            stream.off("close", done)
                            stream.off("error", done)
                            stream.off("finish", done)
                            resolve()
                          }
                          stream.once("close", done)
                          stream.once("error", done)
                          stream.once("finish", done)
                          stream.end(done)
                        }),
                    ).pipe(Effect.catch(() => Effect.void))
                  })
                  const writeChunk = Effect.fnUntraced(function* (chunk: string) {
                    const stream = sink
                    if (!stream) return
                    // A writable stream can buffer arbitrarily if its
                    // backpressure signal is ignored. Pause consumption until
                    // `drain` (or fail) so the artifact path, not Node's
                    // heap, absorbs a high-output command.
                    yield* Effect.callback<void>((resume) => {
                      let settled = false
                      const cleanup = () => {
                        stream.off("drain", drained)
                        stream.off("error", failed)
                      }
                      const drained = () => {
                        if (settled) return
                        settled = true
                        cleanup()
                        resume(Effect.void)
                      }
                      const failed = (cause: Error) => {
                        if (settled) return
                        settled = true
                        cleanup()
                        resume(Effect.die(cause))
                      }
                      stream.once("drain", drained)
                      stream.once("error", failed)
                      if (stream.write(chunk)) drained()
                      return Effect.sync(cleanup)
                    })
                  })
                  const cmd = ChildProcess.make(sh, args, {
                    cwd: ctx.directory,
                    extendEnv: false,
                    env: {
                      ...allowlistedChildEnvironment(process.env),
                      TERM: "dumb",
                    },
                    stdin: "ignore",
                    forceKillAfter: "3 seconds",
                  })
                  const handle = yield* spawner.spawn(cmd)
                  yield* Effect.addFinalizer(closeSink)
                  yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                    Effect.gen(function* () {
                      if (outputPath) {
                        yield* writeChunk(chunk)
                        output = tailDirectShellOutput(output + chunk, liveOutputBytes)
                        // Count incoming output, not the current tail length:
                        // once the preview reaches its cap its length stops
                        // growing, but the UI still needs periodic fresh tail
                        // updates and the durable event rate must remain capped.
                        unpublishedOutputChars = Math.min(
                          Number.MAX_SAFE_INTEGER,
                          unpublishedOutputChars + chunk.length,
                        )
                      } else {
                        const candidate = output + chunk
                        if (Buffer.byteLength(candidate, "utf-8") > limits.maxBytes) {
                          outputPath = yield* truncate.write(candidate)
                          outputTruncated = true
                          sink = createWriteStream(outputPath, { flags: "a" })
                          output = tailDirectShellOutput(candidate, liveOutputBytes)
                          unpublishedOutputChars += output.length
                        } else {
                          output = candidate
                          unpublishedOutputChars += chunk.length
                        }
                      }
                      // Persist the first fragment for responsive progress,
                      // then batch subsequent updates. Per-chunk message writes
                      // would turn a high-output command into an unbounded DB
                      // event stream even though the visible buffer is capped.
                      if (
                        part.state.status === "running" &&
                        (!publishedOutput ||
                          unpublishedOutputChars >= DIRECT_SHELL_STREAM_UPDATE_CHARS ||
                          (outputPath !== undefined && !publishedOutputArtifact))
                      ) {
                        part.state.metadata = {
                          ...part.state.metadata,
                          output,
                          ...(outputTruncated ? { truncated: true } : {}),
                          ...(outputPath ? { outputPath } : {}),
                        }
                        part = yield* sessions.updatePart(part)
                        publishedOutput = true
                        if (outputPath) publishedOutputArtifact = true
                        unpublishedOutputChars = 0
                      }
                    }),
                  )
                  const exitCode = yield* handle.exitCode
                  const renderedOutput =
                    outputTruncated && outputPath ? truncatedDirectShellOutput(output, outputPath) : output
                  if (exitCode !== 0)
                    return yield* new DirectShellExitError({
                      exitCode,
                      output: renderedOutput,
                      outputTruncated,
                      ...(outputPath ? { outputPath } : {}),
                    })
                  return { output: renderedOutput, outputTruncated, outputPath } satisfies DirectShellExecution
                }).pipe(Effect.scoped, Effect.orDie),
              successSummary: () => "The user-approved Shell command completed and its output was captured.",
              durableResult: {
                encode: durableDirectShellResult,
                decode: decodeDurableDirectShellResult,
              },
            }),
          ).pipe(Effect.exit)

          if (Exit.isSuccess(execution)) {
            output = execution.value.output
            outputTruncated = execution.value.outputTruncated
            outputPath = execution.value.outputPath
            yield* complete
            if (directShellAuthorizations.get(input.sessionID) === active)
              directShellAuthorizations.delete(input.sessionID)
            return { info: msg, parts: [part] }
          }

          if (Cause.hasInterrupts(execution.cause) && !Cause.hasDies(execution.cause)) {
            if (active.cancellation === "handoff-in-progress" && !executionStarted) yield* handoffUncertain()
            else yield* cancelled(!executionStarted)
            // The gateway records an interrupted observation and blocks the
            // action; SessionPrompt.cancel closes a pending approval instead.
            return { info: msg, parts: [part] }
          }

          if (active.cancellation === "cancelled-before-execution") {
            yield* cancelled(!executionStarted)
            return { info: msg, parts: [part] }
          }
          const failure = Cause.squash(execution.cause)
          if (failure instanceof DirectShellExitError) {
            output = failure.output
            outputTruncated = failure.outputTruncated
            outputPath = failure.outputPath
          }
          const message =
            failure instanceof Error && failure.message.length > 0
              ? failure.message
              : "Permission denied or the Shell command could not start."
          yield* fail(message, failure instanceof DirectShellExitError ? failure.exitCode : undefined)
          return { info: msg, parts: [part] }
        }),
      ).pipe(Effect.ensuring(markReady))
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.die(err)
    })

    const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const current = yield* db
        .select({ model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (current?.model) {
        return {
          providerID: ProviderV2.ID.make(current.model.providerID),
          modelID: ModelV2.ID.make(current.model.id),
          ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
        }
      }
      const match = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      const defaultModel = yield* provider.defaultModel().pipe(Effect.orDie)
      return defaultModel
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (
      input: PromptInput,
      options: { readonly model?: PromptInput["model"]; readonly updateSessionModel?: boolean } = {},
    ) {
      const agentName = input.agent
      const ag = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? options.model ?? (yield* currentModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider
              .getModel(model.providerID, model.modelID)
              .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: SessionV1.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        format: input.format,
      }

      const current = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (
        options.updateSessionModel !== false &&
        (current.agent !== info.agent ||
          current.model?.providerID !== info.model.providerID ||
          current.model?.id !== info.model.modelID ||
          (current.model?.variant === "default" ? undefined : current.model?.variant) !== info.model.variant)
      ) {
        yield* sessions.setAgentModel({
          sessionID: input.sessionID,
          agent: info.agent,
          model: {
            id: info.model.modelID,
            providerID: info.model.providerID,
            variant: info.model.variant ?? "default",
          },
          time: info.time.created,
        })
      }

      // User-attached local files are resolved through one Location snapshot
      // for this durable User message. Each attachment then receives its own
      // fixed-name opaque carrier and stable call identity inside that same
      // canonical registry/gateway scope.
      const attachmentRuntime = yield* Effect.cached(
        Effect.gen(function* () {
          const context = yield* locationServiceMap
            .contextEffect(
              Location.Ref.make({
                directory: AbsolutePath.make(current.directory),
                ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}),
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, scope))
          return {
            registry: Context.get(context, CoreToolRegistry.Service),
            mutation: Context.get(context, LocationMutation.Service),
            instance: yield* InstanceState.context,
          }
        }),
      )

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends SessionV1.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<SessionV1.Part>): SessionV1.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (part: PromptInput["parts"][number], index: number) => Effect.Effect<Draft<SessionV1.Part>[]> =
        Effect.fn("SessionPrompt.resolveUserPart")(function* (part, index) {
          if (part.type === "file") {
            if (part.source?.type === "resource") {
              const { clientName, uri } = part.source
              yield* Effect.logInfo("mcp resource", { clientName, uri, mime: part.mime })
              const pieces: Draft<SessionV1.Part>[] = [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Reading MCP resource: ${part.filename} (${uri})`,
                },
              ]
              // User-attached MCP resources are admissions, not a special
              // transport exception. Resolve the current generation-scoped
              // capability and execute the existing mature projection through
              // the same Core ToolRegistry/ActionGateway used by model calls.
              // A missing capability registry fails closed instead of falling
              // back to a direct MCP client read.
              const readThroughCore = Effect.gen(function* () {
                if (!mcp.capabilities)
                  return yield* Effect.fail(new Error("MCP capability registry is unavailable for resource admission"))
                const capability = (yield* mcp.capabilities()).find(
                  (entry) =>
                    entry.kind === "resource" &&
                    entry.server === clientName &&
                    entry.reference !== undefined &&
                    entry.reference === uri,
                )
                if (!capability || capability.reference === undefined)
                  return yield* Effect.fail(
                    new Error(`MCP resource is not in the current capability catalog: ${clientName}/${uri}`),
                  )
                const mature = McpResourceProjection.makeResource({
                  key: MCP_USER_RESOURCE_TOOL,
                  capabilityID: capability.id,
                  server: capability.server,
                  generation: capability.generation,
                  entry: {
                    name: capability.name,
                    uri: capability.reference,
                    client: capability.server,
                    generation: capability.generation,
                  },
                  mcp,
                  plugin,
                  agents,
                  truncate,
                })
                const attachment = yield* attachmentRuntime
                const coreTool = ToolCoreBridge.adaptExternalTool(mature, {
                  plugin,
                  directory: attachment.instance.directory,
                  worktree: attachment.instance.worktree,
                })
                const materialized = yield* attachment.registry.materialize(
                  [],
                  DurableSessionSchema.ID.make(input.sessionID),
                  {
                    externalTools: { [MCP_USER_RESOURCE_TOOL]: coreTool },
                  },
                )
                const settlement = yield* materialized.settle({
                  sessionID: DurableSessionSchema.ID.make(input.sessionID),
                  agent: AgentV2.ID.make(info.agent),
                  assistantMessageID: SessionMessage.ID.make(info.id),
                  call: {
                    type: "tool-call",
                    id: `user-mcp-resource:${info.id}:${part.id ?? index}`,
                    name: MCP_USER_RESOURCE_TOOL,
                    input: {},
                  },
                })
                return ToolCoreBridge.settlementToMatureResult(settlement)
              })
              const exit = yield* readThroughCore.pipe(Effect.exit)
              if (Exit.isSuccess(exit)) {
                const result = exit.value
                if (result.output) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                }
                for (const attachment of result.attachments ?? []) {
                  const mime = attachment.mime || part.mime
                  const encoded = attachment.url.split(",", 2)[1] ?? ""
                  const size = mcpResourceBase64Size(encoded)
                  if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime) || size > MAX_MCP_RESOURCE_BLOB_BYTES)
                    continue
                  const filename = attachment.filename ?? part.filename ?? uri
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary MCP resource attached: ${filename} (${mime})]`,
                  })
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    mime,
                    filename,
                    url: attachment.url,
                  })
                }
              } else {
                const error = Cause.squash(exit.cause)
                yield* Effect.logError("failed to read MCP resource", { error, clientName, uri })
                const message = error instanceof Error ? error.message : String(error)
                pieces.push({
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Failed to read MCP resource ${part.filename}: ${message}`,
                })
              }
              return pieces
            }
            const url = new URL(part.url)
            switch (url.protocol) {
              case "data:":
                if (part.mime === "text/plain") {
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: decodeDataUrl(part.url),
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }
                break
              case "file:": {
                yield* Effect.logInfo("file", { mime: part.mime })
                const filepath = fileURLToPath(part.url)
                const mime = (yield* fsys.isDir(filepath)) ? "application/x-directory" : part.mime

                const { read } = yield* registry.named()
                const execRead = (args: Parameters<typeof read.execute>[0], model?: Provider.Model) =>
                  Effect.gen(function* () {
                    const attachment = yield* attachmentRuntime
                    const target = yield* attachment.mutation.resolve({ path: args.filePath, kind: "directory" })
                    const carrier = ToolCoreBridge.makeUserAttachmentReadCarrier(
                      read,
                      {
                        plugin,
                        directory: attachment.instance.directory,
                        worktree: attachment.instance.worktree,
                      },
                      {
                        filePath: args.filePath,
                        authorizationResource: target.resource,
                        ...(model ? { model } : {}),
                      },
                    )
                    const materialized = yield* attachment.registry.materialize(
                      [],
                      DurableSessionSchema.ID.make(input.sessionID),
                      { includeRegistered: false, userAttachmentRead: carrier },
                    )
                    const settlement = yield* materialized.settle({
                      sessionID: DurableSessionSchema.ID.make(input.sessionID),
                      agent: AgentV2.ID.make(info.agent),
                      assistantMessageID: SessionMessage.ID.make(info.id),
                      call: {
                        type: "tool-call",
                        id: `user-attachment:${info.id}:${part.id ?? index}`,
                        name: TurnToolCarrier.userAttachmentReadName,
                        input: args,
                      },
                    })
                    return ToolCoreBridge.settlementToMatureResult(settlement)
                  })

                if (mime === "text/plain") {
                  let offset: number | undefined
                  let limit: number | undefined
                  const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                  if (range.start != null) {
                    const filePathURI = part.url.split("?")[0]
                    let start = parseInt(range.start)
                    let end = range.end ? parseInt(range.end) : undefined
                    if (start === end) {
                      const symbols = yield* lsp
                        .documentSymbol(filePathURI)
                        .pipe(Effect.catch(() => Effect.succeed([])))
                      for (const symbol of symbols) {
                        let r: LSP.Range | undefined
                        if ("range" in symbol) r = symbol.range
                        else if ("location" in symbol) r = symbol.location.range
                        if (r?.start?.line && r?.start?.line === start) {
                          start = r.start.line
                          end = r?.end?.line ?? start
                          break
                        }
                      }
                    }
                    offset = Math.max(start, 1)
                    if (end) limit = end - (offset - 1)
                  }
                  const args = { filePath: filepath, offset, limit }
                  const pieces: Draft<SessionV1.Part>[] = [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                  ]
                  const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                    Effect.flatMap((mdl) => execRead(args, mdl)),
                    Effect.exit,
                  )
                  if (Exit.isSuccess(exit)) {
                    const result = exit.value
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((a) => ({
                          ...a,
                          synthetic: true,
                          filename: a.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({ ...part, mime, messageID: info.id, sessionID: input.sessionID })
                    }
                  } else {
                    const error = Cause.squash(exit.cause)
                    yield* Effect.logError("failed to read file", { error, filepath })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* events.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  }
                  return pieces
                }

                if (mime === "application/x-directory") {
                  const args = { filePath: filepath }
                  const exit = yield* execRead(args).pipe(Effect.exit)
                  if (Exit.isFailure(exit)) {
                    const error = Cause.squash(exit.cause)
                    yield* Effect.logError("failed to read directory", { error, filepath })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* events.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    return [
                      {
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                      },
                    ]
                  }
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: exit.value.output,
                    },
                    { ...part, mime, messageID: info.id, sessionID: input.sessionID },
                  ]
                }

                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  },
                  {
                    id: part.id,
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    url:
                      `data:${mime};base64,` +
                      Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                    mime,
                    filename: part.filename!,
                    source: part.source,
                  },
                ]
              }
            }
          }

          if (part.type === "agent") {
            const perm = Permission.evaluate("task", part.name, ag.permission)
            const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
            return [
              { ...part, messageID: info.id, sessionID: input.sessionID },
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text:
                  " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                  part.name +
                  hint,
              },
            ]
          }

          return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
        })

      const resolvedParts = yield* Effect.forEach(
        input.parts.map((part, index) => ({ part, index })),
        ({ part, index }) => resolvePart(part, index),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((x) => x.flat().map(assign)))

      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        },
        { message: info, parts: resolvedParts },
      )

      const parts = yield* Effect.forEach(resolvedParts, (part) =>
        part.type === "file" && part.mime.startsWith("image/")
          ? image.normalize(part).pipe(
              Effect.catchIf(
                (error) => error instanceof Image.ResizerUnavailableError,
                () => Effect.succeed(part),
              ),
            )
          : Effect.succeed(part),
      )

      const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
      if (Exit.isFailure(parsed)) {
        yield* Effect.logError("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          cause: Cause.pretty(parsed.cause),
        })
      }
      for (const [index, part] of parts.entries()) {
        const p = decodeMessagePart(part, { errors: "all", propertyOrder: "original" })
        if (Exit.isSuccess(p)) continue
        yield* Effect.logError("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          cause: Cause.pretty(p.cause),
          part,
        })
      }

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const admitWithCommand = Effect.fn("SessionPrompt.admitWithCommand")(function* (
      input: PromptInput,
      command?: DurablePrompt["command"],
    ) {
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      yield* revert.cleanup(session)
      const messageID = input.messageID ?? MessageID.ascending()
      const message = yield* createUserMessage({ ...input, messageID })
      yield* sessions.touch(input.sessionID)

      const permissions: PermissionV1.Rule[] = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      if (message.info.role !== "user") return message
      const prompt = durablePromptFromMatureMessage(message, command)
      const admitted = yield* SessionInput.admit(database.db, events, {
        id: SessionMessage.ID.make(messageID),
        sessionID: DurableSessionSchema.ID.make(input.sessionID),
        prompt,
        delivery: "steer",
      })
      if (
        !SessionInput.equivalent(admitted, {
          sessionID: DurableSessionSchema.ID.make(input.sessionID),
          prompt,
          delivery: "steer",
        })
      )
        return yield* Effect.die(new Error(`Durable prompt admission identity mismatch: ${messageID}`))

      return message
    })

    const admit: Interface["admit"] = Effect.fn("SessionPrompt.admit")((input) => admitWithCommand(input))

    const promptChild = Effect.fn("SessionPrompt.promptChild")(function* (
      input: PromptInput,
      childAttempt: NonNullable<Parameters<TaskPromptOps["prompt"]>[1]>,
      runChild: ChildRunExecutor,
    ) {
      if (input.runID !== childAttempt.childRunID)
        return yield* Effect.die(new Error("Child prompt run identity does not match its execution context"))
      const info = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const admitted = yield* admitChildPrompt(input, childAttempt, admit).pipe(
            Effect.provideService(Database.Service, database),
          )
          if (input.noReply) return admitted
          yield* status.set(input.sessionID, { type: "busy" })
          yield* runChild({ sessionID: DurableSessionSchema.ID.make(input.sessionID), childAttempt }).pipe(
            Effect.onExit(() => status.set(input.sessionID, { type: "idle" }).pipe(Effect.ignore)),
          )
          const messages = yield* coreSessions.context(DurableSessionSchema.ID.make(input.sessionID)).pipe(Effect.orDie)
          const assistant = messages.findLast(
            (message): message is SessionMessage.Assistant => message.type === "assistant",
          )
          if (!assistant) return yield* Effect.die(new Error("Core child completed without an assistant result"))
          return CoreMessageCompat.projectAssistant({
            message: assistant,
            sessionID: input.sessionID,
            parentID: admitted.info.id,
            path: { cwd: info.directory, root: info.directory },
          })
        }),
      ).pipe(
        Effect.provide(
          locationServiceMap.get({
            directory: AbsolutePath.make(info.directory),
            ...(info.workspaceID ? { workspaceID: info.workspaceID } : {}),
          }),
        ),
      )
    })

    // Resolve at call time: the execution adapter itself depends on admission.
    // A static dependency here would introduce an execution/admission layer cycle.
    const requireExecution = Effect.gen(function* () {
      const owner = yield* Effect.serviceOption(SessionExecution.Service)
      if (Option.isNone(owner))
        return yield* Effect.die(new Error("SessionPrompt requires the canonical SessionExecution owner"))
      return owner.value
    })
    const drainAdmitted = Effect.fn("SessionPrompt.drainAdmitted")(function* (
      sessionID: SessionID,
      owner: SessionExecution.Interface,
      admittedID: MessageID,
    ) {
      yield* owner.wakeAndWait(DurableSessionSchema.ID.make(sessionID)).pipe(Effect.orDie)
      const context = yield* coreSessions.context(DurableSessionSchema.ID.make(sessionID)).pipe(Effect.orDie)
      const parentIndex = context.findLastIndex((message) => message.type === "user")
      let parent = context[parentIndex]
      // Compaction changes the provider-visible window, not the admitted
      // message's identity. Recover that exact parent from the same TS store.
      if (!parent && context.some((message) => message.type === "compaction")) {
        const admitted = yield* coreSessions.message(SessionMessage.ID.make(admittedID))
        if (admitted?.sessionID === sessionID && admitted.message.type === "user") parent = admitted.message
      }
      const assistant = context
        .slice(parentIndex + 1)
        .findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
      if (!assistant || parent?.type !== "user")
        return yield* Effect.die(new Error("Canonical execution completed without an assistant result"))
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      return CoreMessageCompat.projectAssistant({
        message: assistant,
        sessionID,
        parentID: MessageID.make(parent.id),
        path: { cwd: session.directory, root: session.directory },
      })
    })
    const prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      if (input.noReply === true) return yield* admit(input)
      if (input.runID) return yield* Effect.die(new Error("Child execution must use its validated child attempt"))
      const owner = yield* requireExecution
      const admitted = yield* admit(input)
      return yield* drainAdmitted(input.sessionID, owner, admitted.info.id)
    })

    const prepareCommand = Effect.fn("SessionPrompt.prepareCommand")(function* (input: CommandInput) {
      yield* Effect.logInfo("command", {
        "session.id": input.sessionID,
        command: input.command,
        agent: input.agent,
      })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex]
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const cfg = yield* config.get()
        const sh = Shell.preferred(cfg.shell)
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++])
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* currentModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = agentName ? yield* agents.get(agentName) : yield* agents.defaultInfo()
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const inputFiles = new Set(
        input.parts?.filter((part) => new URL(part.url).protocol === "file:").map((part) => fileURLToPath(part.url)),
      )
      const uniqueTemplateParts = templateParts.filter(
        (part) => part.type !== "file" || !inputFiles.has(fileURLToPath(part.url)),
      )
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...uniqueTemplateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultInfo()).name) : agent.name
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* currentModel(input.sessionID)
        : taskModel

      yield* plugin.trigger(
        "command.execute.before",
        { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
        { parts },
      )

      return {
        prompt: {
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
        } satisfies PromptInput,
        command: input.command,
        arguments: input.arguments,
      }
    })

    const durableParts = (input: DurablePrompt): PromptInput["parts"] => {
      if (input.scheduledTasks?.length)
        return input.scheduledTasks.map(
          (task): SessionV1.SubtaskPartInput => ({
            id: PartID.make(task.id),
            type: "subtask",
            prompt: task.prompt,
            description: task.description,
            agent: task.agent,
            ...(task.model
              ? {
                  model: {
                    providerID: task.model.providerID,
                    modelID: ModelV2.ID.make(task.model.id),
                  },
                }
              : {}),
            ...(task.command ? { command: task.command } : {}),
          }),
        )
      return [
        { type: "text", text: input.text },
        ...(input.files ?? []).map(
          (file): SessionV1.FilePartInput => ({
            type: "file",
            mime: file.mime,
            url: file.uri,
            filename: file.name,
            source: file.source
              ? {
                  type: "file",
                  path: file.uri,
                  text: { value: file.source.text, start: file.source.start, end: file.source.end },
                }
              : undefined,
          }),
        ),
        ...(input.agents ?? []).map(
          (agent): SessionV1.AgentPartInput => ({
            type: "agent",
            name: agent.name,
            source: agent.source
              ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
              : undefined,
          }),
        ),
      ]
    }

    const materializeDurable = Effect.fn("SessionPrompt.materializeDurable")(function* (
      admitted: SessionInput.Admitted,
    ) {
      const sessionID = SessionID.make(admitted.sessionID)
      const messageID = MessageID.make(admitted.id)
      const existing = yield* sessions
        .findMessage(sessionID, (message) => message.info.id === messageID)
        .pipe(Effect.orDie)
      if (Option.isSome(existing)) {
        return false
      }

      const route = admitted.prompt.route
      const sessionInfo = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const selectedModel = route?.model
        ? {
            providerID: route.model.providerID,
            modelID: ModelV2.ID.make(route.model.id),
            ...(route.model.variant ? { variant: route.model.variant } : {}),
          }
        : sessionInfo.model
          ? {
              providerID: ProviderV2.ID.make(sessionInfo.model.providerID),
              modelID: ModelV2.ID.make(sessionInfo.model.id),
              ...(sessionInfo.model.variant && sessionInfo.model.variant !== "default"
                ? { variant: sessionInfo.model.variant }
                : {}),
            }
          : UNSELECTED_MATERIALIZATION_MODEL
      const updateSessionModel = route?.model !== undefined || sessionInfo.model !== undefined
      if (admitted.prompt.command && admitted.prompt.scheduledTasks?.length) {
        const message = yield* createUserMessage(
          {
            sessionID,
            messageID,
            agent: route?.agent,
            model: selectedModel,
            variant: route?.model?.variant,
            system: admitted.prompt.system?.text,
            format: admitted.prompt.format,
            parts: durableParts(admitted.prompt),
          },
          { model: selectedModel, updateSessionModel },
        )
        yield* sessions.touch(sessionID)
        yield* events.publish(Command.Event.Executed, {
          name: admitted.prompt.command.name,
          sessionID,
          arguments: admitted.prompt.command.arguments,
          messageID: message.info.id,
        })
        return true
      }
      if (admitted.prompt.command) {
        const prepared = yield* prepareCommand({
          sessionID,
          messageID,
          command: admitted.prompt.command.name,
          arguments: admitted.prompt.command.arguments,
          agent: route?.agent,
          model: `${selectedModel.providerID}/${selectedModel.modelID}`,
          variant: route?.model?.variant,
          parts: durableParts(admitted.prompt).filter((part): part is SessionV1.FilePartInput => part.type === "file"),
        })
        const message = yield* createUserMessage(
          {
            ...prepared.prompt,
            system: admitted.prompt.system?.text,
            format: admitted.prompt.format,
          },
          { updateSessionModel },
        )
        yield* sessions.touch(sessionID)
        yield* events.publish(Command.Event.Executed, {
          name: prepared.command,
          sessionID,
          arguments: prepared.arguments,
          messageID: message.info.id,
        })
        return true
      }

      yield* createUserMessage(
        {
          sessionID,
          messageID,
          agent: route?.agent,
          model: selectedModel,
          variant: route?.model?.variant,
          system: admitted.prompt.system?.text,
          format: admitted.prompt.format,
          parts: durableParts(admitted.prompt),
        },
        { model: selectedModel, updateSessionModel },
      )
      yield* sessions.touch(sessionID)
      return true
    })

    const promoteSteers: Interface["promoteSteers"] = Effect.fn("SessionPrompt.promoteSteers")(function* (input) {
      const pending = yield* SessionInput.listPending(
        database.db,
        DurableSessionSchema.ID.make(input.sessionID),
        "steer",
        input.cutoff,
      )
      for (const admitted of pending) yield* materializeDurable(admitted)
      yield* SessionInput.promoteSteers(
        database.db,
        events,
        DurableSessionSchema.ID.make(input.sessionID),
        input.cutoff,
      )
      return pending.length
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user").pipe(Effect.orDie)
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 }).pipe(Effect.orDie)
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const shell: (input: ShellInput) => Effect.Effect<SessionV1.WithParts, Session.BusyError> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const ready = yield* Latch.make()
      const owner = yield* requireExecution
      let result: SessionV1.WithParts | undefined
      const accepted = yield* owner
        .exclusive(
          DurableSessionSchema.ID.make(input.sessionID),
          Effect.gen(function* () {
            yield* status.set(input.sessionID, { type: "busy" })
            result = yield* shellImpl(input, ready)
          }).pipe(Effect.ensuring(ready.open), Effect.ensuring(status.set(input.sessionID, { type: "idle" }))),
          ready.await.pipe(Effect.andThen(cancelLocal(input.sessionID))),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.succeed(true) : Effect.failCause(cause),
          ),
          Effect.orDie,
        )
      if (!accepted) return yield* new Session.BusyError({ sessionID: input.sessionID })
      return result ?? (yield* lastAssistant(input.sessionID))
    })

    const admitCommand: Interface["admitCommand"] = Effect.fn("SessionPrompt.admitCommand")(function* (input) {
      const prepared = yield* prepareCommand(input)
      const message = yield* admitWithCommand(prepared.prompt, {
        name: prepared.command,
        arguments: prepared.arguments,
      })
      return { ...prepared, message }
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      const owner = yield* requireExecution
      const admitted = yield* admitCommand(input)
      const result = yield* drainAdmitted(input.sessionID, owner, admitted.message.info.id)
      yield* events.publish(Command.Event.Executed, {
        name: admitted.command,
        sessionID: input.sessionID,
        arguments: admitted.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      recoverTask: (input) =>
        Effect.gen(function* () {
          const frozen = readRecoveryIntent(input.child)
          const parent = yield* sessions.get(frozen.parentSessionID).pipe(Effect.orDie)
          const location = locationServiceMap.get({
            directory: AbsolutePath.make(parent.directory),
            ...(parent.workspaceID ? { workspaceID: parent.workspaceID } : {}),
          })
          yield* Effect.gen(function* () {
            const runs = yield* DurableRun.Service
            const current = yield* runs.load(input.child.run.id).pipe(Effect.orDie)
            const missingTerminalResult =
              "sessionID" in current.run &&
              !!current.run.child &&
              ["completed", "failed"].includes(current.run.status) &&
              !current.run.childResult
            if (["completed", "failed", "cancelled"].includes(current.run.status) && !missingTerminalResult) {
              const promptOps = yield* ops(input.runChild, input.wakeSession)
              yield* deliverTaskNotification(current.run.id, promptOps.notify!).pipe(
                Effect.provideService(Session.Service, sessions),
                Effect.orDie,
              )
              return
            }
            if (
              !missingTerminalResult &&
              !["draft", "preflight", "queued", "running", "recovering"].includes(current.run.status)
            )
              return
            if (current.lease && DateTime.toEpochMillis(current.lease.expiresAt) > Date.now()) return
            if ((yield* background.get(frozen.childSessionID))?.status === "running") return
            // A live parent tool may be between durable child creation and
            // BackgroundJob.start. Only reclaim a completed handoff here;
            // unresolved parent Actions must recover through their own owner.
            const actions = yield* DurableAction.Service
            const parentAction = yield* actions.load(frozen.parentActionID).pipe(Effect.orDie)
            if (parentAction.action.status !== "settled") return
            const gateway = yield* ActionGateway.Service
            yield* gateway
              .validateDelegationParent({
                actionID: frozen.parentActionID,
                runID: frozen.parentRunID,
                toolName: "task",
                subject: {
                  type: "session",
                  sessionID: frozen.parentSessionID,
                  agent: AgentV2.ID.make(frozen.parentAgent),
                  assistantMessageID: frozen.parentMessageID,
                  toolCallID: frozen.callID,
                },
              })
              .pipe(Effect.orDie)
            const permissions = yield* PermissionV2.Service
            yield* taskRuntime
              .execute(frozen.parameters, {
                sessionID: frozen.parentSessionID,
                messageID: frozen.parentMessageID,
                agent: frozen.parentAgent,
                callID: frozen.callID,
                parentAction: { actionID: frozen.parentActionID, runID: frozen.parentRunID },
                nativeParent: frozen.model,
                sandboxProfile: frozen.sandboxProfile,
                abort: new AbortController().signal,
                restoreBackground: true,
                promptOps: yield* ops(input.runChild, input.wakeSession),
                metadata: () => Effect.void,
                ask: (request) =>
                  permissions
                    .assert({
                      sessionID: frozen.parentSessionID,
                      agent: AgentV2.ID.make(frozen.parentAgent),
                      action: request.permission,
                      resources: request.patterns,
                    })
                    .pipe(Effect.orDie),
              })
              .pipe(Effect.orDie)
          }).pipe(Effect.provide(location), Effect.provideService(Database.Service, database))
        }),
      cancel,
      admit,
      prompt,
      latestAssistant: lastAssistant,
      promoteSteers,
      shell,
      admitCommand,
      command,
      resolvePromptParts,
      scheduledTaskTool,
    })
  }),
)

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

/** Internal child admission seam. The lease is checked before any input mutation. */
export const admitChildPrompt = Effect.fn("SessionPrompt.admitChildPrompt")(function* (
  input: PromptInput,
  childAttempt: NonNullable<Parameters<TaskPromptOps["prompt"]>[1]>,
  admit: (input: PromptInput) => Effect.Effect<SessionV1.WithParts, Image.Error>,
) {
  if (input.runID !== childAttempt.childRunID)
    return yield* Effect.die(new Error("Child admission run identity mismatch"))
  yield* SubagentChildExecutor.validateExecution({ ...childAttempt, sessionID: input.sessionID }).pipe(Effect.orDie)
  const runs = yield* DurableRun.Service
  const database = yield* Database.Service
  const snapshot = yield* runs.load(childAttempt.childRunID).pipe(Effect.orDie)
  if (!("sessionID" in snapshot.run) || !snapshot.run.child)
    return yield* Effect.die(new Error("Child admission requires a durable child binding"))
  const frozen = readRecoveryIntent(snapshot as DurableRun.ChildSnapshot)
  const gateway = yield* ActionGateway.Service
  yield* gateway
    .validateDelegationParent({
      actionID: frozen.parentActionID,
      runID: frozen.parentRunID,
      toolName: "task",
      subject: {
        type: "session",
        sessionID: frozen.parentSessionID,
        agent: frozen.parentAgent,
        assistantMessageID: frozen.parentMessageID,
        toolCallID: frozen.callID,
      },
    })
    .pipe(Effect.orDie)
  if (!frozen.childMessageID || input.messageID !== frozen.childMessageID)
    return yield* Effect.die(new Error("Child admission requires its frozen message identity"))
  const envelope = snapshot.checkpoint!.state.taskRecovery as Record<string, unknown>
  const inputDigest = canonicalHash(input)
  const existing = yield* SessionInput.find(database.db, SessionMessage.ID.make(frozen.childMessageID))
  if ("admission" in envelope) {
    const recorded = Schema.decodeUnknownSync(Schema.Struct({ inputDigest: Schema.String }))(envelope.admission)
    if (recorded.inputDigest !== inputDigest)
      return yield* Effect.die(new Error("Child admission input changed during recovery"))
  } else {
    if (existing) return yield* Effect.die(new Error("Existing child admission is missing its input binding"))
    yield* runs
      .checkpoint({
        runID: childAttempt.childRunID,
        execution: childAttempt.execution,
        state: (state) => {
          const current = state?.taskRecovery
          if (!state || !current || typeof current !== "object") throw new Error("Missing task recovery envelope")
          if ("admission" in current) {
            const recorded = Schema.decodeUnknownSync(Schema.Struct({ inputDigest: Schema.String }))(current.admission)
            if (recorded.inputDigest !== inputDigest) throw new Error("Child admission input changed during recovery")
          }
          return { ...state, taskRecovery: { ...current, admission: { inputDigest } } }
        },
      })
      .pipe(Effect.orDie)
  }
  const admitted = existing
    ? yield* MessageV2.get({ sessionID: input.sessionID, messageID: frozen.childMessageID }).pipe(Effect.orDie)
    : yield* admit(input)
  if (
    existing &&
    !SessionInput.equivalent(existing, {
      sessionID: DurableSessionSchema.ID.make(input.sessionID),
      prompt: durablePromptFromMatureMessage(admitted),
      delivery: "steer",
    })
  )
    return yield* Effect.die(new Error("Child admission does not match its durable input"))
  return admitted
})

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  /** Internal durable continuation binding for a ChildRun; not a public prompt authority. */
  runID: Schema.optional(AgentRuntime.RunID),
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  model: Schema.optional(ModelRef),
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  arguments: Schema.String,
  command: Schema.String,
  variant: Schema.optional(Schema.String),
  // Inlined (no identifier annotation) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(PartID),
          type: Schema.Literal("file"),
          mime: Schema.String,
          filename: Schema.optional(Schema.String),
          url: Schema.String,
          source: Schema.optional(SessionV1.FilePartSource),
        }),
      ]).annotate({ discriminator: "type" }),
    ),
  ),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>

export interface CommandAdmission {
  readonly command: string
  readonly arguments: string
  readonly prompt: PromptInput
  readonly message: SessionV1.WithParts
}

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    SessionStatus.node,
    Session.node,
    SessionStore.node,
    Agent.node,
    Provider.node,
    Plugin.node,
    Command.node,
    Config.node,
    FSUtil.node,
    MCP.node,
    LSP.node,
    ToolRegistry.node,
    BackgroundJob.node,
    Truncate.node,
    Image.node,
    CrossSpawnSpawner.node,
    Instruction.node,
    SessionRevert.node,
    LLM.node,
    EventV2Bridge.node,
    // TaskRuntime is executed in this service context and reads RuntimeFlags.
    RuntimeFlags.node,
    Database.node,
    SubagentChildExecutor.node,
    RuntimeInvariants.node,
    LocationServiceMap.node,
    RollbackArtifact.node,
  ],
})

export * as SessionPrompt from "./prompt"
