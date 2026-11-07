import { createHash } from "node:crypto"
import { ToolOutput } from "@arforge-ai/llm"
import type { McpResourceReference } from "@arforge-ai/schema/prompt"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect"
import { AgentV2 } from "../../agent"
import { ActionGateway } from "../../action-gateway"
import { EventV2 } from "../../event"
import type { ModelV2 } from "../../model"
import type { PermissionV2 } from "../../permission"
import { DurableAction } from "../../runtime/durable-action"
import { ToolRegistry } from "../../tool/registry"
import type { Tool } from "../../tool/tool"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import type { SessionSchema } from "../schema"
import { SessionStore } from "../store"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const resourceToolName = (reference: McpResourceReference) =>
  `mcp_attached_${digest(JSON.stringify([reference.server, reference.uri])).slice(0, 40)}`
export const isResourceAttachmentTool = (name: string) => /^mcp_attached_[a-f0-9]{40}$/.test(name)
export const resourceAssistantID = (sessionID: string, userMessageID: string) =>
  SessionMessage.ID.make(`msg_${digest(JSON.stringify(["mcp-attachments", sessionID, userMessageID])).slice(0, 32)}`)

export class ResourceAttachmentError extends Schema.TaggedErrorClass<ResourceAttachmentError>()(
  "SessionRunner.ResourceAttachmentError",
  { message: Schema.String },
) {}

/** Resolve admitted references through the ordinary durable tool executor.
 * The product adapter supplies only exact current catalog projections. This
 * module owns invocation/history, never a transport or an MCP credential.
 */
export const settleResourceAttachments = Effect.fn("SessionRunner.resourceAttachments")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly runID: AgentRuntime.RunID
  readonly context: ReadonlyArray<SessionMessage.Message>
  readonly agent: AgentV2.ID
  readonly model: ModelV2.Ref
  readonly permissions: PermissionV2.Ruleset | undefined
  readonly externalTools: Readonly<Record<string, Tool.AnyTool>> | undefined
  readonly isLastStep: boolean
  /** The same run/lease fence used before the real provider request. */
  readonly validateExecution: Effect.Effect<void>
}) {
  const events = yield* EventV2.Service
  const registry = yield* ToolRegistry.Service
  const actions = yield* DurableAction.Service
  const store = yield* SessionStore.Service
  let changed = false
  for (const user of input.context) {
    if (user.type !== "user") continue
    const references = (user.files ?? []).flatMap((file, index) =>
      file.resource ? [{ reference: file.resource, index }] : [],
    )
    if (references.length === 0) continue
    const assistantMessageID = resourceAssistantID(input.sessionID, user.id)
    const selected = input.context.find(
      (message): message is SessionMessage.Assistant =>
        message.type === "assistant" && message.id === assistantMessageID,
    )
    const recorded = yield* store.message(assistantMessageID)
    if (recorded && (recorded.sessionID !== input.sessionID || recorded.message.type !== "assistant"))
      return yield* new ResourceAttachmentError({
        message: "MCP attachment step belongs to a different execution source.",
      })
    if (recorded && !selected)
      return yield* new ResourceAttachmentError({
        message: "MCP attachment has a committed step outside the current context; no resource reread was attempted.",
      })
    const existing = selected
    if (!existing) {
      for (const { index } of references) {
        const action = yield* actions
          .load(
            ActionGateway.stableActionID({
              runID: input.runID,
              sessionID: input.sessionID,
              assistantMessageID,
              toolCallID: `mcp-attachment:${user.id}:${index}`,
            }),
          )
          .pipe(Effect.option)
        if (Option.isSome(action))
          return yield* new ResourceAttachmentError({
            message:
              "MCP attachment has an existing action without its projected step; no resource reread was attempted.",
          })
      }
    }
    if (existing?.time.completed) continue
    yield* input.validateExecution
    if (!existing)
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        runID: input.runID,
        agent: input.agent,
        model: input.model,
      })
    changed = true
    for (const { reference, index } of references) {
      yield* input.validateExecution
      // One admitted attachment has one action identity across worker/run retries.
      const callID = `mcp-attachment:${user.id}:${index}`
      const previous = existing?.content.find(
        (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === callID,
      )
      if (previous?.state.status === "completed" || previous?.state.status === "error") continue
      const name = resourceToolName(reference)
      if (!previous)
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          name,
        })
      if (!previous || previous.state.status === "pending") {
        yield* events.publish(SessionEvent.Tool.Input.Ended, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          text: "{}",
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          tool: name,
          input: {},
          provider: { executed: false },
        })
      }
      const tool = input.externalTools?.[name]
      if (input.isLastStep || !tool) {
        const message = input.isLastStep
          ? "MCP attachment was not read: the agent step limit has been reached."
          : "MCP attachment is unavailable in its original server's current capability catalog."
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          error: { type: "unknown", message },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          error: { type: "unknown", message },
        })
        return yield* new ResourceAttachmentError({ message })
      }
      const materialized = yield* registry.materialize(input.permissions, input.sessionID, {
        externalTools: { [name]: tool },
      })
      const action = yield* actions
        .load(
          ActionGateway.stableActionID({
            runID: input.runID,
            sessionID: input.sessionID,
            assistantMessageID,
            toolCallID: callID,
          }),
        )
        .pipe(Effect.option)
      const runID = Option.isSome(action) ? action.value.action.runID : input.runID
      const exit = yield* materialized
        .settle({
          ...(runID ? { runID } : {}),
          sessionID: input.sessionID,
          agent: input.agent,
          assistantMessageID,
          call: { type: "tool-call", id: callID, name, input: {} },
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(exit.cause)
        const error = Cause.squash(exit.cause)
        const message = error instanceof Error ? error.message : String(error)
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          error: { type: "unknown", message },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Step.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          error: { type: "unknown", message },
        })
        return yield* Effect.failCause(exit.cause)
      }
      if (exit.value.result.type === "error") {
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          error: { type: "unknown", message: String(exit.value.result.value) },
          result: exit.value.result,
          provider: { executed: false },
        })
      } else {
        yield* input.validateExecution
        const output = exit.value.output ?? ToolOutput.fromResultValue(exit.value.result)
        if (!output)
          return yield* new ResourceAttachmentError({ message: "MCP attachment returned an unsupported tool result." })
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          structured:
            typeof output.structured === "object" && output.structured !== null && !Array.isArray(output.structured)
              ? Object.fromEntries(Object.entries(output.structured))
              : { value: output.structured },
          content: [...output.content],
          ...(exit.value.artifactRefs?.length ? { artifactRefs: exit.value.artifactRefs } : {}),
          ...(!exit.value.artifactRefs?.length && exit.value.outputPaths?.length
            ? { outputPaths: exit.value.outputPaths }
            : {}),
          provider: { executed: false },
        })
      }
    }
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID: input.sessionID,
      timestamp: yield* DateTime.now,
      assistantMessageID,
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }
  return changed
})
