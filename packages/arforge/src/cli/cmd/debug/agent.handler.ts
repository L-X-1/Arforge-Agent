import { EOL } from "os"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { basename } from "path"
import { Cause, Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Tool as MatureTool } from "@/tool/tool"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { ToolCoreBridge } from "@/tool/core-bridge"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Shell } from "@arforge-ai/core/shell"
import { ExplicitToolApproval } from "./explicit-tool-approval"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(agent)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const result = yield* executeExplicitTool({ tool, params, agent, ctx })
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = {
    ...agent,
    tools: resolvedTools,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const model =
    agent.model ??
    (yield* provider.defaultModel().pipe(
      Effect.matchCauseEffect({
        onSuccess: Effect.succeed,
        onFailure: (cause) => {
          const error = Cause.squash(cause) as Provider.DefaultModelError
          if (error instanceof Provider.ModelNotFoundError) {
            return fail(`Model not found: ${error.providerID}/${error.modelID}`)
          }
          if (error instanceof Provider.NoModelsError) return fail(`No models found for provider ${error.providerID}`)
          if (error instanceof Provider.NoModelSelectedError) return fail(error.message)
          return fail("No providers found")
        },
      }),
    ))
  return yield* registry.tools({ ...model, agent })
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !disabled.has(tool.id)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : String(error)

const executeExplicitTool = Effect.fn("Cli.debug.agent.executeExplicitTool")(function* (input: {
  tool: MatureTool.Def
  params: Record<string, unknown>
  agent: Agent.Info
  ctx: InstanceContext
}) {
  const sessionSvc = yield* Session.Service
  const session = yield* sessionSvc.create({
    title: `Debug tool run (${input.agent.name})`,
    agent: input.agent.name,
    permission: input.agent.permission,
  })
  const messageID = MessageID.ascending()
  const model = input.agent.model
    ? input.agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel().pipe(
          Effect.matchCauseEffect({
            onSuccess: Effect.succeed,
            onFailure: (cause) => {
              const error = Cause.squash(cause) as Provider.DefaultModelError
              if (error instanceof Provider.ModelNotFoundError) {
                return fail(`Model not found: ${error.providerID}/${error.modelID}`)
              }
              if (error instanceof Provider.NoModelsError)
                return fail(`No models found for provider ${error.providerID}`)
              if (error instanceof Provider.NoModelSelectedError) return fail(error.message)
              return fail("No providers found")
            },
          }),
        )
      })
  const now = Date.now()
  const message: SessionV1.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: input.agent.name,
    path: {
      cwd: input.ctx.directory,
      root: input.ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  const locations = yield* LocationServiceMap.Service
  const plugin = yield* Plugin.Service
  const config = yield* Config.Service
  const durableSessionID = DurableSessionSchema.ID.make(session.id)
  const assistantMessageID = SessionMessage.ID.make(messageID)
  const toolCallID = PartID.ascending()
  const location = locations.get(
    Location.Ref.make({
      directory: AbsolutePath.make(session.directory),
      ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
    }),
  )

  return yield* Effect.gen(function* () {
    const registry = yield* CoreToolRegistry.Service
    const permissions = yield* PermissionV2.Service
    const carrier = ToolCoreBridge.makeLegacySessionTools(
      [input.tool],
      { plugin, directory: input.ctx.directory, worktree: input.ctx.worktree },
      {
        messages: [],
        sandboxProfile: SandboxPolicy.profileFromMetadata(session.metadata),
        extra: {},
        workspace: input.ctx.worktree,
        shell: Shell.acceptable((yield* config.get()).shell),
        metadata: () => Effect.void,
      },
    )
    const materialized = yield* registry
      .materialize([], durableSessionID, {
        includeRegistered: false,
        legacySessionTools: carrier,
      })
      .pipe(Effect.catch((error) => fail(`Tool ${input.tool.id} could not be prepared: ${errorMessage(error)}`)))
    const settlement = yield* ExplicitToolApproval.settle({
      permissions,
      materialized,
      identity: { sessionID: durableSessionID, assistantMessageID, toolCallID },
      agent: AgentV2.ID.make(input.agent.name),
      name: input.tool.id,
      args: input.params,
    }).pipe(Effect.catch((error) => fail(`Tool ${input.tool.id} could not settle: ${errorMessage(error)}`)))
    if (settlement.result.type === "error")
      return yield* fail(`Tool ${input.tool.id} failed: ${String(settlement.result.value)}`)
    return ToolCoreBridge.settlementToMatureResult(settlement)
  }).pipe(Effect.provide(location))
})
