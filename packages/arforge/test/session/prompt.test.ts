import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import { Config as CoreConfig } from "@arforge-ai/core/config"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { Database } from "@arforge-ai/core/database/database"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { makeGlobalNode } from "@arforge-ai/core/effect/app-node"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { eq, sql } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@arforge-ai/core/event"
import { expect } from "bun:test"
import { Cause, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@arforge-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { hasPendingTaskNotification, readRecoveryIntent, taskNotificationParentToWake, TaskRuntime } from "@/tool/task"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionRunUsageTable } from "@arforge-ai/core/runtime/sql"
import * as RuntimeBilling from "@arforge-ai/core/runtime/billing"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { admitChildPrompt, SessionPrompt, type ShellInput } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@arforge-ai/core/session"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionEvent } from "@arforge-ai/core/session/event"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import { parseRequestEnvelopeJson } from "@arforge-ai/core/session/request-envelope"
import { SessionInput } from "@arforge-ai/core/session/input"
import { Prompt as DurablePrompt } from "@arforge-ai/core/session/prompt"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { Credential } from "@arforge-ai/core/credential"
import { Catalog } from "@arforge-ai/core/catalog"
import { Integration } from "@arforge-ai/core/integration"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@arforge-ai/llm/route"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@arforge-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ModelV2 } from "@arforge-ai/core/model"
import {
  buildSharedLocationServiceMap,
  LocationServiceMap,
  locationServiceMapLayer,
} from "@arforge-ai/core/location-services"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Billing } from "@arforge-ai/schema/billing"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { PersonalJobV2 } from "@arforge-ai/core/personal-job"
import { PersonalJobExecutor } from "@arforge-ai/core/personal-job-executor"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { EventTable } from "@arforge-ai/core/event/sql"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { SessionSchema as DurableSessionSchema } from "@arforge-ai/core/session/schema"
import { StructuredOutput as CoreStructuredOutput } from "@arforge-ai/core/tool/structured-output"
import { Project } from "../../src/project/project"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionExecutionFormal } from "../../src/session/execution-formal"
import { ToolCoreBridge } from "../../src/tool/core-bridge"
import {
  compare as compareSessionParity,
  fromCoreMessages as fromFormalParity,
  make as makeSessionParity,
} from "@arforge-ai/core/session/runner/parity"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

function makeMcp(instructions: MCP.ServerInstructions[] = [], overrides: Partial<MCP.Interface> = {}) {
  const defaults: MCP.Interface = {
    status: () => Effect.succeed({}),
    health: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed(instructions),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    catalog: () => Effect.succeed({ prompts: {}, resources: {}, resourceTemplates: {}, capabilities: [] }),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    declaredScope: () => Effect.succeed(undefined),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }
  return Layer.succeed(MCP.Service, MCP.Service.of({ ...defaults, ...overrides }))
}

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LocationServiceMap.node,
])

type McpTestInput = {
  mcpInstructions?: MCP.ServerInstructions[]
  mcpOverrides?: Partial<MCP.Interface>
}

function makePrompt(input?: McpTestInput) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions, input?.mcpOverrides)],
    [RuntimeFlags.node, runtimeFlags],
    [LocationServiceMap.node, locationServiceMapLayer],
  ] as const
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: McpTestInput) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions, input?.mcpOverrides)],
    [RuntimeFlags.node, runtimeFlags],
    [LocationServiceMap.node, locationServiceMapLayer],
  ] as const
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: McpTestInput) {
  return makePrompt(input)
}

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)

const formalIntegrationModels = (beforeResolve: Effect.Effect<void> = Effect.void) =>
  Layer.effect(
    SessionRunnerModel.Service,
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const route = OpenAICompatibleChat.route.with({
        endpoint: { baseURL: llm.url },
        auth: Auth.bearer("test-key"),
        limits: { context: 100_000, output: 10_000 },
        generation: { temperature: 0 },
      })
      return SessionRunnerModel.Service.of({
        resolveSmall: (_session, requiredInput) =>
          Effect.succeed(
            requiredInput.every((input) => input === "text")
              ? route.model({ id: "test-auto-mini", provider: "test" })
              : undefined,
          ),
        resolve: (session) =>
          beforeResolve.pipe(
            Effect.andThen(
              Effect.succeed(
                route.model({
                  id: session.model?.id ?? "test-model",
                  provider: session.model?.providerID ?? "test",
                }),
              ),
            ),
          ),
      })
    }),
  )
const formalIntegrationLocationServiceMapLayer = buildSharedLocationServiceMap([
  [SessionRunnerModel.node, formalIntegrationModels()],
])
const formalIntegrationLocationServiceMapNode = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: formalIntegrationLocationServiceMapLayer,
  deps: [Database.node],
})

function makeFormalIntegrationHttp(input?: {
  mcpInstructions?: MCP.ServerInstructions[]
  mcpOverrides?: Partial<MCP.Interface>
  beforeModelResolve?: Effect.Effect<void>
  realSummary?: boolean
  realModels?: boolean
  personalJobs?: boolean
}) {
  const root = LayerNode.group([
    promptRoot,
    testLLMServerNode,
    EventV2.node,
    SessionV2.node,
    SessionExecutionFormal.node,
    Project.node,
    InstanceStore.node,
    DurableRun.globalNode,
    DurableAction.globalNode,
    ToolCoreBridge.node,
    SubagentChildExecutor.node,
    RuntimeInvariants.node,
    ...(input?.personalJobs ? [PersonalJobV2.node, PersonalJobExecutor.node] : []),
    ...(input?.realModels ? [Credential.node] : []),
    ...(input?.realSummary ? [SessionSummary.node] : []),
  ])
  return LayerNode.compile(root, [
    [
      SessionProcessor.node,
      Layer.mock(SessionProcessor.Service, {
        create: () => Effect.die(new Error("R05 legacy processor must not execute")),
      }),
    ],
    ...(input?.realSummary ? [] : [[SessionSummary.node, summary] as const]),
    [LSP.node, lsp],
    [MCP.node, makeMcp(input?.mcpInstructions, input?.mcpOverrides)],
    [RuntimeFlags.node, runtimeFlags],
    [
      LocationServiceMap.node,
      input?.beforeModelResolve || input?.realModels
        ? makeGlobalNode({
            service: LocationServiceMap.Service,
            layer: buildSharedLocationServiceMap(
              input.realModels ? [] : [[SessionRunnerModel.node, formalIntegrationModels(input.beforeModelResolve)]],
            ),
            deps: [Database.node],
          })
        : formalIntegrationLocationServiceMapNode,
    ],
    [InstanceStore.bootstrapNode, noopBootstrapLayer],
    [SessionExecution.node, SessionExecutionFormal.node],
  ])
}

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  model: "test/test-model",
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const httpInstance = {
  init: (directory: string) =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* writeConfig(directory, providerCfg(llm.url))
    }),
}
const it = testEffect(makeHttp(), httpInstance)
const formalIntegration = testEffect(makeFormalIntegrationHttp(), httpInstance)
const credentialIntegration = testEffect(makeFormalIntegrationHttp({ realModels: true }), httpInstance)

for (const target of ["root", "child"] as const)
  for (const approved of [true, false, null]) {
    if (target === "root" && approved === null) continue
    const observed: Array<{ agent: string; modelID: string; providerID: string }> = []
    let executions = 0
    const externalTools: ToolRegistry.Interface["tools"] = (input) =>
      Effect.sync(() => {
        observed.push({ agent: input.agent.name, modelID: input.modelID, providerID: input.providerID })
        return [
          {
            id: "plugin_echo",
            description: "Formal external echo",
            parameters: Schema.Struct({ value: Schema.String }),
            origin: { kind: "plugin" as const, permission: "plugin_echo" },
            execute: () =>
              Effect.sync(() => {
                executions++
                return { title: "External echo", output: "external-source-result", metadata: {} }
              }),
          },
        ]
      })
    const externalIntegration = testEffect(makeFormalIntegrationHttp(), httpInstance)
    externalIntegration.instance(
      `Formal external tool ${target} ${approved === null ? "capability denial" : approved ? "approval" : "rejection"} uses the request snapshot and Gateway`,
      () =>
        Effect.gen(function* () {
          observed.length = 0
          executions = 0
          const registry = yield* ToolRegistry.Service
          const originalTools = registry.tools
          Object.assign(registry, { tools: externalTools })
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Object.assign(registry, { tools: originalTools })
            }),
          )
          const { llm } = yield* useServerConfig((url) => ({
            ...providerCfg(url),
            command: { external: { template: "Use external echo", agent: "general", subtask: true } },
          }))
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({
            title: "External snapshot",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const locations = yield* LocationServiceMap.Service
          const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
          const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
          if (target === "child")
            yield* llm.tool("task", {
              description: "External child",
              prompt: "Use external echo",
              subagent_type: "general",
              ...(approved === null
                ? {}
                : { capabilities: [{ action: "plugin_echo", resources: ["*"], access: "write" }] }),
            })
          yield* llm.tool("plugin_echo", { value: "echo" })
          yield* llm.text("External flow complete")
          if (target === "child") yield* llm.text("Parent received external result")
          const fiber = yield* prompt
            .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "Use external echo" }] })
            .pipe(Effect.forkChild)
          const externalRequestIndex = target === "child" ? 1 : 0
          yield* awaitWithTimeout(llm.wait(externalRequestIndex + 1), "external request missing", "10 seconds")
          const requestBody = JSON.stringify((yield* llm.hits)[externalRequestIndex]?.body)
          expect(requestBody.includes('"name":"plugin_echo"')).toBe(true)
          if (approved === null) {
            yield* awaitWithTimeout(Fiber.await(fiber), "capability denial did not settle", "15 seconds")
            expect(executions).toBe(0)
            expect(yield* permissions.list()).toEqual([])
            expect(
              JSON.stringify((yield* llm.hits)[externalRequestIndex + 1]?.body).includes(
                "child capability does not authorize plugin_echo",
              ),
            ).toBe(true)
            expect(observed[externalRequestIndex]?.agent).toBe("general")
            return
          }
          const approval = yield* pollWithTimeout(
            Effect.gen(function* () {
              const pending = (yield* permissions.list()).find((item) => item.action === "plugin_echo")
              if (pending) return pending
              if ((yield* llm.hits).length > externalRequestIndex + 1) {
                const child = (yield* sessions.children(chat.id))[0]
                const history = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(child?.id ?? chat.id))
                const tools = history.filter((message) => message.type === "assistant")
                return yield* Effect.die(new Error(`External tool settled without approval: ${JSON.stringify(tools)}`))
              }
            }),
            "external approval missing",
          )
          expect(approval).toMatchObject({ action: "plugin_echo", requiresHumanConfirmation: true })
          if (target === "child")
            expect((yield* sessions.children(chat.id)).map((child) => child.id)).toContain(approval.sessionID)
          else expect(approval.sessionID).toBe(chat.id)
          expect(executions).toBe(0)
          yield* permissions.reply({ requestID: approval.id, reply: approved ? "once" : "reject" })
          yield* awaitWithTimeout(Fiber.await(fiber), "external flow did not settle", "15 seconds")
          expect(executions).toBe(approved ? 1 : 0)
          expect(observed[externalRequestIndex]).toEqual({
            agent: target === "child" ? "general" : "build",
            modelID: "test-model",
            providerID: "test",
          })
          if (approved) {
            expect(observed.length).toBe(target === "child" ? 4 : 2)
            expect(
              JSON.stringify((yield* llm.hits)[externalRequestIndex + 1]?.body).includes("external-source-result"),
            ).toBe(true)
          }
        }),
      30_000,
    )
  }
const noLLMServer = testEffect(makeHttpNoLLMServer(), { config: cfg })
const modelPreparationStarted: Array<Deferred.Deferred<void>> = []
const preparationRace = testEffect(
  makeFormalIntegrationHttp({
    beforeModelResolve: Effect.suspend(() => {
      const ready = modelPreparationStarted.shift()
      return ready ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void
    }),
  }),
  httpInstance,
)
const withMcpInstructions = testEffect(
  makeFormalIntegrationHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
  httpInstance,
)
const mcpAttachmentResourceUri = "mcp://fixture/resource/readme"
let mcpAttachmentReads = 0
let mcpAttachmentDeniedReads = 0
const withMcpAttachment = testEffect(
  makeFormalIntegrationHttp({
    mcpOverrides: {
      capabilities: () =>
        Effect.succeed([
          {
            id: "fixture:mcp://fixture/resource/readme",
            server: "fixture-server",
            kind: "resource" as const,
            generation: 7,
            name: "readme",
            reference: mcpAttachmentResourceUri,
            permission: "read",
            patterns: [`mcp:fixture-server:${mcpAttachmentResourceUri}`],
          },
        ]),
      declaredScope: () =>
        Effect.succeed({
          endpoint: "mcp://fixture",
          networkScope: [],
          secretScope: [],
          externalServices: ["fixture-server"],
        }),
      readResource: (clientName, resourceUri) =>
        Effect.sync(() => {
          mcpAttachmentReads++
          if (clientName !== "fixture-server" || resourceUri !== mcpAttachmentResourceUri)
            throw new Error("unexpected MCP attachment resource")
          return {
            contents: [{ uri: resourceUri, mimeType: "text/plain", text: "resource routed through Core" }],
          }
        }),
    },
  }),
  httpInstance,
)
const withMcpAttachmentDenied = testEffect(
  makeFormalIntegrationHttp({
    mcpOverrides: {
      capabilities: () => Effect.succeed([]),
      readResource: () =>
        Effect.sync(() => {
          mcpAttachmentDeniedReads++
          return { contents: [{ uri: mcpAttachmentResourceUri, mimeType: "text/plain", text: "must not read" }] }
        }),
    },
  }),
  httpInstance,
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(path.join(dir, "arforge.json"), JSON.stringify({ $schema: "urn:arforge:config", ...config }))
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  const configService = yield* Config.Service
  yield* configService.invalidate()
  const loaded = yield* configService.get()
  expect(loaded.provider?.test).toBeDefined()
  const providers = yield* (yield* ProviderSvc.Service).list()
  expect(Object.keys(providers)).toContain("test")
  return { dir, llm }
})

const personalJobPrice = (amountMinor = 1) =>
  Billing.PriceCatalog.make({
    revision: "fixture-personal-job-price-v1",
    currency: "USD",
    minorUnit: 6,
    unit: "token",
    effectiveFrom: DateTime.makeUnsafe(0),
    source: "fixture:personal-job",
    rates: { unknownInput: { amountMinor }, textOutput: { amountMinor } },
  })

const usePersonalJobPrice = Effect.fn("test.usePersonalJobPrice")(function* (
  sessionID: SessionV2.ID,
  price?: Billing.PriceCatalog,
) {
  const session = yield* (yield* SessionV2.Service).get(sessionID)
  const locations = yield* LocationServiceMap.Service
  const catalog = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
  const registration = yield* catalog.transform((editor) =>
    editor.model.update(ref.providerID, ref.modelID, (draft) => {
      if (price === undefined) delete draft.priceCatalog
      else draft.priceCatalog = price
    }),
  )
  expect((yield* catalog.model.get(ref.providerID, ref.modelID))?.priceCatalog).toEqual(price)
  return registration
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string; permission?: PermissionV1.Ruleset }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, sessions, chat }
})

const startApprovedDirectShell = Effect.fn("test.startApprovedDirectShell")(function* (
  prompt: SessionPrompt.Interface,
  input: ShellInput,
) {
  const locations = yield* LocationServiceMap.Service
  const sessions = yield* Session.Service
  const session = yield* sessions.get(input.sessionID)
  const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(session.directory) }))
  const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
  const fiber = yield* prompt
    .shell({ ...input, messageID: input.messageID ?? MessageID.ascending() })
    .pipe(Effect.forkChild)
  const request = yield* pollWithTimeout(
    permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === input.sessionID))),
    "direct Shell approval was not requested",
  )
  yield* permissions.reply({ requestID: request.id, reply: "once" })
  return fiber
})

const approvedDirectShell = Effect.fn("test.approvedDirectShell")(function* (
  prompt: SessionPrompt.Interface,
  input: ShellInput,
) {
  return yield* Fiber.join(yield* startApprovedDirectShell(prompt, input))
})

// Loop semantics

for (const format of ["canonical", "legacy", "mixed", "saved"] as const)
  testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
    `Formal PersonalJob loads verified pricing from the actual configuration file: ${format}`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const price = personalJobPrice()
        const encoded = Schema.encodeSync(Billing.PriceCatalog)(price)
        const contents = JSON.stringify(
          format !== "legacy"
            ? {
                model: "test/test-model",
                ...(format === "mixed"
                  ? {
                      provider: {
                        test: {
                          ...providerCfg("http://127.0.0.1:1/v1").provider.test,
                          models: {
                            "test-model": {
                              ...cfg.provider.test.models["test-model"],
                              status: "deprecated",
                              priceCatalog: {
                                ...encoded,
                                revision: "legacy-price",
                                rates: {
                                  unknownInput: { amountMinor: 9 },
                                  textOutput: { amountMinor: 9 },
                                  cacheRead: { amountMinor: 9 },
                                },
                              },
                            },
                          },
                        },
                      },
                    }
                  : {}),
                providers: {
                  test: {
                    name: "Test",
                    env: [],
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url },
                    request: { body: { apiKey: "fixture-config-key" } },
                    models: {
                      "test-model": {
                        name: "Test Model",
                        disabled: false,
                        limit: { context: 100_000, output: 10_000 },
                        priceCatalog: encoded,
                      },
                    },
                  },
                },
              }
            : {
                ...providerCfg(llm.url),
                provider: {
                  test: {
                    ...providerCfg(llm.url).provider.test,
                    models: { "test-model": { ...cfg.provider.test.models["test-model"], priceCatalog: encoded } },
                  },
                },
              },
        )
        const file = path.join(directory, "arforge.json")
        yield* writeText(file, contents)
        const config = yield* Config.Service
        yield* config.invalidate()
        const configured = yield* config.get()
        expect(configured.provider?.test?.models?.["test-model"]?.priceCatalog).toEqual(price)
        if (format === "mixed") {
          expect(configured.provider?.test?.models?.["test-model"]?.status).toBe("active")
          expect(configured.provider?.test?.api).toBe(llm.url)
        }
        const chat = yield* (yield* Session.Service).create({ title: "Pinned saved price configuration" })
        const sessionID = SessionV2.ID.make(chat.id)
        const session = yield* (yield* SessionV2.Service).get(sessionID)
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(session.location)
        const source = yield* CoreConfig.Service.pipe(Effect.provide(location))
        const catalog = yield* Catalog.Service.pipe(Effect.provide(location))
        const documents = (yield* source.entries()).filter((entry) => entry.type === "document")
        expect(
          documents.some((entry) => entry.info.providers?.test?.models?.["test-model"]?.priceCatalog !== undefined),
        ).toBe(true)
        expect((yield* catalog.model.get(ref.providerID, ref.modelID))?.priceCatalog).toEqual(price)
        if (format === "saved") {
          const updatedPrice = personalJobPrice(2)
          yield* config.update(
            { provider: { test: { models: { "test-model": { priceCatalog: updatedPrice } } } } },
            locations,
          )
          const saved = yield* (yield* FSUtil.Service).readJson(file)
          expect(saved).toMatchObject({
            providers: {
              test: {
                models: { "test-model": { priceCatalog: Schema.encodeSync(Billing.PriceCatalog)(updatedPrice) } },
              },
            },
          })
          expect(yield* (yield* FSUtil.Service).exists(path.join(directory, "config.json"))).toBe(false)
          const reloaded = yield* Catalog.Service.pipe(Effect.provide(locations.get(session.location)))
          expect((yield* reloaded.model.get(ref.providerID, ref.modelID))?.priceCatalog).toEqual(updatedPrice)
        }
        const jobs = yield* PersonalJobV2.Service
        const created = yield* jobs.create({
          idempotencyKey: PersonalJob.IdempotencyKey.make("formal-configured-price"),
          sessionID,
          title: PersonalJob.Title.make("Use my saved price configuration"),
          prompt: PersonalJob.Prompt.make("Execute using the saved price and the original task budget."),
          schedule: {
            kind: "once",
            label: "Fixture",
            nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
            timezone: "UTC",
          },
          budget: { maxAttempts: 1, maxDurationMs: 60_000, maxCostMicros: 1_000_000 },
          approvalPolicy: { mode: "automatic", rationale: "Explicit test job" },
          notificationPolicy: { mode: "none", events: [] },
        })
        yield* llm.text("Completed with the saved price", { usage: { input: 2, output: 3 } })
        const result = yield* (yield* PersonalJobExecutor.Service).execute({
          jobID: created.id,
          expectedRevision: created.revision,
        })
        expect(result.status).toBe("completed")
        expect(result.result?.usage.costMicros).toBe(format === "saved" ? 10 : 5)
        expect(result.budget.costMicrosUsed).toBe(format === "saved" ? 10 : 5)
        expect(yield* llm.calls).toBe(1)
        if (format !== "saved") expect(yield* (yield* FSUtil.Service).readFileString(file)).toBe(contents)
      }),
    30_000,
  )

for (const entry of ["execute", "launch"] as const)
  for (const priceState of ["missing", "future"] as const)
    testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
      `Formal PersonalJob refuses unverified pricing before admission: ${entry}/${priceState}`,
      () =>
        Effect.gen(function* () {
          const { llm } = yield* useServerConfig(providerCfg)
          const sessions = yield* Session.Service
          const jobs = yield* PersonalJobV2.Service
          const executor = yield* PersonalJobExecutor.Service
          const runs = yield* DurableRun.Service
          const { db } = yield* Database.Service
          const chat = yield* sessions.create({ title: "Pinned unverified price" })
          const sessionID = SessionV2.ID.make(chat.id)
          yield* usePersonalJobPrice(
            sessionID,
            priceState === "missing"
              ? undefined
              : { ...personalJobPrice(), effectiveFrom: DateTime.makeUnsafe(Date.now() + 86_400_000) },
          )
          const created = yield* jobs.create({
            idempotencyKey: PersonalJob.IdempotencyKey.make("formal-unverified-price"),
            sessionID,
            title: PersonalJob.Title.make("Require a verified price"),
            prompt: PersonalJob.Prompt.make("Do not spend without enforcing the configured budget."),
            schedule: {
              kind: "once",
              label: "Fixture",
              nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
              timezone: "UTC",
            },
            budget: { maxAttempts: 1, maxDurationMs: 60_000, maxCostMicros: 1_000_000 },
            approvalPolicy: { mode: "automatic", rationale: "Explicit test job" },
            notificationPolicy: { mode: "none", events: [] },
          })
          yield* llm.text("Executed only after verified pricing was supplied")
          const result = yield* executor[entry]({ jobID: created.id, expectedRevision: created.revision }).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) {
            expect(Cause.pretty(result.cause)).toContain("price catalog")
            expect(Cause.pretty(result.cause)).toContain("test/test-model")
            expect(Cause.pretty(result.cause)).toContain('providers["test"].models["test-model"].priceCatalog')
            expect(Cause.pretty(result.cause)).toContain("arforge.json")
            expect(Cause.pretty(result.cause)).toContain("reopen the workspace")
          }
          expect(yield* jobs.get(created.id)).toEqual(created)
          expect(yield* runs.list({ sessionID })).toEqual([])
          expect(yield* SessionInput.listQueued(db, sessionID)).toEqual([])
          expect(yield* llm.calls).toBe(0)
          yield* usePersonalJobPrice(sessionID, personalJobPrice(0))
          const retried = yield* executor.execute({ jobID: created.id, expectedRevision: created.revision })
          expect(retried.status).toBe("completed")
          expect(retried.budget.attemptsUsed).toBe(1)
          expect(retried.result?.summary).toBe("Executed only after verified pricing was supplied")
          expect(yield* llm.calls).toBe(1)
        }),
      30_000,
    )

for (const [amountMinor, recovery] of [
  [0, "none"],
  [1, "none"],
  [1, "missing-price"],
  [1, "changed-price"],
  [1, "credential-removed"],
  [1, "receipt-drift"],
  [1, "receipt-missing"],
  [1, "receipt-unsettled"],
  [1, "summary"],
  [1, "summary-missing-final"],
] as const)
  testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
    `Formal PersonalJob uses the original catalog and persisted billing receipt: rate ${amountMinor}/${recovery}`,
    () =>
      Effect.gen(function* () {
        const summarizing = recovery === "summary" || recovery === "summary-missing-final"
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          ...(summarizing ? { compaction: { reserved: 100_000, preserve_recent_tokens: 0 } } : {}),
        }))
        const callCount = summarizing ? 2 : 1
        const expectedCost = (summarizing ? 23 : 5) * amountMinor
        const sessions = yield* Session.Service
        const jobs = yield* PersonalJobV2.Service
        const executor = yield* PersonalJobExecutor.Service
        const runs = yield* DurableRun.Service
        const credentials = yield* Credential.Service
        const credential =
          recovery === "credential-removed"
            ? yield* credentials.create({
                integrationID: Integration.ID.make("test"),
                value: Credential.Key.make({ type: "key", key: "fixture-personal-job-only" }),
              })
            : undefined
        const { db } = yield* Database.Service
        const chat = yield* sessions.create({ title: "Pinned verified job billing" })
        const sessionID = SessionV2.ID.make(chat.id)
        yield* usePersonalJobPrice(sessionID, personalJobPrice(amountMinor))
        const created = yield* jobs.create({
          idempotencyKey: PersonalJob.IdempotencyKey.make("formal-priced-job"),
          sessionID,
          title: PersonalJob.Title.make("Meter the original execution"),
          prompt: PersonalJob.Prompt.make("Complete this priced task once. ".repeat(summarizing ? 80 : 1).trim()),
          credentialIDs: credential ? [credential.id] : [],
          schedule: {
            kind: "once",
            label: "Fixture",
            nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
            timezone: "UTC",
          },
          budget: { maxAttempts: 1, maxDurationMs: 60_000, maxCostMicros: 1_000_000 },
          approvalPolicy: { mode: "automatic", rationale: "Explicit test job" },
          notificationPolicy: { mode: "none", events: [] },
        })
        let injected = 0
        if (recovery !== "none") {
          const events = yield* EventV2.Service
          yield* events.project(PersonalJob.Event.Changed, (event) =>
            Effect.gen(function* () {
              if (event.data.jobID !== created.id || event.data.reason !== "recover recorded result" || injected > 0)
                return
              injected++
              yield* Effect.die(new Error("Fixture loss after original billing before PersonalJob result commit"))
            }),
          )
        }
        if (summarizing)
          yield* llm.text("## Objective\n- Complete the priced task once", { usage: { input: 7, output: 11 } })
        yield* llm.text("Verified priced result", { usage: { input: 2, output: 3 } })
        const first = yield* executor
          .execute({ jobID: created.id, expectedRevision: created.revision })
          .pipe(Effect.exit)
        const original = yield* runs.list({ sessionID })
        const rows = yield* db
          .select()
          .from(SessionRunUsageTable)
          .where(eq(SessionRunUsageTable.session_id, sessionID))
          .all()
        if (recovery !== "none") {
          expect(Exit.isFailure(first)).toBe(true)
          expect(injected).toBe(1)
          const retained = yield* jobs.get(created.id)
          expect(retained.status).toBe("running")
          expect(retained.budget.costMicrosUsed).toBe(0)
          expect(retained.result).toBeUndefined()
          expect(original[0]?.run.status).toBe("completed")
          if (recovery === "missing-price") yield* usePersonalJobPrice(sessionID)
          if (recovery === "changed-price")
            yield* usePersonalJobPrice(sessionID, { ...personalJobPrice(100), revision: "fixture-price-v2" })
          if (credential) {
            yield* credentials.remove(credential.id)
            expect(yield* credentials.get(credential.id)).toBeUndefined()
          }
          if (recovery === "receipt-drift" || recovery === "receipt-missing" || recovery === "receipt-unsettled") {
            const row = rows[0]
            if (!row?.billing_receipt) throw new Error("Missing original priced receipt fixture")
            yield* db
              .update(SessionRunUsageTable)
              .set({
                billing_receipt:
                  recovery === "receipt-drift"
                    ? { ...row.billing_receipt, requestDigest: "f".repeat(64) }
                    : recovery === "receipt-missing"
                      ? null
                      : row.billing_receipt,
                settlement_reservation_id: recovery === "receipt-unsettled" ? null : row.settlement_reservation_id,
              })
              .where(eq(SessionRunUsageTable.id, row.id))
              .run()
            const refused = yield* executor
              .execute({ jobID: retained.id, expectedRevision: retained.revision })
              .pipe(Effect.exit)
            expect(Exit.isFailure(refused)).toBe(true)
            expect(yield* jobs.get(created.id)).toEqual(retained)
            expect(yield* llm.calls).toBe(1)
            yield* db
              .update(SessionRunUsageTable)
              .set({
                billing_receipt: row.billing_receipt,
                settlement_reservation_id: row.settlement_reservation_id,
              })
              .where(eq(SessionRunUsageTable.id, row.id))
              .run()
          }
          if (recovery === "summary-missing-final") {
            const row = rows.find((item) => item.text_output === 3)
            if (!row) throw new Error("Missing final response billing row fixture")
            yield* db.delete(SessionRunUsageTable).where(eq(SessionRunUsageTable.id, row.id)).run()
            const refused = yield* executor
              .execute({ jobID: retained.id, expectedRevision: retained.revision })
              .pipe(Effect.exit)
            expect(Exit.isFailure(refused)).toBe(true)
            expect(yield* jobs.get(created.id)).toEqual(retained)
            expect(yield* llm.calls).toBe(2)
            yield* db.insert(SessionRunUsageTable).values(row).run()
          }
        } else if (Exit.isFailure(first)) {
          yield* Effect.failCause(first.cause)
        }
        const current = yield* jobs.get(created.id)
        const result = yield* executor.execute({ jobID: current.id, expectedRevision: current.revision })
        expect(result.status).toBe("completed")
        expect(result.result?.summary).toBe("Verified priced result")
        expect(result.result?.usage.costMicros).toBe(expectedCost)
        expect(result.budget.costMicrosUsed).toBe(expectedCost)
        expect(result.budget.attemptsUsed).toBe(1)
        expect(original).toHaveLength(1)
        const originalRun = original[0]?.run
        if (!originalRun || !("admission" in originalRun)) throw new Error("Missing original session run fixture")
        expect(originalRun.admission?.billing?.budget).toEqual({ currency: "USD", limitMinor: 1_000_000 })
        expect(rows).toHaveLength(callCount)
        const receipts = rows.map((row) => RuntimeBilling.decodeReceipt(row.billing_receipt))
        for (const receipt of receipts) {
          expect(receipt.catalog).toEqual(personalJobPrice(amountMinor))
          expect(receipt.usage.source).toBe("provider")
        }
        expect(receipts.reduce((total, receipt) => total + receipt.charge.amountMinor, 0)).toBe(expectedCost)
        expect(yield* llm.calls).toBe(callCount)
        expect(yield* executor.execute({ jobID: result.id, expectedRevision: result.revision })).toEqual(result)
        expect(
          yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.session_id, sessionID)).all(),
        ).toEqual(rows)
        expect(yield* runs.list({ sessionID })).toEqual(original)
        expect(yield* llm.calls).toBe(callCount)
      }),
    30_000,
  )

for (const boundary of [
  "original",
  "later-result",
  "missing-binding",
  "attempt-limit",
  "queued-reconcile",
  "user-pause",
  "user-cancel",
  "concurrent-reconcile",
  "commit-drift",
] as const)
  testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
    `Formal PersonalJob recovers an already completed run without another model call: ${boundary}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const jobs = yield* PersonalJobV2.Service
        const executor = yield* PersonalJobExecutor.Service
        const runs = yield* DurableRun.Service
        const chat = yield* sessions.create({ title: "Pinned lost job result" })
        const sessionID = SessionV2.ID.make(chat.id)
        const created = yield* jobs.create({
          idempotencyKey: PersonalJob.IdempotencyKey.make("formal-lost-result"),
          sessionID,
          title: PersonalJob.Title.make("Recover original result"),
          prompt: PersonalJob.Prompt.make("Complete this job exactly once and retain its result."),
          schedule: {
            kind: "once",
            label: "Fixture",
            nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
            timezone: "UTC",
          },
          budget: {
            maxAttempts: boundary === "attempt-limit" ? 1 : 3,
            maxDurationMs: 60_000,
            maxCostMicros: 1_000_000,
          },
          approvalPolicy: { mode: "automatic", rationale: "Explicit test job" },
          notificationPolicy: { mode: "none", events: [] },
        })
        yield* llm.text("Original completed result")
        const lost = yield* PersonalJobExecutor.executeWith(
          {
            jobs: {
              ...jobs,
              reconcileResult: (input) =>
                Effect.gen(function* () {
                  const originalRuns = yield* runs.list({ sessionID }).pipe(Effect.orDie)
                  if (originalRuns.some(({ run }) => run.status === "completed"))
                    return yield* Effect.die("Injected loss before PersonalJob result commit")
                  return yield* jobs.reconcileResult(input)
                }),
            },
            sessions: core,
          },
          { jobID: created.id, expectedRevision: created.revision },
        ).pipe(Effect.exit)
        expect(Exit.isFailure(lost)).toBe(true)
        expect(yield* llm.calls).toBe(1)
        const original = yield* runs.list({ sessionID })
        expect(original).toHaveLength(1)
        expect(original[0]?.run.status).toBe("completed")
        if (boundary === "later-result") {
          yield* core.prompt({
            sessionID,
            prompt: { text: "A separate user request after the background result." },
            delivery: "queue",
            resume: false,
          })
          yield* llm.text("Unrelated newer answer")
          yield* core.resume(sessionID)
        }
        if (boundary === "missing-binding") {
          const { db } = yield* Database.Service
          const start = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Step.Started.type, 1)))
            .get()
            .pipe(Effect.orDie)
          if (!start) throw new Error("Missing original Step.Started fixture")
          const { runID: _runID, requestDigest: _requestDigest, ...data } = start.data
          yield* db.update(EventTable).set({ data }).where(eq(EventTable.id, start.id)).run().pipe(Effect.orDie)
        }
        const retainedRuns = yield* runs.list({ sessionID })
        const history = yield* core.context(sessionID)
        const running = yield* jobs.get(created.id)
        expect(running.status).toBe("running")
        expect(running.result).toBeUndefined()
        if (boundary === "commit-drift") {
          const { db } = yield* Database.Service
          const events = yield* EventV2.Service
          const beforeEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
          const step = beforeEvents.find(
            (row) =>
              row.aggregate_id === sessionID && row.type === EventV2.versionedType(SessionEvent.Step.Started.type, 1),
          )
          if (!step) throw new Error("Missing original assistant event for commit drift fixture")
          let injected = 0
          yield* events.project(PersonalJob.Event.Changed, (event) =>
            Effect.gen(function* () {
              if (event.data.jobID !== running.id || event.data.reason !== "recover recorded result" || injected > 0)
                return
              injected++
              const { runID: _runID, requestDigest: _requestDigest, ...data } = step.data
              yield* db.update(EventTable).set({ data }).where(eq(EventTable.id, step.id)).run().pipe(Effect.orDie)
            }),
          )
          expect(
            Exit.isFailure(
              yield* jobs.reconcileResult({ jobID: running.id, expectedRevision: running.revision }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(injected).toBe(1)
          expect(yield* jobs.get(running.id)).toEqual(running)
          expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual(beforeEvents)
          const settled = yield* jobs.reconcileResult({ jobID: running.id, expectedRevision: running.revision })
          expect(settled.status).toBe("completed")
          expect(settled.budget.attemptsUsed).toBe(1)
          expect(yield* llm.calls).toBe(1)
          return
        }
        if (boundary === "user-pause" || boundary === "user-cancel") {
          const stopped = yield* (boundary === "user-pause" ? jobs.pause : jobs.cancel)({
            jobID: running.id,
            expectedRevision: running.revision,
          })
          expect(yield* jobs.reconcileResult({ jobID: stopped.id, expectedRevision: stopped.revision })).toEqual(
            stopped,
          )
          expect(yield* jobs.recover({ sessionID, now: Date.now() + 62_000 })).toBe(0)
          expect(yield* jobs.get(stopped.id)).toEqual(stopped)
          expect(yield* llm.calls).toBe(1)
          expect(yield* runs.list({ sessionID })).toEqual(retainedRuns)
          return
        }
        if (boundary === "concurrent-reconcile") {
          const candidates = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              jobs.reconcileResult({ jobID: running.id, expectedRevision: running.revision }).pipe(Effect.exit),
            ),
            { concurrency: "unbounded" },
          )
          expect(candidates.some(Exit.isSuccess)).toBe(true)
          const settled = yield* jobs.get(running.id)
          expect(settled.revision).toBe(running.revision + 1)
          expect(settled.status).toBe("completed")
          expect(settled.budget.attemptsUsed).toBe(1)
          expect(settled.result?.summary).toBe("Original completed result")
          expect(yield* jobs.reconcileResult({ jobID: settled.id, expectedRevision: settled.revision })).toEqual(
            settled,
          )
          expect(
            Exit.isFailure(
              yield* jobs.reconcileResult({ jobID: settled.id, expectedRevision: running.revision }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* jobs.get(running.id)).toEqual(settled)
          expect(yield* llm.calls).toBe(1)
          return
        }
        if (boundary === "queued-reconcile") {
          const paused = yield* jobs.pause({ jobID: running.id, expectedRevision: running.revision })
          yield* jobs.resume({ jobID: paused.id, expectedRevision: paused.revision })
        }
        expect(yield* jobs.recover({ sessionID, now: Date.now() + 62_000 })).toBe(
          boundary === "missing-binding" || boundary === "queued-reconcile" ? 0 : 1,
        )
        const queued = yield* jobs.get(created.id)
        // A faulty forced resume can finish, making an extra HTTP call observable
        // without relying on a timeout or an exhausted response queue.
        yield* llm.text("Unexpected repeated execution")
        if (boundary === "missing-binding") {
          expect(
            Exit.isFailure(
              yield* executor.execute({ jobID: queued.id, expectedRevision: queued.revision }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* llm.calls).toBe(1)
          expect((yield* jobs.get(queued.id)).result).toBeUndefined()
          expect(yield* runs.list({ sessionID })).toEqual(retainedRuns)
          expect(yield* core.context(sessionID)).toEqual(history)
          return
        }
        const recovered = yield* executor.execute({ jobID: queued.id, expectedRevision: queued.revision })
        expect(yield* llm.calls).toBe(boundary === "later-result" ? 2 : 1)
        expect(recovered.status).toBe("completed")
        expect(recovered.result?.summary).toBe("Original completed result")
        expect(recovered.occurrence).toEqual(running.occurrence)
        expect(recovered.budget.attemptsUsed).toBe(running.budget.attemptsUsed)
        expect(yield* runs.list({ sessionID })).toEqual(retainedRuns)
        expect(yield* core.context(sessionID)).toEqual(history)
        if (!recovered.occurrence) throw new Error("Missing recovered occurrence")
        const duplicate = yield* core
          .resumeWithCredentials({
            sessionID,
            credentialIDs: [],
            personalJob: { jobID: recovered.id, occurrence: recovered.occurrence },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)
        expect(yield* llm.calls).toBe(boundary === "later-result" ? 2 : 1)
        expect(yield* runs.list({ sessionID })).toEqual(retainedRuns)
      }),
    45_000,
  )

testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
  "Formal PersonalJob leaves unrelated queue and steer inputs for ordinary execution",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const core = yield* SessionV2.Service
      const jobs = yield* PersonalJobV2.Service
      const executor = yield* PersonalJobExecutor.Service
      const runs = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const chat = yield* (yield* Session.Service).create({ title: "Pinned isolated job input" })
      const sessionID = SessionV2.ID.make(chat.id)
      yield* usePersonalJobPrice(sessionID, personalJobPrice(0))
      const queueID = SessionMessage.ID.create()
      const steerID = SessionMessage.ID.create()
      yield* core.prompt({
        id: queueID,
        sessionID,
        prompt: { text: "Unrelated queued user task" },
        delivery: "queue",
        resume: false,
      })
      yield* core.prompt({
        id: steerID,
        sessionID,
        prompt: { text: "Unrelated user steering input" },
        delivery: "steer",
        resume: false,
      })
      const created = yield* jobs.create({
        idempotencyKey: PersonalJob.IdempotencyKey.make("formal-job-input-isolation"),
        sessionID,
        title: PersonalJob.Title.make("Own input only"),
        prompt: PersonalJob.Prompt.make("Handle only this background occurrence."),
        schedule: {
          kind: "once",
          label: "Fixture",
          nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
          timezone: "UTC",
        },
        budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostMicros: 1_000_000 },
        approvalPolicy: { mode: "automatic", rationale: "Explicit test job" },
        notificationPolicy: { mode: "none", events: [] },
      })
      yield* llm.text("Only the background job result")
      const result = yield* executor.execute({ jobID: created.id, expectedRevision: created.revision })
      expect(result.result?.summary).toBe("Only the background job result")
      expect(yield* llm.calls).toBe(1)
      expect((yield* SessionInput.find(db, queueID))?.promotedSeq).toBeUndefined()
      expect((yield* SessionInput.find(db, steerID))?.promotedSeq).toBeUndefined()
      expect((yield* runs.list({ sessionID })).length).toBe(1)
      yield* llm.text("Ordinary steering answer")
      yield* llm.text("Ordinary queued answer")
      yield* core.resume(sessionID)
      expect(yield* llm.calls).toBe(3)
      expect((yield* SessionInput.find(db, queueID))?.promotedSeq).toBeDefined()
      expect((yield* SessionInput.find(db, steerID))?.promotedSeq).toBeDefined()
      expect((yield* runs.list({ sessionID })).length).toBe(2)
      expect((yield* jobs.get(created.id)).result).toEqual(result.result)
    }),
  45_000,
)

testEffect(makeFormalIntegrationHttp({ realModels: true, personalJobs: true })).instance(
  "Formal PersonalJob keeps one input per occurrence and starts the next recurring occurrence",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const jobs = yield* PersonalJobV2.Service
      const executor = yield* PersonalJobExecutor.Service
      const runs = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "Pinned personal occurrence" })
      const sessionID = SessionV2.ID.make(chat.id)
      yield* usePersonalJobPrice(sessionID, personalJobPrice(0))
      const now = Date.now()
      const created = yield* jobs.create({
        idempotencyKey: PersonalJob.IdempotencyKey.make("formal-occurrence"),
        sessionID,
        title: PersonalJob.Title.make("Recurring review"),
        prompt: PersonalJob.Prompt.make("Review this occurrence without creating duplicate work."),
        schedule: {
          kind: "cron",
          label: "Fixture recurrence",
          cron: ScheduledPrompt.Cron.make("* * * * *"),
          nextRunAt: DateTime.makeUnsafe(now - 1_000),
          timezone: "UTC",
        },
        budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostMicros: 1_000_000 },
        approvalPolicy: { mode: "automatic", rationale: "Explicit local test task" },
        notificationPolicy: { mode: "none", events: [] },
      })
      yield* llm.text("First occurrence verified")
      const first = yield* executor.execute({ jobID: created.id, expectedRevision: created.revision })
      expect(first.status).toBe("completed")
      expect(first.result?.summary).toContain("First occurrence verified")
      expect(first.occurrence?.messageID).toBeDefined()
      expect(yield* jobs.tick({ sessionID, now: Date.now() })).toBe(1)
      const queued = yield* jobs.get(created.id)
      expect(queued.occurrence?.messageID).not.toBe(first.occurrence?.messageID)
      yield* llm.text("Second occurrence verified")
      const second = yield* executor.execute({ jobID: queued.id, expectedRevision: queued.revision })
      expect(second.status).toBe("completed")
      expect(second.result?.summary).toContain("Second occurrence verified")
      expect(second.occurrence).toEqual(queued.occurrence)
      expect(yield* llm.calls).toBe(2)
      if (!first.occurrence || !second.occurrence) return yield* Effect.die("Durable occurrence bindings missing")
      const history = yield* core.context(sessionID)
      expect(history.filter((item) => item.type === "user").map((item) => item.id)).toEqual([
        first.occurrence.messageID,
        second.occurrence.messageID,
      ])
      expect(history.filter((item) => item.type === "assistant")).toHaveLength(2)
      expect(yield* SessionInput.listQueued(db, sessionID)).toHaveLength(0)
      const executions = yield* runs.list({ sessionID })
      expect(executions).toHaveLength(2)
      expect(executions.every((item) => item.run.status === "completed" && !item.activeAttempt && !item.lease)).toBe(
        true,
      )
      expect((yield* (yield* SessionExecution.Service).active).has(sessionID)).toBe(false)
      return yield* Effect.void
    }),
  45_000,
)

credentialIntegration.instance(
  "Formal scoped execution does not pass credentials billing or observers to queued ordinary work",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const credentials = yield* Credential.Service
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const execution = yield* SessionExecution.Service
      const runs = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const credential = yield* credentials.create({
        integrationID: Integration.ID.make("test"),
        value: Credential.Key.make({ type: "key", key: "fixture-one-run-key" }),
      })
      const chat = yield* sessions.create({ title: "Pinned scoped execution" })
      const sessionID = SessionV2.ID.make(chat.id)
      const settled = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
      const observations: string[] = []
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-one-run-budget",
        currency: "USD",
        minorUnit: 2,
        unit: "token",
        effectiveFrom: DateTime.makeUnsafe(0),
        source: "fixture:one-run-scope",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Complete only this explicitly scoped request." }],
      })
      yield* llm.text("Scoped request complete", { usage: { input: 2, output: 3 } })
      yield* llm.text("Ordinary follow-up complete", { usage: { input: 5, output: 7 } })
      const first = yield* execution
        .resumeWith({
          sessionID,
          options: {
            credentialIDs: [credential.id],
            billing: { budget: { currency: "USD", limitMinor: 1_000_000 }, resolveCatalog: () => catalog },
            onSettled: (summary) =>
              Effect.gen(function* () {
                observations.push(summary.runID)
                yield* Deferred.succeed(settled, undefined)
                yield* Deferred.await(release)
              }),
          },
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(settled).pipe(Effect.timeout("15 seconds"))
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Run this later input under the normal session policy." }],
      })
      const next = yield* execution.wakeAndWait(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
      expect(yield* llm.calls).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(next)]).pipe(Effect.timeout("15 seconds"))
      const history = (yield* runs.list({ sessionID, limit: Number.MAX_SAFE_INTEGER })).filter(
        (item): item is DurableRun.SessionSnapshot => "sessionID" in item.run,
      )
      expect(history).toHaveLength(2)
      expect(history.every((item) => item.run.status === "completed" && item.run.budget.attemptsUsed === 1)).toBe(true)
      const scoped = history.find((item) => item.run.id === observations[0])
      const ordinary = history.find((item) => item.run.id !== observations[0])
      if (!scoped || !ordinary) return yield* Effect.die(new Error("Original scoped and ordinary runs are required"))
      expect(scoped?.run.admission?.credentialIDs).toEqual([credential.id])
      expect(scoped?.run.admission?.billing?.budget).toEqual({ currency: "USD", limitMinor: 1_000_000 })
      expect(ordinary?.run.admission?.credentialIDs).toBeNull()
      expect(ordinary?.run.admission?.billing).toBeNull()
      expect(observations).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)
      const billed = (yield* db
        .select()
        .from(SessionRunUsageTable)
        .where(eq(SessionRunUsageTable.session_id, sessionID))
        .all()).filter((row) => row.billing_receipt !== null)
      expect(billed).toHaveLength(1)
      expect(billed[0]?.run_id).toBe(scoped.run.id)
      expect((yield* execution.active).has(sessionID)).toBe(false)
      expect(JSON.stringify(yield* (yield* SessionV2.Service).context(sessionID))).toContain(
        "Ordinary follow-up complete",
      )
      return yield* Effect.void
    }),
  45_000,
)

for (const target of ["primary", "summary"] as const)
  for (const change of ["unchanged", "replace", "remove"] as const) {
    credentialIntegration.instance(
      `Formal stored credential version fences HTTP: ${target}/${change}`,
      () =>
        Effect.gen(function* () {
          const { llm } = yield* useServerConfig((url) => ({
            ...providerCfg(url),
            compaction: { preserve_recent_tokens: 0 },
          }))
          const credentials = yield* Credential.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const events = yield* EventV2.Service
          const { db } = yield* Database.Service
          const credential = yield* credentials.create({
            integrationID: Integration.ID.make("test"),
            value: Credential.Key.make({ type: "key", key: "fixture-stored-key" }),
          })
          const chat = yield* sessions.create({ title: "Pinned credential verification" })
          const definition =
            target === "primary" ? SessionEvent.RequestEnvelopePrepared : SessionEvent.Compaction.RequestPrepared
          let published = false
          yield* events.project(definition, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== chat.id) return
              published = true
              if (change === "replace")
                yield* credentials.update(credential.id, {
                  value: Credential.Key.make({ type: "key", key: "fixture-replacement-key" }),
                })
              if (change === "remove") yield* credentials.remove(credential.id)
            }),
          )
          if (target === "summary") {
            yield* llm.error(413, { error: { message: "request entity too large" } })
            yield* llm.text("Verify credential binding.")
          }
          yield* llm.text("Credential accepted")
          const result = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                {
                  type: "text",
                  text: "Verify that my stored credential stays bound to this request while recovering from provider context overflow, preserving the task and completing the response.",
                },
              ],
            })
            .pipe(Effect.exit)
          expect(published).toBe(true)
          if (change === "unchanged" && Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
          expect(Exit.isSuccess(result)).toBe(change === "unchanged")
          if (Exit.isSuccess(result))
            expect(result.value.parts.some((part) => part.type === "text" && part.text === "Credential accepted")).toBe(
              true,
            )
          const hits = yield* llm.hits
          expect(hits).toHaveLength(
            target === "summary" ? (change === "unchanged" ? 3 : 1) : change === "unchanged" ? 1 : 0,
          )
          const rows = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(definition.type, 1)))
            .all()
          const records = rows
            .map((row) => Schema.decodeUnknownSync(definition.data)(row.data))
            .filter((record) => record.sessionID === chat.id)
          expect(records).toHaveLength(1)
          const record = records[0]!
          const envelope = parseRequestEnvelopeJson(record.envelope)
          expect(envelope.execution.credential_identity).toEqual({ id: credential.id, version: credential.version })
          expect(record.envelope).not.toContain("fixture-stored-key")
          expect(record.envelope).not.toContain("fixture-replacement-key")
          if (change === "unchanged")
            expect<unknown>(envelope.request.transmission?.body).toEqual(hits[target === "summary" ? 1 : 0]!.body)
        }),
      20000,
    )
  }

for (const target of ["primary", "summary"] as const)
  for (const boundary of ["before-reservation", "after-reservation"] as const)
    for (const change of ["replace", "remove"] as const)
      credentialIntegration.instance(
        `Formal credential billing boundary: ${target}/${boundary}/${change}`,
        () =>
          Effect.gen(function* () {
            const { llm } = yield* useServerConfig((url) => ({
              ...providerCfg(url),
              compaction: { preserve_recent_tokens: 0 },
            }))
            const credentials = yield* Credential.Service
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const execution = yield* SessionExecution.Service
            const events = yield* EventV2.Service
            const database = yield* Database.Service
            const { db } = database
            const credential = yield* credentials.create({
              integrationID: Integration.ID.make("test"),
              value: Credential.Key.make({ type: "key", key: "fixture-billed-key" }),
            })
            const chat = yield* sessions.create({ title: "Pinned billed credential check" })
            let changed = false
            let requestDigest: string | undefined
            const changeCredential = Effect.gen(function* () {
              changed = true
              if (change === "replace")
                yield* credentials.update(credential.id, {
                  value: Credential.Key.make({ type: "key", key: "fixture-billed-replacement" }),
                })
              else yield* credentials.remove(credential.id)
            })
            const definition =
              target === "primary" ? SessionEvent.RequestEnvelopePrepared : SessionEvent.Compaction.RequestPrepared
            yield* events.project(definition, (event) =>
              Effect.gen(function* () {
                if (event.data.sessionID !== chat.id) return
                requestDigest = event.data.requestDigest
                if (boundary === "before-reservation") yield* changeCredential
              }),
            )
            if (boundary === "after-reservation") {
              const original = database.transactionAsPrincipal
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  database.transactionAsPrincipal = original
                }),
              )
              database.transactionAsPrincipal = <A, E, R>(
                principal: Database.Principal,
                callback: (transaction: Database.Transaction) => Effect.Effect<A, E, R>,
              ) =>
                original(principal, callback).pipe(
                  Effect.tap((result) => {
                    if (
                      changed ||
                      !requestDigest ||
                      !result ||
                      typeof result !== "object" ||
                      !("phase" in result) ||
                      result.phase !== "reserved" ||
                      !("requestDigest" in result) ||
                      result.requestDigest !== requestDigest
                    )
                      return Effect.void
                    return changeCredential
                  }),
                )
            }
            yield* prompt.prompt({
              sessionID: chat.id,
              agent: "build",
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: "Verify that changing the credential before the model can send this task does not consume or strand my budget, including summary recovery after context overflow.",
                },
              ],
            })
            if (target === "summary") yield* llm.error(413, { error: { message: "request entity too large" } })
            const catalog = Billing.PriceCatalog.make({
              revision: "fixture-credential-boundary",
              currency: "USD",
              minorUnit: 2,
              unit: "token",
              effectiveFrom: DateTime.makeUnsafe(0),
              source: "fixture:credential-boundary",
              rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
            })
            let reconciliations = 0
            const result = yield* execution
              .resumeWith({
                sessionID: SessionV2.ID.make(chat.id),
                options: {
                  credentialIDs: [credential.id],
                  billing: {
                    budget: { currency: "USD", limitMinor: 1_000_000 },
                    resolveCatalog: () => catalog,
                    reconcileUsage: () => {
                      reconciliations++
                      return RuntimeBilling.fromStepTokens({
                        input: 2,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                      })
                    },
                  },
                },
              })
              .pipe(Effect.exit)
            expect(changed).toBe(true)
            expect(Exit.isFailure(result)).toBe(true)
            expect(yield* llm.calls).toBe(target === "summary" ? 1 : 0)
            expect(reconciliations).toBe(target === "summary" ? 1 : 0)
            const rows = (yield* db
              .select()
              .from(SessionRunUsageTable)
              .where(eq(SessionRunUsageTable.session_id, SessionV2.ID.make(chat.id)))
              .all()).filter((row) => row.billing_receipt !== null)
            expect(rows).toHaveLength((target === "summary" ? 1 : 0) + (boundary === "after-reservation" ? 1 : 0))
            expect(rows.every((row) => row.settlement_reservation_id === row.id)).toBe(true)
            const receipts = rows.map((row) => RuntimeBilling.decodeReceipt(row.billing_receipt))
            expect(receipts.reduce((sum, receipt) => sum + receipt.charge.amountMinor, 0)).toBe(
              target === "summary" ? 2 : 0,
            )
            expect(receipts.every((receipt) => receipt.settlement.state.activeReservationIDs.length === 0)).toBe(true)
            const blocked = receipts.filter((receipt) => receipt.requestDigest === requestDigest)
            expect(blocked).toHaveLength(boundary === "after-reservation" ? 1 : 0)
            if (blocked[0]) expect(blocked[0].charge.amountMinor).toBe(0)
          }),
        20000,
      )

for (const change of ["unchanged", "replace", "remove"] as const)
  credentialIntegration.instance(
    `Formal stored title credential version fences HTTP: ${change}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          agent: { title: { model: "test/test-model" } },
        }))
        const credentials = yield* Credential.Service
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const events = yield* EventV2.Service
        const jobs = yield* BackgroundJob.Service
        const { db } = yield* Database.Service
        const credential = yield* credentials.create({
          integrationID: Integration.ID.make("test"),
          value: Credential.Key.make({ type: "key", key: "fixture-title-stored-key" }),
        })
        const chat = yield* sessions.create()
        const definition = AgentRuntime.Event.ActionModelRequestPrepared
        let published = false
        yield* events.project(definition, (event) =>
          Effect.gen(function* () {
            if (event.data.sessionID !== chat.id) return
            published = true
            if (change === "replace")
              yield* credentials.update(credential.id, {
                value: Credential.Key.make({ type: "key", key: "fixture-title-replacement-key" }),
              })
            if (change === "remove") yield* credentials.remove(credential.id)
          }),
        )
        yield* llm.text("The primary answer remains available")
        yield* llm.text("Credential checked title")
        const answer = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Explain how credential revisions protect requests" }],
        })
        expect(
          answer.parts.some((part) => part.type === "text" && part.text === "The primary answer remains available"),
        ).toBe(true)
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Stored credential title job not registered",
        )
        const completion = yield* jobs.wait({ id: job.id, timeout: 5000 })
        expect(completion.info?.status).toBe(change === "unchanged" ? "completed" : "error")
        expect(published).toBe(true)
        const hits = yield* llm.hits
        expect(hits).toHaveLength(change === "unchanged" ? 2 : 1)
        expect((yield* sessions.get(chat.id)).title).toBe(
          change === "unchanged" ? "Credential checked title" : chat.title,
        )
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(definition.type, 1)))
          .all()
        const records = rows
          .map((row) => Schema.decodeUnknownSync(definition.data)(row.data))
          .filter((record) => record.sessionID === chat.id)
        expect(records).toHaveLength(1)
        const record = records[0]!
        const envelope = parseRequestEnvelopeJson(record.envelope)
        expect(envelope.execution.credential_identity).toEqual({ id: credential.id, version: credential.version })
        expect(record.envelope).not.toContain("fixture-title-stored-key")
        expect(record.envelope).not.toContain("fixture-title-replacement-key")
        if (change === "unchanged") expect<unknown>(envelope.request.transmission?.body).toEqual(hits[1]!.body)
      }),
    20000,
  )

for (const phase of ["prepared", "dispatching"] as const) {
  formalIntegration.instance(
    `Formal request dispatch recovery preserves HTTP identity: ${phase}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const execution = yield* SessionExecution.Service
        const { db } = yield* Database.Service
        const chat = yield* sessions.create({ title: "Pinned recovery verification" })
        const id = SessionV2.ID.make(chat.id)
        const runs = yield* DurableRun.Service
        let enabled = true
        let pausedAtBoundary = false
        const original = db.transaction
        const transact = original.bind(db)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.transaction = original
          }),
        )
        db.transaction = (callback, options) =>
          transact(callback, options).pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                if (!enabled || !result || typeof result !== "object" || !("event" in result)) return
                const event = result.event
                if (
                  !event ||
                  typeof event !== "object" ||
                  !("type" in event) ||
                  event.type !== AgentRuntime.Event.RunCheckpointCreated.type ||
                  !("data" in event)
                )
                  return
                const data = Schema.decodeUnknownSync(Schema.toType(AgentRuntime.Event.RunCheckpointCreated.data))(
                  event.data,
                )
                if (data.sessionID !== id) return
                const cursor = SessionCheckpoint.fromContainer(data.checkpoint.state, id)
                if (
                  cursor &&
                  !cursor.legacy &&
                  cursor.kind === SessionCheckpoint.KIND &&
                  cursor.dispatch?.phase === phase
                ) {
                  pausedAtBoundary = true
                  return yield* Effect.interrupt
                }
              }),
            ),
          )
        yield* llm.text("The original prepared HTTP request was recovered")
        const initial = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "Recover this exact HTTP request" }],
          })
          .pipe(Effect.exit)
        enabled = false
        if (!pausedAtBoundary)
          throw new Error(
            Exit.isFailure(initial)
              ? Cause.pretty(initial.cause)
              : "Request completed without reaching the dispatch boundary",
          )
        expect<boolean>(pausedAtBoundary).toBe(true)
        expect(Exit.isFailure(initial)).toBe(true)
        expect(yield* llm.hits).toHaveLength(0)
        const paused = (yield* runs.recoverable(id))[0]!
        const rows = yield* EventV2.readSerialized(db, {
          aggregateIDs: [id],
          types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
        })
        expect(rows).toHaveLength(1)
        const envelope = parseRequestEnvelopeJson(String(rows[0]!.data.envelope))
        const resumed = yield* execution.resume(id).pipe(Effect.exit)
        if (phase === "prepared")
          expect(Exit.isFailure(resumed) ? Cause.pretty(resumed.cause) : "success").toBe("success")
        else expect(Exit.isFailure(resumed) && Cause.pretty(resumed.cause)).toContain("may already have been sent")
        const hits = yield* llm.hits
        expect(hits).toHaveLength(phase === "prepared" ? 1 : 0)
        expect(
          yield* EventV2.readSerialized(db, {
            aggregateIDs: [id],
            types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
          }),
        ).toEqual(rows)
        const after = yield* runs.load(paused.run.id)
        expect(after.run.status).toBe(phase === "prepared" ? "completed" : "paused")
        if (phase === "prepared") {
          expect<unknown>(envelope.request.transmission?.body).toEqual(hits[0]!.body)
          const endpoint = new URL(envelope.request.transmission!.endpoint.url)
          expect(endpoint.origin).toBe(new URL(llm.url).origin)
          expect(endpoint.pathname + endpoint.search).toBe(hits[0]!.url.pathname + hits[0]!.url.search)
          const locations = yield* LocationServiceMap.Service
          const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
          const coreSessions = yield* SessionV2.Service.pipe(Effect.provide(location))
          expect(JSON.stringify(yield* coreSessions.context(id))).toContain(
            "The original prepared HTTP request was recovered",
          )
        } else expect(after.checkpoint).toEqual(paused.checkpoint)
      }),
    30000,
  )
}

for (const scenario of ["success", "defaults-mutation", "publish-failure", "changed-row"] as const) {
  formalIntegration.instance(
    `Formal HTTP transmission matches the committed request envelope: ${scenario}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const { db } = yield* Database.Service
        const chat = yield* sessions.create({ title: "Pinned transmission verification" })
        const succeeds = scenario === "success" || scenario === "defaults-mutation"
        let changedDefaults = false
        if (scenario === "defaults-mutation") {
          const locations = yield* LocationServiceMap.Service
          const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
          const events = yield* EventV2.Service
          const models = yield* SessionRunnerModel.Service.pipe(Effect.provide(location))
          const coreSessions = yield* SessionV2.Service.pipe(Effect.provide(location))
          yield* events.project(SessionEvent.RequestEnvelopePrepared, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== chat.id) return
              const selected = yield* models.resolve(yield* coreSessions.get(event.data.sessionID))
              Object.assign(selected.route.defaults.generation!, { temperature: 0.9 })
              changedDefaults = true
            }).pipe(Effect.orDie),
          )
        }
        if (!succeeds) {
          yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS formal_request_fault`).pipe(Effect.orDie))
          if (scenario === "publish-failure") {
            yield* db
              .run(
                sql`CREATE TEMP TRIGGER formal_request_fault BEFORE INSERT ON event
            WHEN NEW.type = 'session.next.request.envelope.prepared.1'
            BEGIN SELECT RAISE(ABORT, 'fixture envelope publication failure'); END`,
              )
              .pipe(Effect.orDie)
          } else {
            yield* db
              .run(
                sql`CREATE TEMP TRIGGER formal_request_fault AFTER INSERT ON event
            WHEN NEW.type = 'session.next.request.envelope.prepared.1'
            BEGIN UPDATE event SET data = json_set(data, '$.envelope', '{}') WHERE id = NEW.id; END`,
              )
              .pipe(Effect.orDie)
          }
        }
        yield* llm.text("The prepared request was received")
        const result = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            parts: [{ type: "text", text: "Verify the actual HTTP request against durable state" }],
          })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(result)).toBe(succeeds)
        const hits = yield* llm.hits
        expect(hits).toHaveLength(succeeds ? 1 : 0)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)))
          .all()
        const records = rows
          .map((row) => Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(row.data))
          .filter((record) => record.sessionID === chat.id)
        expect(records).toHaveLength(scenario === "publish-failure" ? 0 : 1)
        if (scenario === "changed-row") expect(records[0]?.envelope).toBe("{}")
        if (succeeds) {
          const record = records[0]!
          const envelope = parseRequestEnvelopeJson(record.envelope)
          expect(envelope.request_digest).toBe(record.requestDigest)
          expect(envelope.request.transmission).toBeDefined()
          expect<unknown>(envelope.request.transmission!.body).toEqual(hits[0]!.body)
          const endpoint = new URL(envelope.request.transmission!.endpoint.url)
          expect(endpoint.origin).toBe(new URL(llm.url).origin)
          expect(endpoint.pathname + endpoint.search).toBe(hits[0]!.url.pathname + hits[0]!.url.search)
          expect(record.envelope).not.toContain("test-key")
          if (scenario === "defaults-mutation") {
            expect(changedDefaults).toBe(true)
            expect(hits[0]!.body.temperature).toBe(0)
          }
          if (Exit.isSuccess(result)) {
            expect(result.value.info.role).toBe("assistant")
            expect(
              result.value.parts.some(
                (part) => part.type === "text" && part.text === "The prepared request was received",
              ),
            ).toBe(true)
          }
        }
      }),
    20000,
  )
}

formalIntegration.instance(
  "Formal first user turn preserves a user-defined session title",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "My cache investigation" })
      yield* llm.text("The cache key needs investigation")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Help investigate the cache invalidation bug" }],
      })
      expect(result.info.role).toBe("assistant")
      expect((yield* sessions.get(chat.id)).title).toBe("My cache investigation")
      expect(yield* llm.calls).toBe(1)
    }),
  20000,
)

formalIntegration.instance(
  "Formal first user turn generates a title for a default-title session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create()
      expect(Session.isDefaultTitle(chat.title)).toBe(true)
      // Maintenance starts after the main run settles; its provider receipt
      // must be retained independently of the main assistant's token totals.
      yield* llm.text("Investigate cache invalidation")
      yield* llm.text("Investigate cache invalidation", { usage: { input: 12, output: 3 } })
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Help investigate the cache invalidation bug" }],
      })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "Investigate cache invalidation")).toBe(
        true,
      )
      const titled = yield* pollWithTimeout(
        sessions
          .get(chat.id)
          .pipe(Effect.map((session) => (Session.isDefaultTitle(session.title) ? undefined : session))),
        "Formal first turn did not generate a session title",
      )
      expect(titled.title).toBe("Investigate cache invalidation")
      expect(yield* llm.calls).toBe(2)
      const actions = yield* (yield* DurableAction.Service).list({ sessionID: DurableSessionSchema.ID.make(chat.id) })
      const title = actions.find((item) => item.action.name === "session.title")
      expect(title?.action.status).toBe("settled")
      expect(title?.action.budget.tokensUsed).toBe(15)
      expect(title?.action.budget.attemptsUsed).toBe(1)
      expect(title?.modelRequest).toBeDefined()
      const titleRequest = parseRequestEnvelopeJson(title!.modelRequest!.envelope)
      expect(titleRequest.request.transmission).toBeDefined()
      const titleHits = yield* llm.hits
      expect<unknown>(titleRequest.request.transmission!.body).toEqual(titleHits[1]!.body)
      expect(title!.action.inputDigest).toBe(titleRequest.request_digest)
      expect(title!.modelRequest!.envelope).not.toContain("test-key")
      expect(title?.action.runID).toBeUndefined()
      const jobs = yield* BackgroundJob.Service
      expect((yield* jobs.wait({ id: String(title!.action.id), timeout: 5000 })).info?.status).toBe("completed")
      const execution = yield* SessionExecution.Service
      yield* execution.wakeAndWait(SessionV2.ID.make(chat.id))
      yield* execution.wakeAndWait(SessionV2.ID.make(chat.id))
      expect(yield* llm.calls).toBe(2)
    }),
  20000,
)

for (const projection of [
  "lost",
  "renamed",
  "different-default",
  "fresh-process",
  "updated",
  "rename-back",
  "fresh-process-rename-back",
  "fresh-process-estimated",
] as const)
  formalIntegration.instance(
    `Formal idle wake handles ${projection} title projection without a new run or provider call`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const runs = yield* DurableRun.Service
        const actions = yield* DurableAction.Service
        const chat = yield* sessions.create()
        const id = SessionV2.ID.make(chat.id)
        yield* llm.text("Main answer")
        yield* llm.text(
          "Recovered cache title",
          projection === "fresh-process-estimated" ? undefined : { usage: { input: 12, output: 3 } },
        )
        yield* (yield* SessionPrompt.Service).prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Investigate cache invalidation" }],
        })
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Title job missing",
        )
        expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe("completed")
        const beforeRuns = yield* runs.list({ sessionID: id })
        const beforeActions = yield* actions.list({ sessionID: id })
        expect(
          beforeActions.find((item) => item.action.name === "session.title")?.observation?.output?.value,
        ).toMatchObject({
          version: 1,
          sessionID: id,
          expectedTitle: chat.title,
          title: "Recovered cache title",
          usage: { source: projection === "fresh-process-estimated" ? "estimated" : "provider" },
        })
        if (projection === "updated") yield* sessions.touch(chat.id)
        if (projection === "rename-back" || projection === "fresh-process-rename-back") {
          yield* sessions.setTitle({ sessionID: chat.id, title: "My chosen title" })
          yield* sessions.setTitle({ sessionID: chat.id, title: chat.title })
        }
        // Isolated materialized-view loss, not a claim of killing a real worker.
        const { db } = yield* Database.Service
        const replacement =
          projection !== "renamed" && projection !== "different-default"
            ? chat.title
            : projection === "renamed"
              ? "My new title"
              : "新会话 - 2026-09-09T00:00:00.000Z"
        yield* db.update(SessionTable).set({ title: replacement }).where(eq(SessionTable.id, id)).run()
        if (
          projection === "fresh-process" ||
          projection === "fresh-process-rename-back" ||
          projection === "fresh-process-estimated"
        ) {
          const fixture = yield* TestInstance
          const copyPath = path.join(fixture.directory, "title-recovery.sqlite")
          yield* db.run(sql`VACUUM INTO ${copyPath}`)
          const worker = Bun.spawn(
            [
              process.execPath,
              fileURLToPath(new URL("../fixture/title-recovery-worker.ts", import.meta.url)),
              copyPath,
              fixture.directory,
              String(chat.projectID),
              String(id),
              projection !== "fresh-process-rename-back" ? "Recovered cache title" : chat.title,
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          yield* Effect.addFinalizer(() => Effect.sync(() => worker.kill()))
          const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
            Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]),
          )
          expect(stderr).toBe("")
          expect(exitCode).toBe(0)
          expect(stdout).toContain('"historyUnchanged":true')
          expect(stdout).toContain('"providerCalls":0')
          expect((yield* sessions.get(chat.id)).title).toBe(chat.title)
        }
        const execution = yield* SessionExecution.Service
        yield* execution.wakeAndWait(id)
        expect((yield* sessions.get(chat.id)).title).toBe(
          projection === "lost" ||
            projection === "fresh-process" ||
            projection === "updated" ||
            projection === "fresh-process-estimated"
            ? "Recovered cache title"
            : replacement,
        )
        yield* execution.wakeAndWait(id)
        expect(yield* llm.calls).toBe(2)
        expect(yield* actions.list({ sessionID: id })).toEqual(beforeActions)
        expect(yield* runs.list({ sessionID: id })).toEqual(beforeRuns)
      }),
    30000,
  )

for (const titleModelMode of ["explicit", "small", "automatic", "disabled"] as const)
  formalIntegration.instance(
    `Formal title agent configuration is ${titleModelMode === "disabled" ? "disabled" : titleModelMode === "small" ? "migrated from small_model" : titleModelMode === "automatic" ? "selected by the shared small-model resolver" : "used for model and prompt"}`,
    () =>
      Effect.gen(function* () {
        const disabled = titleModelMode === "disabled"
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          small_model: titleModelMode === "automatic" ? undefined : "test/small-title-model",
          agent: {
            title: disabled
              ? { disable: true }
              : {
                  model: titleModelMode === "small" || titleModelMode === "automatic" ? undefined : "test/title-model",
                  prompt: "Generate a short cache label in Chinese.",
                },
          },
        }))
        const sessions = yield* Session.Service
        const chat = yield* sessions.create()
        yield* llm.text("Main answer")
        if (!disabled) yield* llm.text("缓存调查", { usage: { input: 12, output: 3 } })
        yield* (yield* SessionPrompt.Service).prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Investigate the cache" }],
        })
        if (!disabled) {
          yield* pollWithTimeout(
            sessions.get(chat.id).pipe(Effect.map((item) => (item.title === "缓存调查" ? true : undefined))),
            "Configured title was not generated",
          )
          const inputs = yield* llm.inputs
          expect(inputs[1]?.model).toBe(
            titleModelMode === "small"
              ? "small-title-model"
              : titleModelMode === "automatic"
                ? "test-auto-mini"
                : "title-model",
          )
          expect(JSON.stringify(inputs[1]?.messages)).toContain("Generate a short cache label in Chinese.")
        } else {
          expect((yield* sessions.get(chat.id)).title).toBe(chat.title)
          expect(
            (yield* (yield* BackgroundJob.Service).list()).filter(
              (item) => item.type === "session-title" && item.metadata?.sessionId === chat.id,
            ),
          ).toEqual([])
        }
        expect(yield* llm.calls).toBe(disabled ? 1 : 2)
      }),
    20000,
  )

for (const failure of ["empty-output", "missing-usage", "empty-output-without-usage"] as const)
  formalIntegration.instance(
    `Formal title ${failure} does not fail the primary answer or retry the model`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const jobs = yield* BackgroundJob.Service
        const chat = yield* sessions.create()
        yield* llm.text("Primary answer remains usable")
        yield* llm.text(
          failure !== "missing-usage" ? "" : "A usable title",
          failure === "empty-output" ? { usage: { input: 12, output: 3 } } : undefined,
        )
        const result = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Investigate the cache" }],
        })
        expect(result.parts.some((part) => part.type === "text" && part.text === "Primary answer remains usable")).toBe(
          true,
        )
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Title job not registered",
        )
        expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe(
          failure === "missing-usage" ? "completed" : "error",
        )
        expect((yield* sessions.get(chat.id)).title).toBe(failure === "missing-usage" ? "A usable title" : chat.title)
        const actions = yield* (yield* DurableAction.Service).list({ sessionID: SessionV2.ID.make(chat.id) })
        const title = actions.find((item) => item.action.name === "session.title")
        expect(title?.action.status).toBe(failure === "missing-usage" ? "settled" : "blocked")
        expect(title?.action.budget.attemptsUsed).toBe(1)
        expect(title?.observation?.status).toBe(
          failure === "empty-output" ? "failed" : failure === "missing-usage" ? "succeeded" : undefined,
        )
        if (failure === "missing-usage") {
          expect(title?.observation?.output?.value).toMatchObject({
            usage: { source: "estimated", estimatorID: "arforge:chars-per-token-v1", tokens: { textOutput: 256 } },
          })
          expect(title?.action.budget.tokensUsed).toBeGreaterThan(256)
          const { db } = yield* Database.Service
          if (!title) throw new Error("Title Action is missing")
          const stored = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, title.action.id)).all()
          const metered = stored.filter((row) => Object.hasOwn(row.data, "tokens"))
          expect(metered).toHaveLength(1)
          expect(metered[0]?.data.tokens).toBe(title.action.budget.tokensUsed)
          expect(metered.some((row) => Object.hasOwn(row.data, "costMicros"))).toBe(false)
        }
        expect(
          (yield* (yield* DurableRun.Service).list({ sessionID: SessionV2.ID.make(chat.id) })).map(
            (item) => item.run.status,
          ),
        ).toEqual(["completed"])
        yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
        expect(yield* llm.calls).toBe(2)
        expect(yield* (yield* DurableAction.Service).list({ sessionID: SessionV2.ID.make(chat.id) })).toEqual(actions)
      }),
    20000,
  )

for (const failure of ["publish-failure", "changed-row"] as const)
  formalIntegration.instance(
    `Formal title request persistence failure prevents HTTP: ${failure}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const jobs = yield* BackgroundJob.Service
        const { db } = yield* Database.Service
        const chat = yield* sessions.create()
        yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS title_request_fault`).pipe(Effect.orDie))
        if (failure === "publish-failure") {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER title_request_fault BEFORE INSERT ON event
        WHEN NEW.type = 'agent.action.model-request-prepared.1'
        BEGIN SELECT RAISE(ABORT, 'fixture title publication failure'); END`,
            )
            .pipe(Effect.orDie)
        } else {
          yield* db
            .run(
              sql`CREATE TEMP TRIGGER title_request_fault AFTER INSERT ON event
        WHEN NEW.type = 'agent.action.model-request-prepared.1'
        BEGIN UPDATE event SET data = json_set(data, '$.envelope', '{}') WHERE id = NEW.id; END`,
            )
            .pipe(Effect.orDie)
        }
        yield* llm.text("Main answer remains available")
        const answer = yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Explain caching" }],
        })
        expect(answer.parts.some((part) => part.type === "text" && part.text === "Main answer remains available")).toBe(
          true,
        )
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Title job not registered",
        )
        expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe("error")
        expect(yield* llm.calls).toBe(1)
        expect((yield* sessions.get(chat.id)).title).toBe(chat.title)
      }),
    20000,
  )

for (const intervention of ["rename", "rename-back", "cancel"] as const)
  formalIntegration.instance(
    `Formal title generation honors ${intervention} while the provider is running`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const jobs = yield* BackgroundJob.Service
        const chat = yield* sessions.create()
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        yield* llm.text("Main answer")
        yield* llm.push(
          reply().wait(deferredAsPromise(release)).text("Generated cache title").usage({ input: 12, output: 3 }).stop(),
        )
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Cache investigation" }],
        })
        yield* awaitWithTimeout(llm.wait(2), "Title provider did not start")
        if (intervention !== "cancel") {
          yield* sessions.setTitle({ sessionID: chat.id, title: "My chosen title" })
          if (intervention === "rename-back") yield* sessions.setTitle({ sessionID: chat.id, title: chat.title })
        } else yield* prompt.cancel(chat.id)
        yield* Deferred.succeed(release, undefined)
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Title job not registered",
        )
        expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe(
          intervention !== "cancel" ? "completed" : "cancelled",
        )
        expect((yield* sessions.get(chat.id)).title).toBe(intervention === "rename" ? "My chosen title" : chat.title)
        expect(
          (yield* (yield* DurableRun.Service).list({ sessionID: SessionV2.ID.make(chat.id) })).map(
            (item) => item.run.status,
          ),
        ).toEqual(["completed"])
        expect(yield* llm.calls).toBe(2)
      }),
    20000,
  )

formalIntegration.instance(
  "Formal completed stop turn ignores repeated wakes without another provider request",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const execution = yield* SessionExecution.Service
      const core = yield* SessionV2.Service
      const id = SessionV2.ID.make(chat.id)
      yield* llm.text("completed once")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
      const before = yield* core.context(id)
      const assistants = before.filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(1)
      expect(assistants[0]?.finish).toBe("stop")
      expect(yield* llm.hits).toHaveLength(1)

      yield* execution.wakeAndWait(id)
      yield* execution.wakeAndWait(id)

      expect(yield* core.context(id)).toEqual(before)
      expect(yield* llm.hits).toHaveLength(1)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  15_000,
)

formalIntegration.instance(
  "Formal drain executes an admission-only prompt once",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      expect(yield* llm.hits).toHaveLength(0)
      yield* llm.text("world")

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const assistants = context.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(1)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
      const parts = assistants[0].content.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
  30_000,
)

it.instance("admit persists a user turn without starting the provider loop", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    const admitted = yield* prompt.admit({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "accepted by the single execution owner" }],
    })
    const stored = yield* sessions.messages({ sessionID: chat.id })

    expect(admitted.info.role).toBe("user")
    expect(stored.some((message) => message.info.id === admitted.info.id)).toBeTrue()
    expect(stored.some((message) => message.info.role === "assistant")).toBeFalse()
    const durable = yield* SessionInput.find(db, SessionMessage.ID.make(admitted.info.id))
    expect(durable).toMatchObject({
      id: admitted.info.id,
      sessionID: chat.id,
      delivery: "steer",
      prompt: {
        text: "accepted by the single execution owner",
        route: { agent: "build" },
      },
    })
    expect(durable?.promotedSeq).toBeUndefined()
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

formalIntegration.instance(
  "Formal freezes request-scoped system prompts into canonical admission and applies them exactly once",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const admitted = yield* prompt.admit({
        sessionID: chat.id,
        agent: "build",
        system: "request-scoped system contract",
        parts: [{ type: "text", text: "keep exact system semantics" }],
      })

      expect(admitted.info).toMatchObject({ role: "user", system: "request-scoped system contract" })
      expect(yield* SessionInput.find(db, SessionMessage.ID.make(admitted.info.id))).toMatchObject({
        id: admitted.info.id,
        sessionID: chat.id,
        delivery: "steer",
        prompt: {
          text: "keep exact system semantics",
          system: { text: "request-scoped system contract", source: "request", scope: "turn" },
        },
      })

      yield* llm.text("system contract applied")
      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const result = context.findLast((message) => message.type === "assistant")
      const hits = yield* llm.hits
      const request = JSON.stringify(hits[0]?.body ?? {})
      expect(result?.content).toContainEqual(expect.objectContaining({ type: "text", text: "system contract applied" }))
      expect(hits).toHaveLength(1)
      expect(request.split("request-scoped system contract")).toHaveLength(2)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
    }),
)

it.instance("freezes slash-command admission with the resolved text and original command identity", () =>
  Effect.gen(function* () {
    yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { review: { template: "Review $ARGUMENTS carefully" } },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    const admitted = yield* prompt.admitCommand({
      sessionID: chat.id,
      command: "review",
      arguments: "src/index.ts",
      agent: "build",
    })
    const durable = yield* SessionInput.find(db, SessionMessage.ID.make(admitted.message.info.id))

    expect(durable?.prompt).toMatchObject({
      text: "Review src/index.ts carefully",
      command: { name: "review", arguments: "src/index.ts" },
      route: { agent: "build" },
    })
  }),
)

it.instance("freezes automatic subtask commands as one canonical scheduled-task identity", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: {
        review: {
          template: "Review $ARGUMENTS carefully",
          description: "Workspace review",
          agent: "general",
          subtask: true,
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    const admitted = yield* prompt.admitCommand({
      sessionID: chat.id,
      command: "review",
      arguments: "src/index.ts",
      agent: "build",
    })
    const source = admitted.message.parts.find((part): part is SessionV1.SubtaskPart => part.type === "subtask")
    const durable = yield* SessionInput.find(db, SessionMessage.ID.make(admitted.message.info.id))

    expect(source).toBeDefined()
    expect(durable?.prompt).toMatchObject({
      text: "Review src/index.ts carefully",
      command: { name: "review", arguments: "src/index.ts" },
      route: { agent: "build" },
      scheduledTasks: [
        {
          id: source?.id,
          prompt: "Review src/index.ts carefully",
          description: "Workspace review",
          agent: "general",
          model: { providerID: "test", id: "test-model" },
          command: "review",
        },
      ],
    })
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

for (const entry of ["prompt", "command"] as const)
  it.instance(`public ${entry} rejects a missing canonical owner before admission`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      const result = yield* Effect.exit(
        entry === "prompt"
          ? prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Must not admit" }] })
          : prompt.command({ sessionID: chat.id, command: "missing", arguments: "" }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("canonical SessionExecution owner")
      expect(yield* (yield* Session.Service).messages({ sessionID: chat.id })).toHaveLength(0)
      expect(yield* llm.hits).toHaveLength(0)
    }),
  )

for (const entry of ["prompt", "command"] as const)
  formalIntegration.instance(
    `Formal public ${entry} must use the canonical executor rather than the legacy loop`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          command: { canonical: { template: "Reply once" } },
        }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const chat = yield* sessions.create({ title: "Canonical public prompt" })
        yield* llm.text("Canonical response")
        const result = yield* (
          entry === "command"
            ? prompt.command({ sessionID: chat.id, command: "canonical", arguments: "" })
            : prompt.prompt({
                sessionID: chat.id,
                agent: "build",
                parts: [{ type: "text", text: "Reply once" }],
              })
        ).pipe(Effect.timeout("20 seconds"))
        const context = yield* core.context(SessionV2.ID.make(chat.id))
        expect(context.filter((message) => message.type === "assistant")).toHaveLength(1)
        expect(result.info.role).toBe("assistant")
        expect(result.parts.some((part) => part.type === "text" && part.text.includes("Canonical response"))).toBe(true)
        expect(
          (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
        ).toHaveLength(0)
        expect(yield* llm.hits).toHaveLength(1)
      }),
    30_000,
  )

formalIntegration.instance(
  "Formal model task cannot delegate to a denied subagent",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const chat = yield* sessions.create({
        title: "Denied model delegation",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "task", pattern: "general", action: "deny" },
        ],
      })
      yield* prompt.admit({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "Review" }] })
      yield* llm.push(reply().tool("task", { description: "review", prompt: "Review", subagent_type: "general" }))
      yield* llm.text("Delegation denied")
      yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.timeout("20 seconds"))
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(yield* llm.hits).toHaveLength(2)
      const messages = yield* core.context(SessionV2.ID.make(chat.id))
      const task = messages
        .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool" && part.name === "task")
      expect(task).toMatchObject({ type: "tool", state: { status: "error" } })
    }),
  30_000,
)

formalIntegration.instance(
  "Formal model task delegates and follows up in the same child session without a legacy processor",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const durable = yield* DurableRun.Service
      const chat = yield* sessions.create({
        title: "Model task continuation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.admit({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Delegate the review" }],
      })
      yield* llm.push(
        reply().tool("task", { description: "review", prompt: "Review the file", subagent_type: "general" }),
      )
      yield* llm.text("First child review")
      yield* llm.text("First parent summary")
      yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.timeout("20 seconds"))
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      const childID = children[0].id
      yield* prompt.admit({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Ask that child to check again" }],
      })
      yield* llm.push(
        reply().tool("task", {
          description: "followup",
          prompt: "Check again",
          subagent_type: "general",
          task_id: childID,
        }),
      )
      yield* llm.text("Followup child review")
      yield* llm.text("Followup parent summary")
      yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.timeout("20 seconds"))
      expect((yield* sessions.children(chat.id)).map((child) => child.id)).toEqual([childID])
      expect(yield* llm.hits).toHaveLength(6)
      const childContext = yield* core.context(SessionV2.ID.make(childID))
      expect(childContext.filter((message) => message.type === "assistant")).toHaveLength(2)
      expect(JSON.stringify(childContext)).toContain("Followup child review")
      for (const sessionID of [chat.id, childID]) {
        expect(
          (yield* sessions.messages({ sessionID })).filter((message) => message.info.role === "assistant"),
        ).toHaveLength(0)
      }
      const runs = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
      expect(runs).toHaveLength(2)
      for (const run of runs) {
        expect(run.run.status).toBe("completed")
        expect(run.run.budget.attemptsUsed).toBe(1)
        expect(run.activeAttempt).toBeUndefined()
        expect(run.lease).toBeUndefined()
      }
    }),
  60_000,
)

for (const abandonedState of ["draft", "preflight", "queued", "running", "completed", "failed"] as const)
  formalIntegration.instance(
    `Formal scanner resumes an orphaned ${abandonedState} child through its original task owner`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const runs = yield* DurableRun.Service
        const core = yield* SessionV2.Service
        const chat = yield* sessions.create({
          title: "Orphan recovery",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const parent = yield* runs.create({
          sessionID: chat.id,
          initiator: "agent",
          authority: "automatic",
          riskTier: "L0",
          reasonSummary: "recovery fixture",
          budget: AgentRuntime.Budget.make({
            maxAttempts: 5,
            maxDurationMs: 1_800_000,
            maxCostMicros: 3_000_000,
            maxTokens: 1_000_000,
            attemptsUsed: 0,
            durationMsUsed: 0,
            costMicrosUsed: 0,
            tokensUsed: 0,
          }),
          traceID: "orphan-fixture",
          visibility: "details",
          location: AbsolutePath.make(chat.directory),
          delegableCapabilities: [{ action: "*", resources: ["*"], access: "read" }],
        })
        yield* runs.acquireLease({ runID: parent.run.id, ownerID: "fixture-parent", ttlMs: 60_000 })
        for (const to of ["preflight", "queued", "running"] as const)
          yield* runs.transition({ runID: parent.run.id, to, reason: "fixture" })
        const messageID = MessageID.ascending()
        const callID = "orphan-task"
        const actionID = AgentRuntime.ActionID.make("act_orphan_task_fixture")
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
        yield* Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const runtime = yield* TaskRuntime
          yield* gateway.execute(
            {
              actionID,
              runID: parent.run.id,
              sessionID: chat.id,
              assistantMessageID: SessionMessage.ID.make(messageID),
              toolCallID: callID,
              agent: AgentV2.ID.make("build"),
              name: "task",
              resources: ["general"],
              reasonSummary: "fixture admitted task",
              inputDigest: "fixture-orphan-task",
              semantics: AgentRuntime.EffectSemantics.make({
                riskTier: "L0",
                authority: "automatic",
                idempotency: "idempotent",
                retryability: "safe",
                reversibility: "not_applicable",
                filesystemScope: [],
                networkScope: [],
                secretScope: [],
                externalServices: [],
                expectedArtifacts: [],
                successCriteria: ["fixture handoff"],
              }),
            },
            {
              execute: () =>
                runtime
                  .execute(
                    { description: "Recover inspection", prompt: "Inspect recovery", subagent_type: "general" },
                    {
                      sessionID: chat.id,
                      messageID,
                      agent: "build",
                      callID,
                      parentAction: { actionID, runID: parent.run.id },
                      nativeParent: { modelID: "test-model", providerID: "test" },
                      abort: new AbortController().signal,
                      metadata: () => Effect.die("fixture stopped before background admission"),
                      ask: () => Effect.void,
                      promptOps: {
                        cancel: () => Effect.void,
                        resolvePromptParts: () => Effect.die("not started"),
                        prompt: () => Effect.die("not started"),
                      },
                    },
                  )
                  .pipe(
                    Effect.exit,
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        const pending = (yield* runs.listChildren({ parentRunID: parent.run.id }))[0]
                        const service = yield* SessionPrompt.Service
                        yield* service.recoverTask({
                          child: pending,
                          runChild: () => Effect.die("live parent handoff must not be stolen"),
                          wakeSession: () => Effect.die("live parent must not be notified"),
                        })
                        expect(yield* runs.load(pending.run.id)).toEqual(pending)
                        expect(yield* llm.hits).toHaveLength(0)
                        // Fence fixture preparation before the parent Action
                        // settles and makes the child eligible for scanning.
                        yield* runs.acquireLease({
                          runID: pending.run.id,
                          ownerID: "fixture-child-preparation",
                          ttlMs: 60_000,
                        })
                      }),
                    ),
                    Effect.as("durable child handoff retained"),
                  ),
            },
          )
        }).pipe(Effect.provide(location))
        const child = (yield* runs.listChildren({ parentRunID: parent.run.id }))[0]
        const releasePreparation = Effect.gen(function* () {
          const prepared = yield* runs.load(child.run.id)
          const lease = prepared.lease
          expect(lease?.ownerID).toBe("fixture-child-preparation")
          if (!lease) return yield* Effect.die("fixture preparation lease missing")
          yield* runs.releaseLease({
            runID: child.run.id,
            leaseID: lease.id,
            ownerID: "fixture-child-preparation",
            reason: "fixture abandoned state is ready for the real scanner",
          })
        })
        // A corrupt terminal notification must not stop either orphan recovery
        // or later valid delivery. Preserve it for diagnosis instead of marking
        // it delivered or allowing it to execute.
        const corrupt = yield* runs.createChild({
          ...child.run,
          ...child.run.child,
          idempotencyKey: "corrupt-notification-fixture",
          budget: AgentRuntime.Budget.make({
            maxAttempts: 1,
            maxDurationMs: 1_000,
            maxCostMicros: 1,
            maxTokens: 1,
            attemptsUsed: 0,
            durationMsUsed: 0,
            costMicrosUsed: 0,
            tokensUsed: 0,
          }),
        })
        yield* runs.transition({ runID: corrupt.run.id, to: "cancelled", reason: "fixture terminal notification" })
        yield* runs.checkpoint({
          runID: corrupt.run.id,
          state: { taskRecovery: { notification: { delivered: "invalid" } } },
        })
        const corruptBefore = yield* runs.load(corrupt.run.id)
        yield* runs.transition({ runID: parent.run.id, to: "completed", reason: "fixture parent handoff completed" })
        expect(child.run.status).toBe("draft")
        const terminalRecovery = abandonedState === "completed" || abandonedState === "failed"
        if (!terminalRecovery) yield* llm.text("Recovered child result")
        yield* llm.text("Parent received recovered result")
        // Model an abruptly abandoned attempt without a live BackgroundJob. No
        // process is killed here; real cross-process acceptance remains separate.
        for (const to of ["preflight", "queued", "running"] as const) {
          if (abandonedState === "draft") break
          yield* runs.transition({ runID: child.run.id, to, reason: "fixture abandoned attempt" })
          if (to === abandonedState) break
        }
        if (abandonedState === "completed" || abandonedState === "failed") {
          yield* runs.transition({ runID: child.run.id, to: abandonedState, reason: "fixture missing result receipt" })
          yield* releasePreparation
          const unsettled = (yield* runs.load(child.run.id)) as DurableRun.ChildSnapshot
          const unsettledParent = yield* runs.load(parent.run.id)
          const jobs = yield* BackgroundJob.Service
          const recovery = yield* SessionPrompt.Service
          for (let retry = 0; retry < 2; retry++) {
            const rejected = yield* recovery
              .recoverTask({
                child: unsettled,
                runChild: () => Effect.die("missing settlement must not replay the child"),
                wakeSession: () => Effect.die("missing settlement must not notify the parent"),
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(rejected)).toBe(true)
            if (Exit.isFailure(rejected))
              expect(Cause.pretty(rejected.cause)).toContain("SubagentChildExecutor.SettlementIncompleteError")
            expect(yield* jobs.get(child.run.sessionID)).toBeUndefined()
            expect(yield* runs.load(child.run.id)).toEqual(unsettled)
            expect(yield* runs.load(parent.run.id)).toEqual(unsettledParent)
            expect(yield* llm.hits).toHaveLength(0)
          }
          const intentAt = yield* DateTime.now
          const result = {
            status: abandonedState,
            summary: "Recovered child result",
            artifactRefs: [],
            evidenceRefs: [],
            usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
          }
          const intent = ChildSettlement.createIntent({
            parentRunID: parent.run.id,
            childRunID: child.run.id,
            idempotencyKey: child.run.child.idempotencyKey,
            result,
            createdAtMs: DateTime.toEpochMillis(intentAt),
          })
          yield* (yield* EventV2Bridge.Service).publish(
            AgentRuntime.Event.ChildRunSettlementIntentRecorded,
            {
              runID: parent.run.id,
              sessionID: chat.id,
              childRunID: child.run.id,
              idempotencyKey: child.run.child.idempotencyKey,
              intentID: intent.intentID,
              idempotencyDigest: intent.idempotencyDigest,
              result: AgentRuntime.ChildRunResult.make({
                ...result,
                resultDigest: intent.resultDigest,
                recordedAt: intentAt,
              }),
              intentAt,
            },
            { expectedSequence: (yield* runs.load(parent.run.id)).lastSequence },
          )
        }
        if (abandonedState === "running")
          yield* runs.beginAttempt({
            runID: child.run.id,
            usageBaseline: AgentRuntime.RunUsageBaseline.make({ costMicros: 0, tokens: 0 }),
          })
        if (!terminalRecovery) yield* releasePreparation
        const expectedRequests = terminalRecovery ? 1 : 2
        yield* awaitWithTimeout(llm.wait(expectedRequests), "scanner did not recover and notify", "20 seconds")
        yield* pollWithTimeout(
          core
            .context(SessionV2.ID.make(chat.id))
            .pipe(
              Effect.map((messages) =>
                messages.some(
                  (message) =>
                    message.type === "assistant" &&
                    message.finish === "stop" &&
                    JSON.stringify(message).includes("Parent received recovered result"),
                )
                  ? true
                  : undefined,
              ),
            ),
          "recovered notification missing",
        )
        const recovered = yield* runs.load(child.run.id)
        expect(recovered.run.status).toBe(abandonedState === "failed" ? "failed" : "completed")
        expect(recovered.run.budget.attemptsUsed).toBe(terminalRecovery ? 0 : abandonedState === "running" ? 2 : 1)
        expect(recovered.activeAttempt).toBeUndefined()
        expect(recovered.lease).toBeUndefined()
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
        expect(
          (yield* core.context(SessionV2.ID.make(child.run.sessionID))).filter(
            (message) => message.type === "assistant",
          ),
        ).toHaveLength(terminalRecovery ? 0 : 1)
        expect(
          (yield* sessions.messages({ sessionID: child.run.sessionID })).filter(
            (message) => message.info.role === "assistant",
          ),
        ).toHaveLength(0)
        expect(yield* llm.hits).toHaveLength(expectedRequests)
        const envelope = recovered.checkpoint!.state.taskRecovery as Record<string, unknown>
        const notification = envelope.notification as Record<string, unknown>
        expect(notification.delivered).toBe(true)
        if (terminalRecovery) {
          expect(recovered.run).toMatchObject({
            childResult: { status: abandonedState, summary: "Recovered child result" },
          })
          const notificationText = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
            notification.payload,
          ).text
          expect(notificationText).toContain(
            abandonedState === "failed" ? "Background task failed:" : "Background task completed:",
          )
        }
        const parentBeforeReplay = yield* core.context(SessionV2.ID.make(chat.id))
        // The input was committed, but simulate losing the later delivered
        // marker. Replaying delivery must not add another user/model turn.
        yield* runs.checkpoint({
          runID: child.run.id,
          state: {
            ...recovered.checkpoint!.state,
            taskRecovery: { ...envelope, notification: { ...notification, delivered: false } },
          },
        })
        const pendingDelivery = (yield* runs.load(child.run.id)) as DurableRun.ChildSnapshot
        yield* pollWithTimeout(
          runs
            .load(child.run.id)
            .pipe(
              Effect.map((item) => (!hasPendingTaskNotification(item as DurableRun.ChildSnapshot) ? true : undefined)),
            ),
          "scanner did not replay pending delivery",
          "8 seconds",
        )
        const service = yield* SessionPrompt.Service
        const execution = yield* SessionExecution.Service
        for (let replay = 0; replay < 2; replay++)
          yield* service.recoverTask({
            child: pendingDelivery,
            runChild: () => Effect.die("completed notification must not restart the child"),
            wakeSession: (id) => execution.wakeAndWait(SessionV2.ID.make(id)).pipe(Effect.orDie),
          })
        expect(yield* core.context(SessionV2.ID.make(chat.id))).toEqual(parentBeforeReplay)
        expect(yield* llm.hits).toHaveLength(expectedRequests)
        expect(yield* runs.load(corrupt.run.id)).toEqual(corruptBefore)
        if (abandonedState === "draft") {
          // Model a persisted completion handoff whose in-memory wake was lost.
          // This new fixture input has never been promoted or consumed.
          const database = yield* Database.Service
          const events = yield* EventV2Bridge.Service
          const unwokenID = MessageID.ascending()
          const payload = { agent: "build", text: "Background completion saved before lost wake" }
          yield* SessionInput.admit(database.db, events, {
            id: SessionMessage.ID.make(unwokenID),
            sessionID: DurableSessionSchema.ID.make(chat.id),
            delivery: "steer",
            prompt: DurablePrompt.make({ text: payload.text, route: { agent: payload.agent } }),
          })
          const beforeWake = yield* runs.load(child.run.id)
          if (!("sessionID" in beforeWake.run) || !beforeWake.run.child)
            return yield* Effect.die("fixture child binding missing")
          const pendingWake = {
            ...beforeWake,
            run: { ...beforeWake.run, child: child.run.child },
            checkpoint: {
              ...beforeWake.checkpoint!,
              state: {
                ...beforeWake.checkpoint!.state,
                taskRecovery: { ...envelope, notification: { messageID: unwokenID, payload, delivered: true } },
              },
            },
          }
          for (const status of ["paused", "cancelled", "awaiting_authorization"] as const)
            expect(
              yield* taskNotificationParentToWake(pendingWake).pipe(
                Effect.provideService(DurableRun.Service, {
                  ...runs,
                  list: () => Effect.succeed([{ ...parent, run: { ...parent.run, status } }]),
                }),
              ),
            ).toBeUndefined()
          yield* runs.checkpoint({
            runID: child.run.id,
            state: {
              ...beforeWake.checkpoint!.state,
              taskRecovery: {
                ...envelope,
                notification: { messageID: unwokenID, payload, delivered: true },
              },
            },
          })
          yield* llm.text("Parent resumed the persisted completion")
          yield* pollWithTimeout(
            core
              .context(SessionV2.ID.make(chat.id))
              .pipe(
                Effect.map((messages) =>
                  messages.some(
                    (message) =>
                      message.type === "assistant" &&
                      message.finish === "stop" &&
                      JSON.stringify(message).includes("Parent resumed the persisted completion"),
                  )
                    ? true
                    : undefined,
                ),
              ),
            "persisted notification was not woken",
            "12 seconds",
          )
          expect(yield* llm.hits).toHaveLength(3)
          expect((yield* runs.load(child.run.id)).run.budget.attemptsUsed).toBe(1)
          const consumed = (yield* runs.load(child.run.id)) as DurableRun.ChildSnapshot
          expect(yield* taskNotificationParentToWake(consumed)).toBeUndefined()
          expect((yield* SessionInput.find(database.db, SessionMessage.ID.make(unwokenID)))?.promotedSeq).toBeDefined()
          const mismatched = {
            ...consumed,
            checkpoint: {
              ...consumed.checkpoint!,
              state: {
                ...consumed.checkpoint!.state,
                taskRecovery: {
                  ...envelope,
                  notification: {
                    messageID: unwokenID,
                    delivered: true,
                    payload: { ...payload, text: "different content must not wake" },
                  },
                },
              },
            },
          }
          expect(Exit.isFailure(yield* taskNotificationParentToWake(mismatched).pipe(Effect.exit))).toBe(true)
        }
      }),
    30_000,
  )

for (const outcome of ["complete", "cancel"] as const)
  formalIntegration.instance(
    `Formal model task queues a running child followup then ${outcome}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const execution = yield* SessionExecution.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const jobs = yield* BackgroundJob.Service
        const durable = yield* DurableRun.Service
        const gate = yield* Deferred.make<void>()
        const chat = yield* sessions.create({
          title: "Running followup",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.admit({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "Delegate" }] })
        yield* llm.push(
          reply().tool("task", { description: "initial", prompt: "First review", subagent_type: "general" }),
        )
        yield* llm.hold("Initial child result", deferredAsPromise(gate))
        yield* llm.text("Started in background")
        const parent = yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(2), "child did not start", "10 seconds")
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        const childID = children[0].id
        yield* jobs.promote(childID)
        yield* awaitWithTimeout(Fiber.join(parent), "parent did not return", "10 seconds")
        yield* prompt.admit({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Also check errors" }],
        })
        yield* llm.push(
          reply().tool("task", {
            description: "followup",
            prompt: "Check errors too",
            subagent_type: "general",
            task_id: childID,
          }),
        )
        yield* llm.text("Followup queued")
        yield* llm.text("Followup child result")
        yield* llm.text("Both results received")
        yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.timeout("20 seconds"))
        expect(yield* llm.hits).toHaveLength(5)
        const before = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
        expect(before).toHaveLength(2)
        for (const snapshot of before) {
          const child = snapshot as DurableRun.ChildSnapshot
          const intent = readRecoveryIntent(child)
          expect(intent.childSessionID).toBe(childID)
          expect(intent.parentSessionID).toBe(chat.id)
          expect(intent.model).toMatchObject({ modelID: "test-model", providerID: "test" })
          expect(intent.parameters.prompt).toBe(child.run.child.delegatedObjective)
          expect(() =>
            readRecoveryIntent({
              ...child,
              checkpoint: child.checkpoint && {
                ...child.checkpoint,
                state: { ...child.checkpoint.state, taskRecovery: { intent, digest: "tampered" } },
              },
            }),
          ).toThrow()
        }
        expect(before.filter((run) => run.activeAttempt !== undefined)).toHaveLength(1)
        const active = before.find((run) => run.activeAttempt !== undefined) as DurableRun.ChildSnapshot
        const frozen = readRecoveryIntent(active)
        const input: SessionPrompt.PromptInput = {
          messageID: frozen.childMessageID,
          sessionID: frozen.childSessionID,
          runID: active.run.id,
          model: {
            modelID: ModelV2.ID.make(frozen.model.modelID),
            providerID: ProviderV2.ID.make(frozen.model.providerID),
          },
          variant: frozen.model.variant,
          agent: frozen.childAgent,
          parts: yield* prompt.resolvePromptParts(frozen.parameters.prompt),
        }
        const childAttempt = {
          childRunID: active.run.id,
          execution: {
            attempt: active.activeAttempt!.attempt,
            startedAtMs: DateTime.toEpochMillis(active.activeAttempt!.startedAt),
            timeoutMs: active.run.budget.maxDurationMs,
            costMicrosBefore: active.activeAttempt!.usageBaseline?.costMicros ?? 0,
            tokensBefore: active.activeAttempt!.usageBaseline?.tokens ?? 0,
            ownerID: active.lease!.ownerID,
            leaseID: active.lease!.id,
          },
        }
        const priorMessages = yield* sessions.messages({ sessionID: childID })
        const noReadmission = () => Effect.die(new Error("recovery must reuse existing admission"))
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(children[0].directory) }))
        const resumeAdmission = (...args: Parameters<typeof admitChildPrompt>) =>
          admitChildPrompt(...args).pipe(Effect.provide(location))
        const reused = yield* resumeAdmission(input, childAttempt, noReadmission)
        expect(reused.info.id).toBe(frozen.childMessageID!)
        const altered = yield* resumeAdmission(
          { ...input, parts: [{ type: "text", text: "changed during recovery" }] },
          childAttempt,
          noReadmission,
        ).pipe(Effect.exit)
        expect(Exit.isFailure(altered)).toBe(true)
        expect(
          Exit.isFailure(
            yield* resumeAdmission({ ...input, messageID: MessageID.ascending() }, childAttempt, noReadmission).pipe(
              Effect.exit,
            ),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* resumeAdmission(
              input,
              { ...childAttempt, execution: { ...childAttempt.execution, ownerID: "stale-owner" } },
              noReadmission,
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* sessions.messages({ sessionID: childID })).toEqual(priorMessages)
        expect(yield* llm.hits).toHaveLength(5)
        if (outcome === "cancel") {
          yield* jobs.cancel(childID)
          const cancelled = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
          expect(cancelled).toHaveLength(2)
          for (const run of cancelled) {
            expect(run.run.status).toBe("cancelled")
            expect(run.activeAttempt).toBeUndefined()
            expect(run.lease).toBeUndefined()
          }
          expect(cancelled.map((run) => run.run.budget.attemptsUsed).sort()).toEqual([0, 1])
          expect(yield* llm.hits).toHaveLength(5)
          return
        }
        yield* Deferred.succeed(gate, undefined)
        yield* awaitWithTimeout(llm.wait(7), "followup completion did not notify parent", "10 seconds")
        yield* pollWithTimeout(
          core.context(SessionV2.ID.make(chat.id)).pipe(
            Effect.map((messages) => {
              const last = messages.at(-1)
              return last?.type === "assistant" &&
                last.finish === "stop" &&
                JSON.stringify(last).includes("Both results received")
                ? true
                : undefined
            }),
          ),
          "parent did not finish",
        )
        expect((yield* sessions.children(chat.id)).map((child) => child.id)).toEqual([childID])
        const runs = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
        for (const run of runs) {
          expect(run.run.status).toBe("completed")
          expect(run.run.budget.attemptsUsed).toBe(1)
          expect(run.activeAttempt).toBeUndefined()
          expect(run.lease).toBeUndefined()
        }
        const hits = yield* llm.hits
        expect(JSON.stringify(hits[5]?.body)).toContain("Initial child result")
        expect(JSON.stringify(hits[6]?.body)).toContain("Followup child result")
        for (const sessionID of [chat.id, childID])
          expect(
            (yield* sessions.messages({ sessionID })).filter((message) => message.info.role === "assistant"),
          ).toHaveLength(0)
      }),
    60_000,
  )

for (const parentState of ["idle", "busy", "child-error"] as const)
  formalIntegration.instance(
    `Formal background completion wakes the ${parentState} parent without a legacy processor`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          command: { review: { template: "Review $ARGUMENTS", agent: "general", subtask: true } },
        }))
        const prompt = yield* SessionPrompt.Service
        const execution = yield* SessionExecution.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const jobs = yield* BackgroundJob.Service
        const durable = yield* DurableRun.Service
        const gate = yield* Deferred.make<void>()
        const parentGate = yield* Deferred.make<void>()
        const chat = yield* sessions.create({
          title: "Background formal child",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.admitCommand({ sessionID: chat.id, command: "review", arguments: "file", agent: "build" })
        if (parentState === "child-error")
          yield* llm.push(reply().wait(deferredAsPromise(gate)).streamError("background fixture failure"))
        else yield* llm.hold("background review finished", deferredAsPromise(gate))
        if (parentState === "busy") yield* llm.hold("Review running in background", deferredAsPromise(parentGate))
        else yield* llm.text("Review running in background")
        yield* llm.text("Background result received")
        const fiber = yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(1), "child did not start", "10 seconds")
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        yield* jobs.promote(children[0].id)
        yield* awaitWithTimeout(llm.wait(2), "parent did not resume after promotion", "10 seconds")
        if (parentState !== "busy")
          yield* awaitWithTimeout(Fiber.join(fiber), "parent did not return after promotion", "10 seconds")
        expect(yield* llm.hits).toHaveLength(2)
        yield* Deferred.succeed(gate, undefined)
        if (parentState === "busy") {
          yield* pollWithTimeout(
            SessionInput.listPending((yield* Database.Service).db, DurableSessionSchema.ID.make(chat.id), "steer").pipe(
              Effect.map((messages) =>
                messages.some((message) => message.prompt.text.includes("Background task completed:"))
                  ? true
                  : undefined,
              ),
            ),
            "background result was not admitted while parent was busy",
          )
          // A notification is pending, not a second concurrent parent runner.
          expect(yield* llm.hits).toHaveLength(2)
          yield* Deferred.succeed(parentGate, undefined)
          yield* awaitWithTimeout(Fiber.join(fiber), "busy parent did not drain", "10 seconds")
        }
        yield* awaitWithTimeout(llm.wait(3), "background completion did not wake Core parent", "10 seconds")
        yield* pollWithTimeout(
          core.context(SessionV2.ID.make(chat.id)).pipe(
            Effect.map((messages) => {
              const last = messages.at(-1)
              return last?.type === "assistant" &&
                last.finish === "stop" &&
                JSON.stringify(last).includes("Background result received")
                ? true
                : undefined
            }),
          ),
          "parent did not finish notification",
        )
        expect(JSON.stringify((yield* llm.hits).at(-1)?.body)).toContain(
          parentState === "child-error" ? "Background task failed:" : "background review finished",
        )
        for (const sessionID of [chat.id, children[0].id]) {
          expect((yield* sessions.messages({ sessionID })).filter((m) => m.info.role === "assistant")).toHaveLength(0)
        }
        const runs = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(children[0].id) })
        expect(runs).toHaveLength(1)
        expect(runs[0]?.run.status).toBe(parentState === "child-error" ? "failed" : "completed")
        expect(runs[0]?.run.budget.attemptsUsed).toBe(1)
        expect(runs[0]?.lease).toBeUndefined()
      }),
    30_000,
  )

for (const target of ["parent", "child"] as const)
  formalIntegration.instance(
    `Formal scheduled cancellation of ${target} settles the child without a legacy processor`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          command: {
            review: { template: "Review $ARGUMENTS", description: "Review", agent: "general", subtask: true },
          },
        }))
        const prompt = yield* SessionPrompt.Service
        const execution = yield* SessionExecution.Service
        const sessions = yield* Session.Service
        const durable = yield* DurableRun.Service
        const chat = yield* sessions.create({
          title: "Cancel formal child",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.admitCommand({ sessionID: chat.id, command: "review", arguments: "file", agent: "build" })
        yield* llm.hang
        const fiber = yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(1), "Core child did not reach provider", "10 seconds")
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        if (target === "parent") yield* execution.interrupt(SessionV2.ID.make(chat.id))
        else {
          yield* llm.text("Parent continues after child cancellation")
          const background = yield* BackgroundJob.Service
          yield* background.cancel(children[0].id)
        }
        yield* awaitWithTimeout(Fiber.await(fiber), "parent did not stop", "10 seconds")
        const runs = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(children[0].id) })
        expect(runs).toHaveLength(1)
        expect(runs[0]?.run.status).toBe("cancelled")
        expect(runs[0]?.activeAttempt).toBeUndefined()
        expect(runs[0]?.lease).toBeUndefined()
        expect(yield* llm.hits).toHaveLength(target === "parent" ? 1 : 2)
        if (target === "child") {
          const core = yield* SessionV2.Service
          expect((yield* core.context(SessionV2.ID.make(chat.id))).at(-1)).toMatchObject({
            type: "assistant",
            finish: "stop",
          })
        }
      }),
    30_000,
  )

formalIntegration.instance(
  "Formal subtask-only first turn generates one parent title through Core",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: {
          review: {
            template: "Review $ARGUMENTS carefully",
            description: "Workspace review",
            agent: "general",
            subtask: true,
          },
        },
      }))
      const sessions = yield* Session.Service
      const actions = yield* DurableAction.Service
      const runs = yield* DurableRun.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      yield* llm.text("Child review result", { usage: { input: 3, output: 4 } })
      yield* llm.text("Parent review answer", { usage: { input: 5, output: 6 } })
      yield* llm.text("Index code review", { usage: { input: 7, output: 3 } })
      yield* (yield* SessionPrompt.Service).command({
        sessionID: chat.id,
        command: "review",
        arguments: "src/index.ts",
        agent: "build",
      })
      const job = yield* pollWithTimeout(
        jobs
          .list()
          .pipe(
            Effect.map((items) =>
              items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
            ),
          ),
        "Parent title job missing",
      )
      expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe("completed")
      expect((yield* sessions.get(chat.id)).title).toBe("Index code review")
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      const child = children[0]
      if (!child) throw new Error("Child session missing")
      expect(child.title).toBe("Workspace review (@general subagent)")
      expect(
        (yield* actions.list({ sessionID: SessionV2.ID.make(child.id) })).filter(
          (item) => item.action.name === "session.title",
        ),
      ).toEqual([])
      const parentActions = yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })
      const titles = parentActions.filter((item) => item.action.name === "session.title")
      expect(titles).toHaveLength(1)
      expect(titles[0]?.action.budget.attemptsUsed).toBe(1)
      const requests = yield* llm.inputs
      expect(JSON.stringify(requests[2]?.messages)).toContain("Review src/index.ts carefully")
      expect(JSON.stringify(requests[2]?.messages)).not.toContain("Child review result")
      const beforeRuns = yield* runs.list({ sessionID: SessionV2.ID.make(chat.id) })
      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
      expect(yield* llm.calls).toBe(3)
      expect(yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })).toEqual(parentActions)
      expect(yield* runs.list({ sessionID: SessionV2.ID.make(chat.id) })).toEqual(beforeRuns)
    }),
  30000,
)

for (const attachment of ["text", "image"] as const)
  formalIntegration.instance(
    `Formal ${attachment}-attachment-only first turn generates a title from admitted content`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const actions = yield* DurableAction.Service
        const chat = yield* sessions.create()
        const content = "Cache configuration uses a 60 second expiry."
        const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
        const source = new photon.PhotonImage(new Uint8Array([255, 255, 255, 255]), 1, 1)
        const image = `data:image/png;base64,${Buffer.from(source.get_bytes()).toString("base64")}`
        source.free()
        yield* llm.text("The attachment describes the cache expiry.")
        yield* llm.text("Cache expiry configuration", { usage: { input: 8, output: 3 } })
        yield* (yield* SessionPrompt.Service).prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            {
              type: "file",
              mime: attachment === "text" ? "text/plain" : "image/png",
              filename: attachment === "text" ? "cache.txt" : "cache.png",
              url: attachment === "text" ? `data:text/plain;base64,${Buffer.from(content).toString("base64")}` : image,
            },
          ],
        })
        const job = yield* pollWithTimeout(
          jobs
            .list()
            .pipe(
              Effect.map((items) =>
                items.find((item) => item.type === "session-title" && item.metadata?.sessionId === chat.id),
              ),
            ),
          "Attachment title job missing",
        )
        expect((yield* jobs.wait({ id: job.id, timeout: 5000 })).info?.status).toBe("completed")
        expect((yield* sessions.get(chat.id)).title).toBe("Cache expiry configuration")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs[1]?.messages)).toContain(attachment === "text" ? content : image)
        expect(inputs[1]?.model).toBe(attachment === "text" ? "test-auto-mini" : "test-model")
        expect(JSON.stringify(inputs[1]?.messages)).not.toContain("data:text/plain;base64")
        const before = yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })
        expect(before.filter((item) => item.action.name === "session.title")).toHaveLength(1)
        yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
        expect(yield* llm.calls).toBe(2)
        expect(yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })).toEqual(before)
      }),
    20000,
  )

formalIntegration.instance(
  "integrated Formal drain executes an admitted automatic subtask once before the parent request",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: {
          review: {
            template: "Review $ARGUMENTS carefully",
            description: "Workspace review",
            agent: "general",
            subtask: true,
          },
        },
      }))
      const prompt = yield* SessionPrompt.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const chat = yield* sessions.create({
        title: "Formal scheduled subtask",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const admitted = yield* prompt.admitCommand({
        sessionID: chat.id,
        command: "review",
        arguments: "src/index.ts",
        agent: "build",
      })
      const source = admitted.message.parts.find((part): part is SessionV1.SubtaskPart => part.type === "subtask")
      if (!source) return yield* Effect.die("automatic subtask source was not admitted")

      yield* llm.text("child inspected src/index.ts", { usage: { input: 3, output: 4 } })
      yield* llm.text("parent summarized the delegated review", { usage: { input: 5, output: 6 } })
      const catalog = Billing.PriceCatalog.make({
        revision: "fixture-formal-scheduled-task-v1",
        currency: "USD",
        minorUnit: 2,
        unit: "1k-tokens",
        effectiveFrom: DateTime.makeUnsafe("2026-08-30T00:00:00.000Z"),
        source: "fixture:formal-scheduled-task",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
      })

      yield* execution
        .resumeWith({
          sessionID: SessionV2.ID.make(chat.id),
          options: {
            credentialIDs: [],
            billing: {
              budget: Billing.Budget.make({ currency: "USD", limitMinor: 10_000 }),
              resolveCatalog: ({ providerID, modelID }) =>
                providerID === "test" && modelID === "test-model" ? catalog : undefined,
            },
          },
        })
        .pipe(Effect.timeout("20 seconds"))

      const children = yield* sessions.children(chat.id)
      const matureMessages = yield* sessions.messages({ sessionID: chat.id })
      const matureShadow = matureMessages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.parentID === admitted.message.info.id &&
          message.parts.some((part) => part.type === "tool" && part.callID === source.id),
      )
      const context = yield* core.context(SessionV2.ID.make(chat.id))
      const scheduledTool = context
        .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool" && part.id === source.id)
      const hits = yield* llm.hits

      expect(scheduledTool).toMatchObject({
        type: "tool",
        id: source.id,
        name: "task",
        provider: { executed: false },
        state: { status: "completed" },
      })
      expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
      expect(hits).toHaveLength(2)
      expect(JSON.stringify(hits.at(-1)?.body)).toContain("child inspected src/index.ts")
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ parentID: chat.id, agent: "general" })
      expect(children[0]?.permission).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ permission: "task", pattern: "*", action: "deny" }),
          expect.objectContaining({ permission: "todowrite", pattern: "*", action: "deny" }),
        ]),
      )
      expect(matureShadow).toBeUndefined()
      expect(matureMessages.filter((message) => message.info.role === "assistant")).toHaveLength(0)

      // R05 recording boundary: a passing parent test does not prove that the
      // child used Core. Observe both stores and the actual durable lifecycle.
      // Do not turn the legacy count into a permanent compatibility requirement.
      const childID = children[0].id
      const childLegacy = yield* sessions.messages({ sessionID: childID })
      const childCore = yield* core.context(SessionV2.ID.make(childID))
      expect(childCore.filter((message) => message.type === "assistant")).toHaveLength(1)
      expect(childLegacy.filter((message) => message.info.role === "assistant")).toHaveLength(0)
      const durable = yield* DurableRun.Service
      const childRuns = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
      expect(childRuns).toHaveLength(1)
      expect(childRuns[0]?.run.status).toBe("completed")
      expect(childRuns[0]?.run.budget.attemptsUsed).toBe(1)
      expect(childRuns[0]?.run.budget.tokensUsed).toBe(7)
      expect(childRuns[0]?.activeAttempt).toBeUndefined()
      expect(childRuns[0]?.lease).toBeUndefined()
      const executionRecording = {
        parentCoreAssistants: context.filter((message) => message.type === "assistant").length,
        parentLegacyAssistants: matureMessages.filter((message) => message.info.role === "assistant").length,
        childCoreAssistants: childCore.filter((message) => message.type === "assistant").length,
        childLegacyAssistants: childLegacy.filter((message) => message.info.role === "assistant").length,
        providerCalls: hits.length,
        childRunCount: childRuns.length,
        childAttempts: childRuns[0]?.run.budget.attemptsUsed,
        childTokens: childRuns[0]?.run.budget.tokensUsed,
      }
      console.info("R05 scheduled child execution recording", JSON.stringify(executionRecording))
    }),
  30_000,
)

formalIntegration.instance(
  "Formal drain consumes a queued routed prompt after a completed turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("baseline complete")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "baseline" }] })
      const messageID = SessionMessage.ID.make(MessageID.ascending())
      yield* SessionInput.admit(database.db, events, {
        id: messageID,
        sessionID: SessionV2.ID.make(chat.id),
        delivery: "queue",
        prompt: DurablePrompt.make({
          text: "queued through the shared state owner",
          route: {
            agent: "build",
            model: {
              id: ModelV2.ID.make("test-model"),
              providerID: ProviderV2.ID.make("test"),
            },
          },
        }),
      })
      yield* llm.text("durable queue answered")

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      expect(context.find((message) => message.id === messageID)?.type).toBe("user")
      const assistants = context.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      expect(assistants[1].agent).toBe("build")
      expect(assistants[1].model).toMatchObject({ providerID: "test", id: "test-model" })
      expect(assistants[1].content).toContainEqual(
        expect.objectContaining({ type: "text", text: "durable queue answered" }),
      )
      expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("queued through the shared state owner")
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
      expect(yield* SessionInput.listQueued(database.db, SessionV2.ID.make(chat.id))).toEqual([])
      expect(yield* llm.hits).toHaveLength(2)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal drain consumes a durable steer once without legacy promotion",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const execution = yield* SessionExecution.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const messageID = SessionMessage.ID.make(MessageID.ascending())
      yield* SessionInput.admit(database.db, events, {
        id: messageID,
        sessionID: SessionV2.ID.make(chat.id),
        delivery: "steer",
        prompt: DurablePrompt.make({
          text: "steered through the shared state owner",
          route: {
            agent: "build",
            model: {
              id: ModelV2.ID.make("test-model"),
              providerID: ProviderV2.ID.make("test"),
            },
          },
        }),
      })
      yield* llm.text("durable steer answered")

      yield* execution.wakeAndWait(SessionV2.ID.make(chat.id))
      const core = yield* SessionV2.Service
      const context = yield* core.context(SessionV2.ID.make(chat.id))
      expect(context.filter((message) => message.id === messageID && message.type === "user")).toHaveLength(1)
      const assistants = context.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(1)
      expect(assistants[0].agent).toBe("build")
      expect(assistants[0].model).toMatchObject({ providerID: "test", id: "test-model" })
      expect(assistants[0].content).toContainEqual(
        expect.objectContaining({ type: "text", text: "durable steer answered" }),
      )
      expect(yield* SessionInput.listPending(database.db, SessionV2.ID.make(chat.id), "steer")).toEqual([])
      yield* execution.wakeAndWait(SessionV2.ID.make(chat.id))
      expect(yield* core.context(SessionV2.ID.make(chat.id))).toEqual(context)
      expect(yield* llm.hits).toHaveLength(1)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal drain absorbs a durable steer admitted during an active provider turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.admit({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "first turn" }] })
      yield* llm.hold("first answer", deferredAsPromise(gate))
      yield* llm.text("steer absorbed")

      const fiber = yield* (yield* SessionExecution.Service)
        .wakeAndWait(SessionV2.ID.make(chat.id))
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the active provider turn", "10 seconds")

      const steerID = SessionMessage.ID.make(MessageID.ascending())
      yield* SessionInput.admit(database.db, events, {
        id: steerID,
        sessionID: SessionV2.ID.make(chat.id),
        delivery: "steer",
        prompt: DurablePrompt.make({
          text: "use the durable steer now",
          route: {
            agent: "build",
            model: {
              id: ModelV2.ID.make("test-model"),
              providerID: ProviderV2.ID.make("test"),
            },
          },
        }),
      })
      expect(yield* llm.calls).toBe(1)
      expect(yield* SessionInput.listPending(database.db, SessionV2.ID.make(chat.id), "steer")).toHaveLength(1)
      yield* Deferred.succeed(gate, void 0)

      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("15 seconds"))
      if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
      expect(yield* llm.calls).toBe(2)
      expect(yield* SessionInput.listPending(database.db, SessionV2.ID.make(chat.id), "steer")).toEqual([])

      const stored = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      expect(stored.filter((message) => message.id === steerID && message.type === "user")).toHaveLength(1)
      const assistants = stored.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      expect(assistants[1].content).toContainEqual(expect.objectContaining({ type: "text", text: "steer absorbed" }))
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const secondMessages = inputs[1]?.messages
      if (!Array.isArray(secondMessages)) throw new Error("expected the second provider input")
      expect(secondMessages.at(-1)).toEqual({ role: "user", content: "use the durable steer now" })
    }),
  30_000,
)

withMcpInstructions.instance(
  "Formal includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      const fiber = yield* (yield* SessionExecution.Service)
        .wakeAndWait(SessionV2.ID.make(chat.id))
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

withMcpInstructions.instance(
  "Formal MCP instructions follow current session permissions and semantic removal",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "MCP permission" })
      yield* llm.text("first")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
      expect(JSON.stringify((yield* llm.inputs)[0]?.messages).includes("Use lookup before mutate.")).toBe(true)
      const permission = [{ permission: "guide-server_*", pattern: "*", action: "deny" as const }]
      yield* sessions.setPermission({ sessionID: chat.id, permission })
      yield* llm.text("second")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "continue" }] })
      expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain(
        "Previously supplied MCP server instructions are no longer available or permitted; disregard them.",
      )
      const denied = yield* sessions.create({ title: "MCP denied", permission })
      yield* llm.text("third")
      yield* prompt.prompt({ sessionID: denied.id, agent: "build", parts: [{ type: "text", text: "hello" }] })
      expect(JSON.stringify((yield* llm.inputs)[2]?.messages).includes("Use lookup before mutate.")).toBe(false)
      expect(yield* llm.calls).toBe(3)
    }),
  15_000,
)

withMcpAttachment.instance(
  "Formal user-attached MCP resources execute through the Core ActionGateway",
  () =>
    Effect.gen(function* () {
      mcpAttachmentReads = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "MCP attachment",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      const fiber = yield* prompt
        .admit({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "text", text: "summarize the attached resource" },
            {
              type: "file",
              mime: "text/plain",
              filename: "readme.txt",
              url: "data:text/plain;base64,",
              source: {
                type: "resource",
                clientName: "fixture-server",
                uri: mcpAttachmentResourceUri,
                text: { value: "readme", start: 0, end: 6 },
              },
            },
          ],
        })
        .pipe(Effect.forkChild)
      // The outer transient tool and the nested MCP child action both use the
      // existing ActionGateway/PermissionV2 boundary. Approve each exact
      // request in turn; no direct MCP read path is allowed to skip it.
      for (let i = 0; i < 2; i++) {
        const pending = yield* pollWithTimeout(
          permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
          `MCP attachment approval ${i + 1} was not requested`,
        )
        expect(pending.requiresHumanConfirmation).toBe(true)
        yield* permissions.reply({ requestID: pending.id, reply: "once" })
      }
      const message = yield* Fiber.join(fiber)
      expect(mcpAttachmentReads).toBe(1)
      expect(message.info.role).toBe("user")
      const textParts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      expect(textParts).toHaveLength(3)
      expect(textParts[0]).toBe("summarize the attached resource")
      expect(textParts[1]).toContain("Reading MCP resource: readme.txt")
      expect(textParts[2]).toContain("resource routed through Core")
      const database = yield* Database.Service
      const admitted = yield* SessionInput.find(database.db, SessionMessage.ID.make(message.info.id))
      expect(admitted?.sessionID).toBe(chat.id)
      expect(admitted?.prompt.text).toContain("resource routed through Core")
    }),
  15_000,
)

withMcpAttachmentDenied.instance(
  "Formal user-attached MCP resources fail closed when the generation catalog is unavailable",
  () =>
    Effect.gen(function* () {
      mcpAttachmentDeniedReads = 0
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "MCP attachment denied" })
      const message = yield* prompt.admit({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            filename: "readme.txt",
            url: "data:text/plain;base64,",
            source: {
              type: "resource",
              clientName: "fixture-server",
              uri: mcpAttachmentResourceUri,
              text: { value: "readme", start: 0, end: 6 },
            },
          },
        ],
      })
      expect(mcpAttachmentDeniedReads).toBe(0)
      const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      expect(text).toContain("Failed to read MCP resource readme.txt")
      expect(text).toContain("not in the current capability catalog")
    }),
  15_000,
)

for (const delegated of [false, true]) {
  withMcpInstructions.instance(
    `Formal child receives MCP instructions only when delegated=${delegated}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "MCP child",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.push(
          reply().tool("task", {
            description: "Inspect",
            prompt: "Inspect only",
            subagent_type: "general",
            ...(delegated
              ? { capabilities: [{ action: "guide-server_lookup", resources: ["*"], access: "read" }] }
              : {}),
          }),
          reply().text("child done").stop(),
          reply().text("parent done").stop(),
        )
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Delegate inspection" }],
        })
        const requests = yield* llm.inputs
        expect(requests).toHaveLength(3)
        expect(JSON.stringify(requests[1]?.messages).includes("Use lookup before mutate.")).toBe(delegated)
        expect(yield* sessions.children(chat.id)).toHaveLength(1)
      }),
    15_000,
  )
}

it.instance("legacy prompt emits message events plus one canonical admission per user turn", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([
      SessionEvent.PromptAdmitted.type,
      SessionEvent.PromptAdmitted.type,
    ])
  }),
)

for (const structured of [false, true]) {
  formalIntegration.instance(`Formal surfaces content-filter finishes as session errors structured=${structured}`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const events = yield* EventV2Bridge.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const errors: unknown[] = []
      const expected = {
        type: "unknown" as const,
        message: "The response was blocked by the provider's content filter",
      }
      const off = yield* events.listen((event) => {
        if (event.type !== SessionEvent.Step.Failed.type) return Effect.void
        const data = event.data as typeof SessionEvent.Step.Failed.data.Type
        if (data.sessionID === chat.id && data.error) errors.push(data.error)
        return Effect.void
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        ...(structured ? { format: { type: "json_schema" as const, schema: { type: "object" }, retryCount: 2 } } : {}),
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().text("partial response").contentFilter())

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(chat.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const result = context.findLast((message) => message.type === "assistant")
      yield* off

      expect(yield* llm.hits).toHaveLength(1)
      expect(result?.type).toBe("assistant")
      expect(result?.finish).toBe("content-filter")
      expect(result?.error).toEqual(expected)
      expect(errors).toContainEqual(expected)
      expect(result?.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
      )
    }),
  )
}

for (const terminal of ["stop", "content-filter"] as const) {
  formalIntegration.instance(`Formal compaction HTTP matches its committed preparation: ${terminal}`, () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        compaction: { preserve_recent_tokens: 0 },
      }))
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "Pinned compaction verification" })
      yield* llm.error(413, { error: { message: "request entity too large" } })
      const summary = "## Objective\n- Preserve the original request"
      yield* llm.push(terminal === "stop" ? reply().text(summary).stop() : reply().text(summary).contentFilter())
      if (terminal === "stop") yield* llm.text("Continued after verified summary")
      const result = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Preserve this request while recovering from overflow" }],
        })
        .pipe(Effect.exit)
      const hits = yield* llm.hits
      expect(hits).toHaveLength(terminal === "stop" ? 3 : 2)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.RequestPrepared.type, 1)))
        .all()
      const records = rows
        .map((row) => Schema.decodeUnknownSync(SessionEvent.Compaction.RequestPrepared.data)(row.data))
        .filter((record) => record.sessionID === chat.id)
      expect(records).toHaveLength(1)
      const record = records[0]!
      const envelope = parseRequestEnvelopeJson(record.envelope)
      expect(envelope.request_digest).toBe(record.requestDigest)
      const runs = yield* (yield* DurableRun.Service).list({ sessionID: SessionV2.ID.make(chat.id) })
      expect(runs).toHaveLength(1)
      expect(envelope.execution.run_id).toBe(runs[0]?.run.id)
      expect<unknown>(envelope.request.transmission!.body).toEqual(hits[1]!.body)
      const endpoint = new URL(envelope.request.transmission!.endpoint.url)
      expect(endpoint.origin).toBe(new URL(llm.url).origin)
      expect(endpoint.pathname + endpoint.search).toBe(hits[1]!.url.pathname + hits[1]!.url.search)
      expect(record.envelope).not.toContain("test-key")
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      expect(context.some((message) => message.type === "compaction")).toBe(terminal === "stop")
      if (terminal === "stop") {
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
        expect(Exit.isSuccess(result)).toBe(true)
        expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
        if (Exit.isSuccess(result))
          expect(
            result.value.parts.some((part) => part.type === "text" && part.text === "Continued after verified summary"),
          ).toBe(true)
      } else {
        expect(Exit.isFailure(result)).toBe(true)
        expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "error" })
        expect(context.find((message) => message.type === "user")).toMatchObject({
          type: "user",
          text: "Preserve this request while recovering from overflow",
        })
      }
    }),
  )
}

formalIntegration.instance("Formal stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    const result = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "hello" }],
      })
      .pipe(Effect.exit)

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))

    expect(yield* llm.calls).toBe(1)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "LLM.Error",
        reason: { _tag: "InvalidRequest", classification: "context-overflow" },
      })
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
    expect(context.some((message) => message.type === "compaction")).toBe(false)
    const assistant = context.findLast((message) => message.type === "assistant")
    expect(assistant?.finish).toBe("error")
    expect(assistant?.error?.message).toContain("request entity too large")
    expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(0)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

formalIntegration.instance("Formal returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(session.id))
    const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(session.id))
    const result = context.findLast((message) => message.type === "assistant")
    expect(result?.type).toBe("assistant")
    expect(result?.content.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)

    const actualParity = fromFormalParity(context, { terminalStatus: "completed", requestCount: 1 })
    const expectedParity = makeSessionParity({
      adapter: "provider-replay",
      terminalStatus: "completed",
      requestCount: 1,
      steps: [
        {
          finish: "stop",
          hasText: true,
          hasReasoning: false,
          structured: false,
          failed: false,
          tools: [],
        },
      ],
    })
    expect(compareSessionParity(expectedParity, actualParity).equivalent).toBe(true)
    expect(actualParity.traceDigest).toHaveLength(64)
  }),
)

formalIntegration.instance("Formal consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const execution = yield* SessionExecution.Service
    const core = yield* SessionV2.Service
    yield* execution.wakeAndWait(SessionV2.ID.make(session.id))
    const first = (yield* core.context(SessionV2.ID.make(session.id))).findLast(
      (message) => message.type === "assistant",
    )
    expect(first?.type).toBe("assistant")
    expect(first?.content.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    yield* execution.wakeAndWait(SessionV2.ID.make(session.id))
    const context = yield* core.context(SessionV2.ID.make(session.id))
    const second = context.findLast((message) => message.type === "assistant")
    expect(second?.type).toBe("assistant")
    expect(second?.content.some((part) => part.type === "text" && part.text === "world two")).toBe(true)
    expect(context.filter((message) => message.type === "assistant")).toHaveLength(2)
    expect(
      (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "assistant"),
    ).toHaveLength(0)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

formalIntegration.instance("Formal rejects an unknown tool and continues without a legacy invalid action", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(session.id))
    const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(session.id))
    const assistants = context.filter((message) => message.type === "assistant")
    const result = assistants.at(-1)
    expect(yield* llm.calls).toBe(2)
    expect(assistants).toHaveLength(2)
    expect(result?.type).toBe("assistant")
    expect(result?.content.some((part) => part.type === "text" && part.text === "second")).toBe(true)
    expect(result?.finish).toBe("stop")
    const tool = assistants[0]?.content.find((part) => part.type === "tool")
    expect(tool?.name).toBe("first")
    expect(tool?.state).toMatchObject({ status: "error", error: { message: "Unknown tool: first" } })
    const requests = yield* llm.inputs
    expect(JSON.stringify(requests[1]?.messages)).toContain("Unknown tool: first")
    expect(JSON.stringify(requests[1]?.messages)).toContain(JSON.stringify(tool?.id))
    expect(
      (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "assistant"),
    ).toHaveLength(0)

    const { db } = yield* Database.Service
    const durableEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
    // An unregistered name has no executor. Core rejects it before proposing
    // an Action; do not recreate the legacy successful `invalid` tool action.
    expect(durableEvents.filter((row) => row.type === "agent.action.proposed.1")).toHaveLength(0)
  }),
)

formalIntegration.instance(
  "Formal settles one Core StructuredOutput after a bounded semantic correction",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Return the company record." }],
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { company: { type: "string" }, founded: { type: "number" } },
            required: ["company", "founded"],
            additionalProperties: false,
          },
          retryCount: 1,
        },
      })
      yield* llm.push(
        reply().tool("StructuredOutput", { company: "Arforge" }),
        reply().tool("StructuredOutput", { company: "Arforge", founded: 2026 }),
      )

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(session.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(session.id))
      const result = context.findLast((message) => message.type === "assistant")
      expect(yield* llm.calls).toBe(2)
      expect(result?.type).toBe("assistant")
      expect(result?.structured).toEqual({ company: "Arforge", founded: 2026 })
      expect(result?.error).toBeUndefined()
      expect(result?.finish).toBe("stop")
      const formalParity = fromFormalParity(context, {
        terminalStatus: "completed",
        requestCount: 2,
      })
      const expectedParity = makeSessionParity({
        adapter: "provider-replay",
        terminalStatus: "completed",
        requestCount: 2,
        steps: [
          {
            finish: "error",
            hasText: false,
            hasReasoning: false,
            structured: false,
            failed: true,
            tools: [{ name: CoreStructuredOutput.name, status: "failed" }],
          },
          {
            finish: "stop",
            hasText: false,
            hasReasoning: false,
            structured: true,
            failed: false,
            tools: [{ name: CoreStructuredOutput.name, status: "completed" }],
          },
        ],
      })
      expect(compareSessionParity(expectedParity, formalParity).equivalent).toBe(true)
      expect(formalParity.traceDigest).toHaveLength(64)
      const requests = yield* llm.inputs
      expect(JSON.stringify(requests[0]?.tools)).toContain('"name":"StructuredOutput"')
      expect(JSON.stringify(requests[0]?.tools)).toContain('"founded"')
      expect(JSON.stringify(requests[1]?.messages)).toContain("founded")
    }),
  10_000,
)

formalIntegration.instance(
  "Formal stops after the exact StructuredOutput retry budget is exhausted",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Return one exact numeric answer." }],
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
            additionalProperties: false,
          },
          retryCount: 1,
        },
      })
      yield* llm.push(
        reply().text("The answer is four.").stop(),
        reply().tool("StructuredOutput", { answer: "still-four" }),
        reply().tool("StructuredOutput", { answer: 4 }),
      )

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(session.id))
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(session.id))
      const result = context.findLast((message) => message.type === "assistant")
      expect(yield* llm.calls).toBe(2)
      expect(yield* llm.pending).toBe(1)
      expect(result?.type).toBe("assistant")
      expect(result?.structured).toBeUndefined()
      expect(result?.error).toMatchObject({ message: CoreStructuredOutput.exhaustedMessage(1) })
      const requests = yield* llm.inputs
      expect(requests[0]?.tool_choice).toBe("required")
      expect(requests[1]?.tool_choice).toBe("required")
      expect(requests[1]?.tools).toEqual(requests[0]?.tools)
      expect(JSON.stringify(requests[0]?.messages)).toContain("1 structured-output retry")
      expect(JSON.stringify(requests[1]?.messages)).toContain("0 structured-output retries")
      const persisted = yield* sessions.messages({ sessionID: session.id })
      expect(persisted.find((message) => message.info.role === "user")?.info).toMatchObject({
        role: "user",
        format: { type: "json_schema", retryCount: 1 },
      })
    }),
  10_000,
)

formalIntegration.instance(
  "Formal write tool settles a scoped durable action before the run continues",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Durable write",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const target = path.join(dir, "gateway-write.txt")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "write the acceptance marker" }],
      })
      yield* llm.tool("write", { path: target, content: "action-gateway-ok\n" })
      yield* llm.text("done")

      yield* (yield* SessionExecution.Service).wakeAndWait(SessionV2.ID.make(session.id))

      const fs = yield* FSUtil.Service
      expect(yield* fs.readFileStringSafe(target)).toBe("action-gateway-ok\n")
      const { db } = yield* Database.Service
      const durableEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const proposed = durableEvents
        .filter((row) => row.type === "agent.action.proposed.1")
        .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
        .find(
          (event) =>
            "sessionID" in event.action && event.action.sessionID === session.id && event.action.name === "write",
        )
      const runID = proposed?.action.runID
      expect(runID).toBeDefined()
      expect(proposed?.action).toMatchObject({
        name: "write",
        runID,
        riskTier: "L2",
        authority: "scoped_grant",
        status: "proposed",
      })
      const actionEvents = durableEvents.filter((row) => row.aggregate_id === proposed?.actionID)
      expect(actionEvents.find((row) => row.type === "agent.action.observed.1")?.data).toMatchObject({
        observation: {
          status: "succeeded",
          outputDigest: expect.any(String),
          output: { encoding: "json", digest: expect.any(String), byteLength: expect.any(Number) },
        },
      })
      const transitions = actionEvents
        .filter((row) => row.type === "agent.action.state-changed.1")
        .map((row) => row.data)
      expect(transitions).toContainEqual(expect.objectContaining({ from: "awaiting_approval", to: "authorized" }))
      expect(transitions).toContainEqual(expect.objectContaining({ from: "authorized", to: "executing" }))
      expect(transitions).not.toContainEqual(expect.objectContaining({ from: "executing", to: "awaiting_approval" }))
      expect(transitions).toContainEqual(expect.objectContaining({ from: "observed", to: "settled" }))
      expect(yield* llm.calls).toBe(2)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((item) => item.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  15_000,
)

formalIntegration.instance(
  "Formal L2 write waits for the gateway preflight before the tool execution body starts",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const afs = yield* FSUtil.Service
      const session = yield* sessions.create({
        title: "L2 gateway preflight",
        permission: [{ permission: "edit", pattern: "*", action: "ask" }],
      })
      const target = path.join(dir, "preflight-write.txt")
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(session.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "write only after approval" }],
      })
      yield* llm.tool("write", { path: target, content: "must-not-run-before-approval\n" })
      yield* llm.text("permission handled")

      const fiber = yield* (yield* SessionExecution.Service)
        .wakeAndWait(SessionV2.ID.make(session.id))
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === session.id))),
        "L2 preflight permission was not requested",
      )

      expect(request).toMatchObject({
        action: "edit",
        source: { type: "tool" },
        metadata: { authority: "scoped_grant", filesystemScope: [target], riskTier: "L2" },
      })
      expect(request.resources).toHaveLength(1)
      expect(path.basename(request.resources[0] ?? "")).toBe(path.basename(target))
      expect(yield* afs.existsSafe(target)).toBe(false)

      const { db } = yield* Database.Service
      const pendingEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const proposed = pendingEvents
        .filter((row) => row.type === "agent.action.proposed.1")
        .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
        .find(
          (event) =>
            "sessionID" in event.action && event.action.sessionID === session.id && event.action.name === "write",
        )
      expect(proposed?.action.runID).toBeDefined()
      expect(proposed?.action.status).toBe("proposed")
      expect(
        pendingEvents.some(
          (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
        ),
      ).toBe(false)

      yield* permissions.reply({ requestID: request.id, reply: "reject" })
      yield* awaitWithTimeout(Fiber.await(fiber), "L2 preflight rejection did not settle the loop", "10 seconds")
      expect(yield* afs.existsSafe(target)).toBe(false)
      const finalEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(
        finalEvents.filter(
          (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
        ),
      ).toHaveLength(0)
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(session.id))
      const tools = context
        .flatMap((item) => (item.type === "assistant" ? item.content : []))
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ name: "write", state: { status: "error" } })
      expect(yield* permissions.list()).toHaveLength(0)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((item) => item.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  15_000,
)

formalIntegration.instance(
  "Formal L3 shell waits for the gateway preflight before spawning a command",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const afs = yield* FSUtil.Service
      const session = yield* sessions.create({
        title: "L3 gateway preflight",
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(session.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      const marker = path.join(dir, "preflight-shell.txt")
      const command = `echo must-not-run > "${marker}"`
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run only after approval" }],
      })
      yield* llm.tool("bash", { command, workdir: dir })
      yield* llm.text("permission handled")

      const fiber = yield* (yield* SessionExecution.Service)
        .wakeAndWait(SessionV2.ID.make(session.id))
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === session.id))),
        "L3 preflight permission was not requested",
      )

      expect(request).toMatchObject({
        action: "bash",
        resources: [command],
        source: { type: "tool" },
        requiresHumanConfirmation: true,
        metadata: { riskTier: "L3" },
      })
      expect(yield* afs.existsSafe(marker)).toBe(false)

      const { db } = yield* Database.Service
      const pendingEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const proposed = pendingEvents
        .filter((row) => row.type === "agent.action.proposed.1")
        .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
        .find(
          (event) =>
            "sessionID" in event.action && event.action.sessionID === session.id && event.action.name === "bash",
        )
      expect(proposed?.action.runID).toBeDefined()
      expect(proposed?.action.riskTier).toBe("L3")
      expect(
        pendingEvents.some(
          (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
        ),
      ).toBe(false)

      yield* permissions.reply({ requestID: request.id, reply: "reject" })
      yield* awaitWithTimeout(Fiber.await(fiber), "L3 preflight rejection did not settle the loop", "10 seconds")
      expect(yield* afs.existsSafe(marker)).toBe(false)
      const finalEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(
        finalEvents.filter(
          (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
        ),
      ).toHaveLength(0)
      expect(yield* permissions.list()).toHaveLength(0)
    }),
  15_000,
)

formalIntegration.instance(
  "Formal approved L2 preflight satisfies the same exact leaf scope without prompting twice",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const legacyPermissions = yield* Permission.Service
      const afs = yield* FSUtil.Service
      const session = yield* sessions.create({
        title: "L2 exact scope reuse",
        permission: [{ permission: "edit", pattern: "*", action: "ask" }],
      })
      const target = path.join(dir, "preflight-approved-write.txt")
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(session.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "write after one approval" }],
      })
      yield* llm.tool("write", { path: target, content: "approved-once\n" })
      yield* llm.text("done")

      const fiber = yield* (yield* SessionExecution.Service)
        .wakeAndWait(SessionV2.ID.make(session.id))
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === session.id))),
        "L2 preflight permission was not requested",
      )
      yield* permissions.reply({ requestID: request.id, reply: "once" })
      yield* awaitWithTimeout(Fiber.await(fiber), "approved L2 action did not finish", "10 seconds")

      expect(yield* afs.readFileStringSafe(target)).toBe("approved-once\n")
      expect(yield* legacyPermissions.list()).toHaveLength(0)
      expect(yield* permissions.list()).toHaveLength(0)
      expect(yield* llm.calls).toBe(2)
    }),
  15_000,
)

formalIntegration.instance(
  "Formal preserves a completed write across provider EOF and explicit continuation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const afs = yield* FSUtil.Service
      const chat = yield* sessions.create({
        title: "Write before network failure",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const target = path.join(dir, "completed-before-eof.txt")
      yield* llm.tool("write", { path: target, content: "written once\n" })
      yield* llm.push(raw({}))
      const failed = yield* prompt
        .prompt({
          sessionID: chat.id,
          parts: [{ type: "text", text: "Write the requested file then report completion" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const before = yield* core.messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
      const failure = before.findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(JSON.stringify(failure?.error)).toContain("Provider stream ended without a terminal finish event")
      const tools = before
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe("write")
      expect(tools[0].state).toMatchObject({ status: "completed" })
      expect(yield* afs.readFileStringSafe(target)).toBe("written once\n")
      const actions = yield* DurableAction.Service
      const settled = yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })
      expect(settled).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)
      yield* writeText(target, "user changed this after failure\n")
      yield* llm.text("The file was already written")
      yield* prompt.prompt({
        sessionID: chat.id,
        parts: [{ type: "text", text: "Continue reporting the existing result; do not write again" }],
      })
      const after = yield* core.messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
      const answer = after.findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(answer?.error).toBeUndefined()
      expect(answer?.content.some((part) => part.type === "text" && part.text === "The file was already written")).toBe(
        true,
      )
      const remaining = after
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
      expect(remaining).toEqual(tools)
      expect(yield* afs.readFileStringSafe(target)).toBe("user changed this after failure\n")
      expect(yield* actions.list({ sessionID: SessionV2.ID.make(chat.id) })).toEqual(settled)
      expect(yield* llm.calls).toBe(3)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal glob tool keeps the active workspace context",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Glob context",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const file = path.join(dir, "probe.txt")
      yield* writeText(file, "probe")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find text files" }],
      })
      yield* llm.tool("glob", { pattern: "**/*.txt" })
      yield* llm.text("done")

      const execution = yield* SessionExecution.Service
      const core = yield* SessionV2.Service
      yield* execution.wakeAndWait(SessionV2.ID.make(session.id))
      const msgs = yield* core.messages({ sessionID: SessionV2.ID.make(session.id), order: "asc" })
      const assistants = msgs.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      const tools = assistants
        .flatMap((message) => message.content)
        .filter((part): part is SessionMessage.AssistantTool => part.type === "tool")
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe("glob")
      expect(tools[0].state.status).toBe("completed")
      if (tools[0].state.status !== "completed") throw new Error("Formal glob did not complete")
      expect(tools[0].state.content.some((part) => part.type === "text" && part.text.includes(file))).toBe(true)
      expect(assistants[1].content.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      expect(yield* llm.calls).toBe(2)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal continues after a stop finish containing a real tool call",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      const file = path.join(dir, "stop-tool.txt")
      yield* writeText(file, "probe")
      yield* llm.push(reply().tool("glob", { pattern: "stop-tool.txt" }).stop())
      yield* llm.text("second")

      const execution = yield* SessionExecution.Service
      const core = yield* SessionV2.Service
      yield* execution.wakeAndWait(SessionV2.ID.make(session.id))
      expect(yield* llm.calls).toBe(2)
      const msgs = yield* core.messages({ sessionID: SessionV2.ID.make(session.id), order: "asc" })
      const assistants = msgs.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      const tool = assistants[0].content.find((part): part is SessionMessage.AssistantTool => part.type === "tool")
      expect(tool?.name).toBe("glob")
      expect(tool?.state.status).toBe("completed")
      if (!tool || tool.state.status !== "completed") throw new Error("Formal stop/tool continuation did not complete")
      expect(tool?.state.content.some((part) => part.type === "text" && part.text.includes(file))).toBe(true)
      expect(assistants[1].content.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(assistants[1].finish).toBe("stop")
      const requests = yield* llm.inputs
      expect(JSON.stringify(requests[1]?.messages)).toContain(JSON.stringify(file).slice(1, -1))
      expect(JSON.stringify(requests[1]?.messages)).toContain(JSON.stringify(tool.id))
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal failed subtask preserves metadata on error tool state",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.error(400, { error: { message: "The requested child model is unavailable" } })
      yield* llm.text("done")
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "subtask",
            prompt: "look into the cache key path",
            description: "inspect bug",
            agent: "general",
            model: ref,
          },
        ],
      })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const taskMsg = msgs.find((item) => item.type === "assistant" && item.agent === "general")
      expect(taskMsg?.type).toBe("assistant")
      if (!taskMsg || taskMsg.type !== "assistant") return yield* Effect.die("Missing failed task assistant")
      const tool = taskMsg.content.find((part) => part.type === "tool")
      expect(tool?.state.status).toBe("error")
      if (!tool || tool.state.status !== "error") return yield* Effect.die("Missing failed task tool")
      expect(tool.state.error.message).toContain("The requested child model is unavailable")
      expect(tool.state.structured?.sessionId).toBeDefined()
      expect(tool.state.structured?.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("missing-model"),
      })
      expect((yield* llm.inputs)[0]?.model).toBe("missing-model")
    }),
  15_000,
)

formalIntegration.instance(
  "Formal subtask child does not inherit parent external_directory allow without an explicit capability",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Parent",
        permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
      })
      yield* llm.text("child done")
      yield* llm.text("parent done")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "subtask",
            prompt: "look into the cache key path",
            description: "inspect bug",
            agent: "general",
            model: ref,
          },
        ],
      })
      const history = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      expect(yield* llm.calls).toBe(2)
      const tool = history
        .flatMap((item) => (item.type === "assistant" ? item.content : []))
        .find((part) => part.type === "tool")
      expect(tool?.state.status).toBe("completed")

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      const child = kids[0]!
      const rules = child.permission ?? []
      expect(
        rules.some(
          (rule) =>
            rule.permission === "external_directory" && rule.pattern === "/tmp/allowed/*" && rule.action === "allow",
        ),
      ).toBe(false)
      expect(Permission.evaluate("read", "README.md", rules).action).toBe("allow")
      expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("deny")
      expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
    }),
)

for (const approved of [false, true]) {
  formalIntegration.instance(
    `Formal scheduled subtask is durably authorized before the child task can start approved=${approved}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const legacyPermissions = yield* Permission.Service
        const chat = yield* sessions.create({
          title: "Durable scheduled subtask",
          permission: [{ permission: "task", pattern: "*", action: "ask" }],
        })
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
        const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
        if (approved) {
          yield* llm.text("approved child done")
          yield* llm.text("parent done")
        } else yield* llm.text("continue after the rejected subtask")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "hello" },
            {
              type: "subtask",
              prompt: "look into the cache key path",
              description: "inspect bug",
              agent: "general",
              model: ref,
            },
          ],
        })
        const fiber = yield* (yield* SessionExecution.Service)
          .wakeAndWait(SessionV2.ID.make(chat.id))
          .pipe(Effect.forkChild)
        const request = yield* pollWithTimeout(
          permissions
            .list()
            .pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id && item.action === "task"))),
          "scheduled subtask durable permission was not requested",
        )
        expect(request).toMatchObject({
          action: "task",
          resources: ["general"],
          source: { type: "tool" },
          metadata: { source: "action-gateway-preflight", tool: "task", riskTier: "L2" },
        })
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
        expect(yield* legacyPermissions.list()).toHaveLength(0)
        expect(yield* llm.calls).toBe(0)

        const { db } = yield* Database.Service
        const pendingEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
        const proposed = pendingEvents
          .filter((row) => row.type === "agent.action.proposed.1")
          .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
          .find(
            (event) =>
              "sessionID" in event.action && event.action.sessionID === chat.id && event.action.name === "task",
          )
        const runID = proposed?.action.runID
        expect(runID).toBeDefined()
        expect(proposed?.action).toMatchObject({ runID, name: "task", riskTier: "L2", status: "proposed" })
        expect(
          pendingEvents.some(
            (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
          ),
        ).toBe(false)

        yield* permissions.reply({ requestID: request.id, reply: approved ? "once" : "reject" })
        yield* awaitWithTimeout(Fiber.await(fiber), "scheduled subtask authorization did not settle", "10 seconds")
        expect(yield* sessions.children(chat.id)).toHaveLength(approved ? 1 : 0)
        expect(yield* llm.calls).toBe(approved ? 2 : 1)
        expect(yield* permissions.list()).toHaveLength(0)
        const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
        const tools = context.flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        expect(tools).toHaveLength(1)
        expect(tools[0]?.state.status).toBe(approved ? "completed" : "error")
        expect(context.findLast((message) => message.type === "assistant")?.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: approved ? "parent done" : "continue after the rejected subtask",
            }),
          ]),
        )
        const settledEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
        expect(
          settledEvents.filter(
            (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1",
          ),
        ).toHaveLength(approved ? 1 : 0)
        // SQLite insertion order is a test-only witness across the Action and
        // Session aggregates. The UI's canonical success must follow the
        // confirmed post receipt, not an earlier legacy shadow completion.
        const ordered = yield* db
          .select({
            position: sql<number>`rowid`,
            aggregateID: EventTable.aggregate_id,
            type: EventTable.type,
            data: EventTable.data,
          })
          .from(EventTable)
          .all()
          .pipe(Effect.orDie)
        const subject = proposed?.action.subject
        if (subject?.type !== "session") return yield* Effect.die("scheduled Action subject is missing")
        const confirmed = ordered.filter(
          (row) =>
            row.aggregateID === proposed?.actionID &&
            row.type === EventV2.versionedType(AgentRuntime.Event.ActionPostProcessingRecorded.type, 1) &&
            Schema.decodeUnknownSync(AgentRuntime.Event.ActionPostProcessingRecorded.data)(row.data).processing
              .state === "completed",
        )
        const shown = ordered.filter(
          (row) =>
            row.aggregateID === chat.id &&
            row.type === EventV2.versionedType(SessionEvent.Tool.Success.type, 1) &&
            row.data.callID === subject.toolCallID,
        )
        expect(confirmed).toHaveLength(approved ? 1 : 0)
        expect(shown).toHaveLength(approved ? 1 : 0)
        if (approved) {
          if (!confirmed[0] || !shown[0]) return yield* Effect.die("scheduled completion witnesses are missing")
          expect(confirmed[0].position).toBeLessThan(shown[0].position)
        }
      }),
    15_000,
  )
}

formalIntegration.instance(
  "Formal scheduled subtask recovery reuses the persisted assistant, call identity, and action",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Recover durable scheduled subtask",
        permission: [{ permission: "task", pattern: "*", action: "ask" }],
      })
      // Establish the real semantic epoch before seeding the interrupted turn.
      yield* llm.text("baseline complete")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "baseline" }] })
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      yield* llm.text("continue after recovered subtask")
      const admitted = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello" },
          {
            type: "subtask",
            prompt: "look into the cache key path",
            description: "inspect bug",
            agent: "general",
            model: ref,
          },
        ],
      })
      const source = admitted.parts.find((part) => part.type === "subtask")
      if (!source) return yield* Effect.die("Scheduled source was not admitted")
      const { db } = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      expect(
        yield* SessionInput.promoteSteers(
          db,
          events,
          SessionV2.ID.make(chat.id),
          yield* EventV2.latestSequence(db, chat.id),
        ),
      ).toBe(1)

      // Simulate a process stopping after the scheduled assistant/tool identity
      // was persisted but before Action Gateway completed authorization.
      const assistantMessageID = SessionMessage.ID.make(
        `msg_${createHash("sha256").update(`${chat.id}\u0000${source.id}`).digest("hex").slice(0, 32)}`,
      )
      const common = { sessionID: SessionV2.ID.make(chat.id), timestamp: yield* DateTime.now, assistantMessageID }
      const args = { prompt: source.prompt, description: source.description, subagent_type: source.agent }
      yield* events.publish(SessionEvent.Step.Started, {
        ...common,
        agent: "general",
        model: { id: ref.modelID, providerID: ref.providerID },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...common, callID: source.id, name: "task" })
      yield* events.publish(SessionEvent.Tool.Input.Ended, { ...common, callID: source.id, text: JSON.stringify(args) })
      yield* events.publish(SessionEvent.Tool.Called, {
        ...common,
        callID: source.id,
        tool: "task",
        input: args,
        provider: { executed: false },
      })
      const fiber = yield* (yield* SessionExecution.Service).resume(SessionV2.ID.make(chat.id)).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions
          .list()
          .pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id && item.action === "task"))),
        "recovered scheduled subtask permission was not requested",
      )

      const messages = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const attempts = messages.filter(
        (item): item is SessionMessage.Assistant => item.type === "assistant" && item.agent === "general",
      )
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.id).toBe(assistantMessageID)
      expect(attempts[0]?.content.find((part) => part.type === "tool")).toMatchObject({ id: source.id, name: "task" })

      const proposed = (yield* db.select().from(EventTable).all().pipe(Effect.orDie))
        .filter((row) => row.type === "agent.action.proposed.1")
        .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
        .find(
          (event) => event.action.name === "task" && "sessionID" in event.action && event.action.sessionID === chat.id,
        )
      expect(proposed?.action).toMatchObject({ status: "proposed" })
      expect(proposed?.action.subject).toMatchObject({
        assistantMessageID,
        toolCallID: source.id,
      })

      yield* permissions.reply({ requestID: request.id, reply: "reject" })
      yield* awaitWithTimeout(Fiber.await(fiber), "recovered scheduled subtask rejection did not settle", "10 seconds")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(2)
      const persistedEvents = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(
        persistedEvents.filter(
          (row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.proposed.1",
        ),
      ).toHaveLength(1)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  15_000,
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

for (const scheduled of [false, true])
  formalIntegration.instance(
    `Formal running task preserves metadata and settles on cancellation scheduled=${scheduled}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const durable = yield* DurableRun.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const task = {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        }
        if (!scheduled) yield* llm.tool("task", task)
        yield* llm.hang
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "hello" },
            ...(scheduled
              ? [
                  {
                    type: "subtask" as const,
                    prompt: task.prompt,
                    description: task.description,
                    agent: "general",
                    model: ref,
                  },
                ]
              : []),
          ],
        })
        const id = SessionV2.ID.make(chat.id)
        const fiber = yield* execution.wakeAndWait(id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(scheduled ? 1 : 2), "child did not reach provider", "10 seconds")

        const tool = yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* core.context(id)
            const tool = msgs
              .flatMap((item) => (item.type === "assistant" ? item.content : []))
              .find((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "task")
            return tool?.state.status === "running" && tool.state.structured.sessionId ? tool : undefined
          }),
          "timed out waiting for running task metadata",
        )

        if (tool.state.status !== "running") return yield* Effect.die("running task metadata missing")
        const children = yield* sessions.children(chat.id)
        expect(children).toHaveLength(1)
        expect(tool.state.structured.sessionId).toBe(children[0].id)
        expect(tool.state.structured.title).toBe("inspect bug")
        expect(tool.state.structured.model).toEqual(ref)

        yield* prompt.cancel(chat.id)
        yield* awaitWithTimeout(Fiber.await(fiber), "parent did not stop after cancellation", "10 seconds")
        const runs = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(children[0].id) })
        expect(runs).toHaveLength(1)
        expect(runs[0]?.run.status).toBe("cancelled")
        expect(runs[0]?.activeAttempt).toBeUndefined()
        expect(runs[0]?.lease).toBeUndefined()
        const completedContext = yield* core.context(id)
        const taskAssistant = completedContext.find(
          (item): item is SessionMessage.Assistant =>
            item.type === "assistant" && item.content.some((part) => part.type === "tool" && part.id === tool.id),
        )
        const finalTool = taskAssistant?.content.find(
          (part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === tool.id,
        )
        expect(finalTool?.state.status).toBe("error")
        expect(taskAssistant?.time.completed).toBeDefined()
        expect(finalTool?.state.status === "error" && finalTool.state.structured.sessionId).toBe(children[0].id)
        expect((yield* (yield* BackgroundJob.Service).get(children[0].id))?.status).toBe("cancelled")
        expect((yield* execution.active).has(id)).toBe(false)
        const pausedRuns = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(chat.id) })
        yield* execution.wakeAndWait(id)
        yield* execution.wakeAndWait(id)
        expect(yield* core.context(id)).toEqual(completedContext)
        expect(yield* durable.list({ sessionID: DurableSessionSchema.ID.make(chat.id) })).toEqual(pausedRuns)
        expect(yield* llm.calls).toBe(scheduled ? 1 : 2)
        yield* llm.text("Explicitly resumed after cancellation")
        yield* execution.resume(id)
        expect(yield* llm.calls).toBe(scheduled ? 2 : 3)
        expect(JSON.stringify(yield* core.context(id))).toContain("Explicitly resumed after cancellation")
        expect(
          (yield* sessions.messages({ sessionID: chat.id })).filter((item) => item.info.role === "assistant"),
        ).toHaveLength(0)
      }),
    20_000,
  )

formalIntegration.instance(
  "Formal projects busy then idle around public cancellation",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const execution = yield* SessionExecution.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      const id = SessionV2.ID.make(chat.id)
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", noReply: true, parts: [{ type: "text", text: "hi" }] })
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* execution.active).has(id)).toBe(false)

      const fiber = yield* execution.wakeAndWait(id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "provider did not start", "10 seconds")
      expect((yield* status.get(chat.id)).type).toBe("busy")
      expect((yield* execution.active).has(id)).toBe(true)
      yield* prompt.cancel(chat.id)
      yield* awaitWithTimeout(Fiber.await(fiber), "cancelled execution did not settle", "10 seconds")
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* execution.active).has(id)).toBe(false)
      expect(yield* llm.calls).toBe(1)
    }),
  15_000,
)

// Cancel semantics

for (const priorTurn of [false, true]) {
  formalIntegration.instance(
    `Formal public cancellation persists interruption${priorTurn ? " without changing prior history" : " on the first turn"}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const execution = yield* SessionExecution.Service
        const chat = yield* sessions.create({ title: "Canonical cancelled history" })
        const id = SessionV2.ID.make(chat.id)
        if (priorTurn) {
          yield* llm.text("completed history")
          yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "First request" }] })
        }
        const before = yield* core.messages({ sessionID: id, order: "asc" })
        yield* llm.push(reply().text("partial cancelled answer").hang())
        const running = yield* prompt
          .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "More" }] })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(priorTurn ? 2 : 1), "provider did not start", "10 seconds")
        yield* pollWithTimeout(
          core
            .messages({ sessionID: id, order: "asc" })
            .pipe(
              Effect.map((messages) =>
                messages.filter((message) => message.type === "assistant").length === (priorTurn ? 2 : 1)
                  ? true
                  : undefined,
              ),
            ),
          "new assistant did not start",
        )
        yield* prompt.cancel(chat.id)
        const exit = yield* awaitWithTimeout(
          Fiber.await(running),
          "public prompt did not finish after cancellation",
          "10 seconds",
        )
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        const after = yield* core.messages({ sessionID: id, order: "asc" })
        expect(after.slice(0, before.length)).toEqual(before)
        const latest = after.findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
        expect(latest?.error).toEqual({ type: "unknown", message: "Provider turn interrupted" })
        expect(latest?.time.completed).toBeDefined()
        expect(latest?.content.some((part) => part.type === "text" && part.text === "partial cancelled answer")).toBe(
          true,
        )
        expect((yield* execution.active).has(id)).toBe(false)
        expect(yield* llm.calls).toBe(priorTurn ? 2 : 1)
        yield* prompt.cancel(chat.id)
        expect(yield* core.messages({ sessionID: id, order: "asc" })).toEqual(after)
        expect(yield* llm.calls).toBe(priorTurn ? 2 : 1)
        expect(
          (yield* sessions.messages({ sessionID: chat.id })).filter((message) => message.info.role === "assistant"),
        ).toHaveLength(0)
      }),
    30_000,
  )
}

formalIntegration.instance(
  "Formal cancellation before response content requires an explicit unknown-outcome decision",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const runs = yield* DurableRun.Service
      const chat = yield* sessions.create({ title: "No response before cancellation" })
      const id = SessionV2.ID.make(chat.id)
      for (const turn of [1, 2]) {
        yield* llm.push(raw({ hang: true }))
        const fiber = yield* prompt
          .prompt({ sessionID: chat.id, parts: [{ type: "text", text: `cancel turn ${turn}` }] })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          llm
            .wait(turn)
            .pipe(
              Effect.raceFirst(
                Fiber.join(fiber).pipe(
                  Effect.andThen(Effect.die(new Error(`cancel turn ${turn} ended before its provider request`))),
                ),
              ),
            ),
          `provider request did not start for cancellation turn ${turn}`,
          "10 seconds",
        )
        expect(
          (yield* core.messages({ sessionID: id, order: "asc" })).filter((message) => message.type === "assistant"),
        ).toHaveLength(0)
        yield* prompt.cancel(chat.id)
        const exit = yield* awaitWithTimeout(
          Fiber.await(fiber),
          "empty response cancellation did not finish",
          "10 seconds",
        )
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect((yield* execution.active).has(id)).toBe(false)
        const snapshots = yield* runs.list({ sessionID: id })
        expect(snapshots.length).toBeGreaterThan(0)
        const paused = snapshots.filter((snapshot) => snapshot.run.status === "paused")
        expect(paused).toHaveLength(1)
        expect(paused[0]?.lease).toBeUndefined()
        expect(
          (yield* core.messages({ sessionID: id, order: "asc" })).filter((message) => message.type === "assistant"),
        ).toHaveLength(0)
        expect(yield* llm.calls).toBe(turn)
        const recovery = (yield* runs.sessionRecovery(id))[0]
        expect(recovery.request?.outcome).toBe("unknown")
        if (!recovery.request) return yield* Effect.die("Unknown request metadata missing after cancellation")
        const abandoned = yield* runs.abandonSessionRequest({
          sessionID: id,
          runID: recovery.runID,
          expectedSequence: recovery.revision,
          requestEventID: recovery.request.eventID,
          requestDigest: recovery.request.digest,
          acknowledgeUnknownOutcome: true,
        })
        expect(abandoned.run.status).toBe("cancelled")
        expect(yield* llm.calls).toBe(turn)
      }
      yield* llm.text("only the new answer")
      yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Now answer this new request" }] })
      const messages = yield* core.messages({ sessionID: id, order: "asc" })
      expect(messages.filter((message) => message.type === "user")).toHaveLength(3)
      const answers = messages.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      expect(answers).toHaveLength(1)
      expect(answers[0].error).toBeUndefined()
      expect(answers[0].content.some((part) => part.type === "text" && part.text === "only the new answer")).toBe(true)
      expect(yield* llm.calls).toBe(3)
      expect((yield* execution.active).has(id)).toBe(false)
    }),
  30_000,
)

formalIntegration.instance(
  "Formal abandons an inspected unknown request without replay and accepts only new input afterward",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const runs = yield* DurableRun.Service
      const execution = yield* SessionExecution.Service
      const core = yield* SessionV2.Service
      const chat = yield* sessions.create({ title: "Explicit unknown request decision" })
      const sessionID = SessionV2.ID.make(chat.id)
      yield* llm.push(raw({ hang: true }))
      const running = yield* prompt
        .prompt({ sessionID: chat.id, parts: [{ type: "text", text: "original unknown request" }] })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(
        llm.wait(1).pipe(Effect.raceFirst(Fiber.join(running))),
        "request did not start",
        "10 seconds",
      )
      yield* prompt.cancel(chat.id)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      const before = (yield* runs.list({ sessionID }))[0]
      expect(before.run.status).toBe("paused")
      const inspected = (yield* runs.sessionRecovery(sessionID))[0]
      expect(inspected.request?.abandonmentBlocker).toBeNull()
      if (!inspected.request) return yield* Effect.die("Unknown request metadata missing")
      const decision = {
        sessionID,
        runID: before.run.id,
        expectedSequence: inspected.revision,
        requestEventID: inspected.request.eventID,
        requestDigest: inspected.request.digest,
        acknowledgeUnknownOutcome: true,
      }
      for (const changed of [
        { acknowledgeUnknownOutcome: false },
        { expectedSequence: inspected.revision + 1 },
        { requestDigest: "b".repeat(64) },
      ]) {
        expect(Exit.isFailure(yield* runs.abandonSessionRequest({ ...decision, ...changed }).pipe(Effect.exit))).toBe(
          true,
        )
        expect(yield* runs.load(before.run.id)).toEqual(before)
      }
      const abandoned = yield* runs.abandonSessionRequest(decision)
      expect(abandoned.run.status).toBe("cancelled")
      expect(abandoned.run.budget).toEqual(before.run.budget)
      expect(abandoned.checkpoint).toEqual(before.checkpoint)
      expect(abandoned.lastSequence).toBe(before.lastSequence + 1)
      expect(yield* llm.calls).toBe(1)
      expect(Exit.isFailure(yield* execution.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(yield* runs.load(before.run.id)).toEqual(abandoned)
      expect(yield* llm.calls).toBe(1)
      yield* llm.text("new explicit answer")
      yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Only answer this new question" }] })
      const messages = yield* core.context(sessionID)
      expect(messages.filter((message) => message.type === "user")).toHaveLength(2)
      expect(messages.filter((message) => message.type === "assistant")).toMatchObject([
        { content: [{ type: "text", text: "new explicit answer" }] },
      ])
      expect(yield* llm.calls).toBe(2)
      const finalRuns = yield* runs.list({ sessionID })
      expect(finalRuns).toHaveLength(2)
      expect(finalRuns.find((item) => item.run.id !== before.run.id)?.run.status).toBe("completed")
      expect(yield* runs.load(before.run.id)).toEqual(abandoned)
    }),
  30_000,
)

preparationRace.instance(
  "Formal cancellation during model preparation sends no request and permits the next turn",
  () =>
    Effect.gen(function* () {
      modelPreparationStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          modelPreparationStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { llm } = yield* useServerConfig(providerCfg)
      const core = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const status = yield* SessionStatus.Service
      const runs = yield* DurableRun.Service
      const chat = yield* sessions.create({ title: "Model preparation cancellation" })
      const id = SessionV2.ID.make(chat.id)
      for (const turn of [1, 2]) {
        const ready = yield* Deferred.make<void>()
        modelPreparationStarted.push(ready)
        const fiber = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: `cancel preparation ${turn}` }] })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(ready), "model preparation did not start", "10 seconds")
        expect((yield* execution.active).has(id)).toBe(true)
        expect(yield* llm.calls).toBe(0)
        yield* prompt.cancel(chat.id)
        const exit = yield* awaitWithTimeout(Fiber.await(fiber), "preparation did not cancel", "10 seconds")
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect((yield* execution.active).has(id)).toBe(false)
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const snapshots = yield* runs.list({ sessionID: id })
        expect(snapshots.length).toBeGreaterThan(0)
        expect(snapshots.every((item) => item.run.status === "paused" && item.lease === undefined)).toBe(true)
        expect((yield* core.context(id)).filter((item) => item.type === "assistant")).toHaveLength(0)
        expect(yield* llm.calls).toBe(0)
      }
      yield* llm.text("answer after preparation cancellation")
      yield* prompt.prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "answer now" }] })
      const messages = yield* core.context(id)
      const assistants = messages.filter((item): item is SessionMessage.Assistant => item.type === "assistant")
      expect(assistants).toHaveLength(1)
      expect(assistants[0].error).toBeUndefined()
      expect(assistants[0].content).toContainEqual(
        expect.objectContaining({ type: "text", text: "answer after preparation cancellation" }),
      )
      expect(yield* llm.calls).toBe(1)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((item) => item.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  20_000,
)

formalIntegration.instance(
  "Formal public cancellation propagates from slash command to its child and allows a new turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        command: { review: { template: "Review $ARGUMENTS", description: "Review", agent: "general", subtask: true } },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const execution = yield* SessionExecution.Service
      const core = yield* SessionV2.Service
      const durable = yield* DurableRun.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      const id = SessionV2.ID.make(chat.id)
      const fiber = yield* prompt
        .command({ sessionID: chat.id, command: "review", arguments: "file", agent: "build" })
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "slash child did not start", "10 seconds")
      const msgs = yield* core.context(id)
      const tool = msgs
        .flatMap((item) => (item.type === "assistant" ? item.content : []))
        .find((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "task")
      const sessionID = tool?.state.status === "running" ? tool.state.structured.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      yield* awaitWithTimeout(Fiber.await(fiber), "slash command did not settle after cancellation", "10 seconds")

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
      expect((yield* execution.active).has(id)).toBe(false)
      const snapshots = yield* durable.list({ sessionID: DurableSessionSchema.ID.make(childID) })
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.run.status).toBe("cancelled")
      expect(snapshots[0]?.lease).toBeUndefined()
      expect(snapshots[0]?.activeAttempt).toBeUndefined()
      const after = yield* core.context(id)
      const settled = after
        .flatMap((item) => (item.type === "assistant" ? item.content : []))
        .find((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.id === tool?.id)
      expect(settled?.state.status).toBe("error")
      const taskAssistant = after.find(
        (item) =>
          item.type === "assistant" && item.content.some((part) => part.type === "tool" && part.id === tool?.id),
      )
      expect(taskAssistant?.type === "assistant" && taskAssistant.time.completed !== undefined).toBe(true)
      expect(settled?.state.status === "error" && settled.state.structured.sessionId).toBe(childID)
      expect(yield* llm.calls).toBe(1)
      yield* prompt.cancel(chat.id)
      expect(yield* core.context(id)).toEqual(after)
      yield* llm.text("new turn after cancelled slash")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Answer without another child" }],
      })
      const answer = (yield* core.context(id)).findLast(
        (item): item is SessionMessage.Assistant => item.type === "assistant",
      )
      expect(answer?.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "new turn after cancelled slash" }),
      )
      expect(yield* sessions.children(chat.id)).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((item) => item.info.role === "assistant"),
      ).toHaveLength(0)
    }),
  20_000,
)

for (const cancelVia of ["execution", "prompt"] as const) {
  formalIntegration.instance(
    `Formal cancellation via ${cancelVia} settles concurrent callers and permits a new user turn`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const execution = yield* SessionExecution.Service
        const core = yield* SessionV2.Service
        const id = SessionV2.ID.make(chat.id)
        yield* llm.push(reply().text("partial before cancel").hang())
        yield* prompt.admit({ sessionID: chat.id, parts: [{ type: "text", text: "hello" }] })
        const first = yield* execution.resume(id).pipe(Effect.forkChild)
        const second = yield* execution.resume(id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(1), "cancelled request did not start", "10 seconds")
        yield* pollWithTimeout(
          core
            .messages({ sessionID: id, order: "asc" })
            .pipe(
              Effect.map((messages) => (messages.some((message) => message.type === "assistant") ? true : undefined)),
            ),
          "assistant did not start before cancel",
        )
        if (cancelVia === "prompt") yield* prompt.cancel(chat.id)
        else yield* execution.interrupt(id)
        expect((yield* execution.active).has(id)).toBe(false)
        const exitA = yield* awaitWithTimeout(Fiber.await(first), "first cancelled caller did not finish", "10 seconds")
        const exitB = yield* awaitWithTimeout(
          Fiber.await(second),
          "second cancelled caller did not finish",
          "10 seconds",
        )
        expect(Exit.isFailure(exitA)).toBe(true)
        expect(Exit.isFailure(exitB)).toBe(true)
        if (Exit.isFailure(exitA) && Exit.isFailure(exitB)) {
          expect(Cause.hasInterrupts(exitA.cause)).toBe(true)
          expect(Cause.hasInterrupts(exitB.cause)).toBe(true)
        }
        expect((yield* execution.active).has(id)).toBe(false)
        const before = yield* core.messages({ sessionID: id, order: "asc" })
        const cancelled = before.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        expect(cancelled).toHaveLength(1)
        expect(cancelled[0].error).toBeDefined()
        expect(yield* llm.calls).toBe(1)
        yield* llm.text("new turn after cancellation")
        yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Start a new turn" }] })
        const after = yield* core.messages({ sessionID: id, order: "asc" })
        const answers = after.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        expect(answers).toHaveLength(2)
        expect(answers[0]).toEqual(cancelled[0])
        expect(
          answers[1].content.some((part) => part.type === "text" && part.text === "new turn after cancellation"),
        ).toBe(true)
        expect(yield* llm.calls).toBe(2)
        expect((yield* execution.active).has(id)).toBe(false)
      }),
    30_000,
  )
}

// Queue semantics

formalIntegration.instance(
  "Formal concurrent wake callers observe the same completed result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const chat = yield* sessions.create({ title: "Completed shared result" })
      yield* llm.text("one completed result")
      yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "Reply once" }] })
      const observe = Effect.gen(function* () {
        yield* execution.wakeAndWait(SessionV2.ID.make(chat.id))
        return yield* core.context(SessionV2.ID.make(chat.id))
      })
      const [a, b] = yield* Effect.all([observe, observe], {
        concurrency: "unbounded",
      })

      expect(a).toEqual(b)
      expect(a.filter((message) => message.type === "assistant")).toHaveLength(1)
      expect(yield* llm.hits).toHaveLength(1)
      expect((yield* execution.active).has(SessionV2.ID.make(chat.id))).toBe(false)
    }),
  30_000,
)

for (const scenario of ["invalid", "empty EOF", "partial EOF", "connection reset"] as const) {
  formalIntegration.instance(
    `Formal concurrent resume callers receive and persist the same ${scenario} response failure`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        const gate = yield* Deferred.make<void>()
        yield* llm.push(
          raw({
            wait: deferredAsPromise(gate),
            reset: scenario === "connection reset",
            head: scenario === "connection reset" ? [{ choices: [{ delta: { content: "partial answer" } }] }] : [],
            tail:
              scenario === "invalid"
                ? [{ invalid_fixture_response: true }]
                : scenario === "partial EOF"
                  ? [{ choices: [{ delta: { content: "partial answer" } }] }]
                  : [],
          }),
        )
        yield* prompt.admit({ sessionID: chat.id, parts: [{ type: "text", text: "hello" }] })
        const execution = yield* SessionExecution.Service
        const core = yield* SessionV2.Service
        const wait = Effect.gen(function* () {
          const exit = yield* execution.resume(SessionV2.ID.make(chat.id)).pipe(Effect.exit)
          const messages = yield* core.messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
          return { exit, messages }
        })
        const both = yield* Effect.all([wait, wait], { concurrency: "unbounded" }).pipe(Effect.forkChild)
        yield* awaitWithTimeout(llm.wait(1), "shared provider request did not start", "10 seconds")
        expect(yield* llm.calls).toBe(1)
        if (scenario === "connection reset") {
          yield* pollWithTimeout(
            core
              .messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
              .pipe(
                Effect.map((messages) => (messages.some((message) => message.type === "assistant") ? true : undefined)),
              ),
            "assistant did not start before connection reset",
          )
        }
        yield* Deferred.succeed(gate, undefined)
        const [a, b] = yield* Fiber.join(both).pipe(Effect.timeout("15 seconds"))
        expect(Exit.isFailure(a.exit)).toBe(true)
        expect(Exit.isFailure(b.exit)).toBe(true)
        if (Exit.isFailure(a.exit) && Exit.isFailure(b.exit)) {
          expect(Cause.squash(a.exit.cause)).toBe(Cause.squash(b.exit.cause))
        }
        expect(a.messages).toEqual(b.messages)
        const assistants = a.messages.filter(
          (message): message is SessionMessage.Assistant => message.type === "assistant",
        )
        expect(assistants).toHaveLength(1)
        expect(assistants[0].error).toBeDefined()
        expect(JSON.stringify(assistants[0].error)).toContain(
          scenario === "invalid"
            ? "Invalid test/openai-compatible-chat stream event"
            : scenario === "connection reset"
              ? "Failed to read test/openai-compatible-chat stream"
              : "Provider stream ended without a terminal finish event",
        )
        if (scenario === "partial EOF" || scenario === "connection reset") {
          expect(assistants[0].content.some((part) => part.type === "text" && part.text === "partial answer")).toBe(
            true,
          )
        }
        expect(yield* llm.calls).toBe(1)
        expect((yield* execution.active).has(SessionV2.ID.make(chat.id))).toBe(false)
        if (scenario === "connection reset") {
          yield* llm.text("continued after connection reset")
          yield* prompt.prompt({
            sessionID: chat.id,
            parts: [{ type: "text", text: "Continue after the network failure" }],
          })
          const resumed = yield* core.messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
          const responses = resumed.filter(
            (message): message is SessionMessage.Assistant => message.type === "assistant",
          )
          expect(responses).toHaveLength(2)
          expect(responses[0]).toEqual(assistants[0])
          expect(responses[1].error).toBeUndefined()
          expect(
            responses[1].content.some(
              (part) => part.type === "text" && part.text === "continued after connection reset",
            ),
          ).toBe(true)
          expect(yield* llm.calls).toBe(2)
          expect((yield* execution.active).has(SessionV2.ID.make(chat.id))).toBe(false)
        }
      }),
    30_000,
  )
}

formalIntegration.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const core = yield* SessionV2.Service
    const msgs = yield* core.messages({ sessionID: SessionV2.ID.make(chat.id), order: "asc" })
    const assistants = msgs.filter((msg): msg is SessionMessage.Assistant => msg.type === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last) throw new Error("expected second assistant")
    if (!Exit.isSuccess(eb) || eb.value.info.role !== "assistant") throw new Error("expected second prompt result")
    expect(eb.value.info.parentID).toBe(id)
    expect(last.content.some((part) => part.type === "text" && part.text === "second")).toBe(true)
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).filter((msg) => msg.info.role === "assistant"),
    ).toHaveLength(0)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
  }),
)

formalIntegration.instance("Formal session mutations reject while busy and succeed after cancellation", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const core = yield* SessionV2.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    const id = SessionV2.ID.make(chat.id)
    expect(yield* core.updateTags({ sessionID: id, tags: [] })).toEqual([])
    const fiber = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hi" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* core.updateTags({ sessionID: id, tags: [] }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionV2.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ sessionID: chat.id, operation: "update tags" })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
    expect(yield* core.updateTags({ sessionID: id, tags: [] })).toEqual([])
  }),
)

// Shell semantics

formalIntegration.instance("direct Shell requires a fresh L3 approval before it can start", () =>
  Effect.gen(function* () {
    const { prompt, sessions, chat } = yield* boot({
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    // Even the desktop full-access session mode must not skip an L3 direct
    // Shell confirmation; the gateway's forceAsk is the source of truth.
    const locations = yield* LocationServiceMap.Service
    const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
    const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
    const messageID = MessageID.ascending("msg_direct-shell-fresh-approval")
    const command = "node -e \"process.stdout.write('must-not-run')\""

    const fiber = yield* prompt.shell({ sessionID: chat.id, messageID, agent: "build", command }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(
      permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
      "direct Shell L3 approval was not requested",
    )
    expect(request).toMatchObject({
      action: "bash",
      resources: [command],
      requiresHumanConfirmation: true,
      metadata: { source: "action-gateway-preflight", scope: "opaque-user-shell", riskTier: "L3" },
    })

    const pending = yield* sessions.messages({ sessionID: chat.id })
    const assistant = pending.find((message) => message.info.id === `msg_shell_${messageID.slice("msg_".length)}`)
    expect(toolPart(assistant?.parts ?? [])?.state.status).toBe("pending")
    const { db } = yield* Database.Service
    const events = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
    const proposed = events
      .filter((row) => row.type === "agent.action.proposed.1")
      .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
      .find((event) => event.action.name === "shell")
    expect(
      events.some((row) => row.aggregate_id === proposed?.actionID && row.type === "agent.action.attempt-started.1"),
    ).toBe(false)

    yield* permissions.reply({ requestID: request.id, reply: "reject" })
    const exit = yield* awaitWithTimeout(Fiber.await(fiber), "direct Shell rejection did not settle", "10 seconds")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(errorTool(exit.value.parts)?.state.error).toContain("Permission denied")
  }),
)

formalIntegration.instance("direct Shell executes once after explicit approval and replays the settled result", () =>
  Effect.gen(function* () {
    const { prompt, chat } = yield* boot()
    const locations = yield* LocationServiceMap.Service
    const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
    const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
    const legacyPermissions = yield* Permission.Service
    const messageID = MessageID.ascending("msg_direct-shell-replay")
    const command = "node -e \"process.stdout.write(require('node:crypto').randomUUID())\""

    const first = yield* prompt.shell({ sessionID: chat.id, messageID, agent: "build", command }).pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(
      permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
      "direct Shell approval was not requested",
    )
    yield* permissions.reply({ requestID: request.id, reply: "once" })
    const firstExit = yield* awaitWithTimeout(Fiber.await(first), "approved direct Shell did not settle", "10 seconds")
    expect(Exit.isSuccess(firstExit)).toBe(true)
    if (Exit.isFailure(firstExit)) return
    const firstTool = completedTool(firstExit.value.parts)
    const firstOutput = firstTool?.state.output
    expect(firstOutput).toMatch(/[0-9a-f-]{36}/)
    expect(yield* legacyPermissions.list()).toHaveLength(0)

    const replay = yield* prompt.shell({ sessionID: chat.id, messageID, agent: "build", command })
    const replayTool = completedTool(replay.parts)
    expect(replayTool?.state.output).toBe(firstOutput)
    expect(yield* permissions.list()).toHaveLength(0)
  }),
)

formalIntegration.instance("cancelling a pending direct Shell leaves zero spawn and a terminal cancelled action", () =>
  Effect.gen(function* () {
    const { prompt, sessions, chat } = yield* boot()
    const locations = yield* LocationServiceMap.Service
    const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
    const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
    const fiber = yield* prompt
      .shell({
        sessionID: chat.id,
        messageID: MessageID.ascending("msg_direct-shell-pending-cancel"),
        agent: "build",
        command: "node -e \"process.stdout.write('must-not-run')\"",
      })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
      "direct Shell approval was not requested before cancel",
    )
    yield* prompt.cancel(chat.id)
    const exit = yield* awaitWithTimeout(Fiber.await(fiber), "pending direct Shell cancel did not settle", "10 seconds")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const tool = errorTool(exit.value.parts)
      expect(tool?.state.metadata?.cancelled).toBe(true)
      expect(tool?.state.metadata?.executionStarted).toBe(false)
    }
    expect(yield* permissions.list()).toHaveLength(0)
    const messages = yield* sessions.messages({ sessionID: chat.id })
    expect(toolPart(messages.findLast((message) => message.info.role === "assistant")?.parts ?? [])?.state.status).toBe(
      "error",
    )
    const { db } = yield* Database.Service
    const events = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
    expect(
      events.some((row) => row.type === "agent.action.state-changed.1" && (row.data as any).to === "cancelled"),
    ).toBe(true)
  }),
)

formalIntegration.instance(
  "direct Shell bounds high-volume live output",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      const fiber = yield* prompt
        .shell({
          sessionID: chat.id,
          messageID: MessageID.ascending("msg_direct-shell-output-bound"),
          agent: "build",
          command: "node -e \"process.stdout.write('x'.repeat(220000)); process.stdout.write('TAIL-MARKER')\"",
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
        "direct Shell high-output approval was not requested",
      )
      yield* permissions.reply({ requestID: request.id, reply: "once" })
      const exit = yield* awaitWithTimeout(Fiber.await(fiber), "high-output direct Shell did not settle", "10 seconds")
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output.length).toBeLessThanOrEqual(200_000)
        expect(tool?.state.metadata.truncated).toBe(true)
        const outputPath = tool?.state.metadata.outputPath
        expect(typeof outputPath).toBe("string")
        if (typeof outputPath !== "string") return
        const fs = yield* FSUtil.Service
        expect(yield* fs.readFileString(outputPath)).toEndWith("TAIL-MARKER")
        expect(tool?.state.output).toContain("TAIL-MARKER")
      }
    }),
  15_000,
)

formalIntegration.instance(
  "direct Shell gives its child a minimal environment without ambient Arforge or provider secrets",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          ARFORGE_SECRET_MASTER_KEY: process.env.ARFORGE_SECRET_MASTER_KEY,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
        }
        process.env.OPENAI_API_KEY = "must-not-reach-direct-shell"
        process.env.ARFORGE_SECRET_MASTER_KEY = "must-not-reach-direct-shell"
        process.env.PATH ??= process.env.Path ?? "C:/Windows/System32"
        process.env.TEMP = "C:/arforge-direct-shell-temp"
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()
          const locations = yield* LocationServiceMap.Service
          const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
          const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
          const fiber = yield* prompt
            .shell({
              sessionID: chat.id,
              messageID: MessageID.ascending("msg_direct-shell-minimal-env"),
              agent: "build",
              command:
                'node -e "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY ?? null,master:process.env.ARFORGE_SECRET_MASTER_KEY ?? null,path:Boolean(process.env.PATH),temp:process.env.TEMP ?? null,term:process.env.TERM ?? null}))"',
            })
            .pipe(Effect.forkChild)
          const request = yield* pollWithTimeout(
            permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
            "direct Shell environment approval was not requested",
          )
          yield* permissions.reply({ requestID: request.id, reply: "once" })
          const exit = yield* awaitWithTimeout(
            Fiber.await(fiber),
            "direct Shell environment test did not settle",
            "10 seconds",
          )
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return
          const output = completedTool(exit.value.parts)?.state.output
          expect(JSON.parse(output ?? "{}")).toEqual({
            openai: null,
            master: null,
            path: true,
            temp: "C:/arforge-direct-shell-temp",
            term: "dumb",
          })
        }),
      (previous) =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }),
    ),
  15_000,
)

formalIntegration.instance("Formal direct Shell rejects with BusyError while a model request is running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    const fiber = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "hi" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
    expect(yield* llm.calls).toBe(1)
    expect(yield* (yield* DurableAction.Service).list({ sessionID: SessionV2.ID.make(chat.id) })).toHaveLength(0)
  }),
)

formalIntegration.instance(
  "Formal shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const result = yield* approvedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command: `node -e "process.stdout.write('stdout-marker');process.stderr.write('stderr-marker')"`,
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("stdout-marker")
      expect(tool.state.output).toContain("stderr-marker")
      expect(tool.state.metadata.output).toContain("stdout-marker")
      expect(tool.state.metadata.output).toContain("stderr-marker")
      expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)
    }),
  15000,
)

formalIntegration.instance(
  "Formal shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, chat } = yield* boot()
      const command = `node -e "process.stdout.write(process.cwd())"`
      const result = yield* approvedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command,
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe(command)
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)
    }),
  15000,
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* approvedDirectShell(prompt, {
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

formalIntegration.instance(
  "Formal shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")
      const command = `node -e "process.stdout.write(require('fs').readdirSync('.').join('\\n'))"`

      const result = yield* approvedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command,
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe(command)
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)
    }),
  15000,
)

formalIntegration.instance(
  "Formal shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const result = yield* approvedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command: `node -e "process.stderr.write('command-failure-marker');process.exit(1)"`,
      })

      expect(result.info.role).toBe("assistant")
      const tool = errorTool(result.parts)
      if (!tool) return yield* Effect.die("Failed command did not retain an error result")

      expect(tool.state.metadata?.output).toContain("command-failure-marker")
      expect(tool.state.metadata?.exitCode).toBe(1)
      expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)
    }),
  15000,
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* startApprovedDirectShell(prompt, {
          sessionID: chat.id,
          agent: "build",
          command: "printf first && sleep 0.2 && printf second",
        })

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

for (const outcome of ["reject", "cancel-before", "cancel-after"] as const)
  formalIntegration.instance(
    `Formal prompt receives a direct Shell denial or cancellation outcome=${outcome}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const core = yield* SessionV2.Service
        const chat = yield* sessions.create({ title: "Shell was not authorized" })
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
        const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
        const command =
          outcome === "cancel-after"
            ? `node -e "process.stdout.write('shell-partial-before-cancel');setInterval(()=>{},1000)"`
            : "echo not-authorized-output"
        const fiber = yield* prompt
          .shell({ sessionID: chat.id, messageID: MessageID.ascending(), agent: "build", command })
          .pipe(Effect.forkChild)
        const request = yield* pollWithTimeout(
          permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
          "Shell approval missing",
        )
        if (outcome === "cancel-after") {
          yield* permissions.reply({ requestID: request.id, reply: "once" })
          yield* pollWithTimeout(
            sessions
              .messages({ sessionID: chat.id })
              .pipe(
                Effect.map((items) =>
                  items.some((item) =>
                    item.parts.some(
                      (part) =>
                        part.type === "tool" &&
                        part.state.status === "running" &&
                        String(part.state.metadata?.output).includes("shell-partial-before-cancel"),
                    ),
                  )
                    ? true
                    : undefined,
                ),
              ),
            "Shell did not publish partial output",
            "10 seconds",
          )
        }
        if (outcome !== "reject") yield* prompt.cancel(chat.id)
        else yield* permissions.reply({ requestID: request.id, reply: "reject" })
        yield* awaitWithTimeout(Fiber.await(fiber), "Shell rejection/cancellation did not settle", "10 seconds")
        const history = yield* core.context(SessionV2.ID.make(chat.id))
        const shells = history.filter((item): item is SessionMessage.Shell => item.type === "shell")
        expect(shells).toHaveLength(1)
        expect(shells[0].time.completed).toBeDefined()
        expect(shells[0].output).toContain(
          outcome === "cancel-before"
            ? "cancelled before it started"
            : outcome === "cancel-after"
              ? "interrupted after execution started"
              : "failed or was denied",
        )
        if (outcome === "cancel-after") expect(shells[0].output).toContain("shell-partial-before-cancel")
        expect(shells[0].output).not.toContain("not-authorized-output")
        expect(yield* llm.calls).toBe(0)
        yield* llm.text("The command did not complete successfully")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Explain the preceding command outcome without rerunning it" }],
        })
        expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain(
          JSON.stringify(shells[0].output).slice(1, -1),
        )
        expect(yield* llm.calls).toBe(1)
      }),
    20_000,
  )

for (const configuredShell of process.platform === "win32" ? ["powershell.exe", "cmd.exe"] : ["/bin/sh"]) {
  formalIntegration.instance(
    `Formal shell changes directory after startup shell=${configuredShell}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), shell: configuredShell }))
        const { directory } = yield* TestInstance
        const prompt = yield* SessionPrompt.Service
        const chat = yield* (yield* Session.Service).create({ title: "Shell directory change" })
        const separator = configuredShell === "powershell.exe" ? ";" : "&&"
        const result = yield* approvedDirectShell(prompt, {
          sessionID: chat.id,
          agent: "build",
          command: `cd .. ${separator} node -e "process.stdout.write(process.cwd())"`,
        })
        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output.trim()).toBe(path.dirname(directory))
        expect(tool.state.metadata.output.trim()).toBe(path.dirname(directory))
        expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)
        expect(yield* llm.calls).toBe(0)
      }),
    15000,
  )

  formalIntegration.instance(
    `Formal direct Shell records a nonzero exit as failure with its output shell=${configuredShell}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: configuredShell,
        }))
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const core = yield* SessionV2.Service
        const chat = yield* sessions.create({ title: "Nonzero Shell" })
        const result = yield* approvedDirectShell(prompt, {
          sessionID: chat.id,
          agent: "build",
          command:
            configuredShell === "cmd.exe"
              ? `node -e "process.stdout.write('nonzero-output');process.exit(17)"`
              : `node -e "process.stdout.write('nonzero-output')"; exit 17`,
        })
        const tool = result.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(tool?.state.status).toBe("error")
        expect(tool?.state.status === "error" && tool.state.metadata?.exitCode).toBe(17)
        expect(tool?.state.status === "error" && tool.state.metadata?.output).toContain("nonzero-output")
        const actions = yield* (yield* DurableAction.Service).list({ sessionID: SessionV2.ID.make(chat.id) })
        expect(actions).toHaveLength(1)
        expect(actions[0].action.status).toBe("blocked")
        expect(actions[0].observation?.status).toBe("failed")
        const shell = (yield* core.context(SessionV2.ID.make(chat.id))).find(
          (item): item is SessionMessage.Shell => item.type === "shell",
        )
        expect(shell?.output).toContain("code 17")
        expect(shell?.output).toContain("nonzero-output")
        yield* llm.text("The command failed with exit code 17")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Report the preceding result" }],
        })
        expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain("code 17")
        expect(yield* llm.calls).toBe(1)
      }),
    20_000,
  )
}

formalIntegration.instance(
  "Formal prompt after direct Shell receives the completed command output",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const marker = "direct-shell-context-marker"
      const shellInput = {
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        agent: "build",
        command: `node -e "process.stdout.write('${marker}')"`,
      }
      yield* approvedDirectShell(prompt, shellInput)
      const core = yield* SessionV2.Service
      const shellHistory = yield* core.context(SessionV2.ID.make(chat.id))
      expect(shellHistory.filter((item) => item.type === "shell")).toHaveLength(1)
      yield* prompt.shell(shellInput)
      expect(yield* core.context(SessionV2.ID.make(chat.id))).toEqual(shellHistory)
      expect(yield* llm.calls).toBe(0)
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Describe the preceding Shell output" }],
      })
      expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain(marker)
      const context = yield* (yield* SessionV2.Service).context(SessionV2.ID.make(chat.id))
      const answer = context.findLast((item): item is SessionMessage.Assistant => item.type === "assistant")
      expect(answer?.content).toContainEqual(expect.objectContaining({ type: "text", text: "after-shell" }))
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  20_000,
)

for (const phase of ["approval", "running"] as const) {
  formalIntegration.instance(
    `Formal direct Shell owns the execution slot and releases queued requests after its output phase=${phase}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const owner = yield* SessionExecution.Service
        const chat = yield* sessions.create({ title: "Shell and queued prompt" })
        const id = SessionV2.ID.make(chat.id)
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
        const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
        const shell = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            command:
              phase === "approval"
                ? `node -e "process.stdout.write('queued-shell-result')"`
                : `node -e "process.stdout.write('shell-started');const t=setInterval(()=>{if(require('fs').existsSync('.shell-release')){clearInterval(t);process.stdout.write('queued-shell-result')}},20)"`,
          })
          .pipe(Effect.forkChild)
        const request = yield* pollWithTimeout(
          permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
          "Shell approval missing",
        )
        if (phase === "running") {
          yield* permissions.reply({ requestID: request.id, reply: "once" })
          yield* pollWithTimeout(
            sessions
              .messages({ sessionID: chat.id })
              .pipe(
                Effect.map((items) =>
                  items.some((item) =>
                    item.parts.some(
                      (part) =>
                        part.type === "tool" &&
                        part.state.status === "running" &&
                        String(part.state.metadata?.output).includes("shell-started"),
                    ),
                  )
                    ? true
                    : undefined,
                ),
              ),
            "Shell did not start",
          )
        }
        expect((yield* owner.active).has(id)).toBe(true)
        const second = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "echo must-not-start" })
          .pipe(Effect.exit)
        expect(Exit.isFailure(second) && Cause.pretty(second.cause)).toContain("BusyError")
        yield* llm.text("after queued shell")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "Read the Shell result" }],
        })
        yield* owner.wake(id)
        const firstWaiter = yield* owner.wakeAndWait(id).pipe(Effect.forkChild({ startImmediately: true }))
        const secondWaiter = yield* owner.wakeAndWait(id).pipe(Effect.forkChild({ startImmediately: true }))
        expect(yield* llm.calls).toBe(0)
        if (phase === "approval") yield* permissions.reply({ requestID: request.id, reply: "once" })
        else yield* writeText(path.join(chat.directory, ".shell-release"), "release")
        expect(Exit.isSuccess(yield* Fiber.await(shell))).toBe(true)
        yield* Effect.all([Fiber.join(firstWaiter), Fiber.join(secondWaiter)])
        expect(JSON.stringify((yield* llm.inputs)[0]?.messages)).toContain("queued-shell-result")
        expect(yield* llm.calls).toBe(1)
        expect((yield* owner.active).has(id)).toBe(false)
        const history = yield* (yield* SessionV2.Service).context(id)
        expect(history.filter((item) => item.type === "shell")).toHaveLength(1)
        expect(history.filter((item) => item.type === "assistant")).toHaveLength(1)
      }),
    20_000,
  )
}

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

formalIntegration.instance(
  "Formal shell cancellation resolves cleanly and releases the Core owner",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const { directory: dir } = yield* TestInstance
      const afs = yield* FSUtil.Service
      const ready = path.join(dir, ".shell-ready")

      const sh = yield* startApprovedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command: `node -e "require('fs').writeFileSync('.shell-ready','ready');setInterval(()=>{},1000)"`,
      })
      yield* pollWithTimeout(
        afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
        "shell never created readiness marker",
      )

      yield* prompt.cancel(chat.id)

      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* (yield* SessionExecution.Service).active).has(SessionV2.ID.make(chat.id))).toBe(false)

      const exit = yield* Fiber.await(sh)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        const tool = errorTool(exit.value.parts)
        if (tool) {
          expect(tool.state.error).toContain("interrupted after execution started")
        }
      }
    }),
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

testEffect(makeFormalIntegrationHttp({ realSummary: true }), httpInstance).instance(
  "Formal instant tool execution retains pre-tool snapshot and changed files",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const core = yield* SessionV2.Service
      const chat = yield* sessions.create({ title: "Formal snapshot race" })
      expect(Object.hasOwn(prompt, "loop")).toBe(false)
      const id = SessionV2.ID.make(chat.id)
      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      yield* llm.tool("bash", {
        command: `node -e "require('fs').writeFileSync('race-test.txt','snapshot-content')"`,
        workdir: chat.directory,
      })
      yield* llm.text("File created")
      const run = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Create the file immediately" }],
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
        "Snapshot command approval missing",
        "10 seconds",
      )
      yield* permissions.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(run)
      expect(yield* (yield* FSUtil.Service).existsSafe(path.join(chat.directory, "race-test.txt"))).toBe(true)
      const history = yield* core.context(id)
      const assistant = history.find(
        (item) =>
          item.type === "assistant" && item.content.some((part) => part.type === "tool" && part.name === "bash"),
      )
      expect(assistant?.type).toBe("assistant")
      if (!assistant || assistant.type !== "assistant") return yield* Effect.die("Tool assistant missing")
      expect(assistant.snapshot?.start).toBeDefined()
      expect(assistant.snapshot?.end).toBeDefined()
      expect(assistant.snapshot?.start).not.toBe(assistant.snapshot?.end)
      expect(assistant.snapshot?.files?.map(String)).toContain("race-test.txt")
      expect(yield* llm.calls).toBe(2)
      const user = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.role === "user")
      if (!user) return yield* Effect.die("Snapshot user message missing")
      const summary = yield* SessionSummary.Service
      const diff = yield* pollWithTimeout(
        summary
          .diff({ sessionID: chat.id, messageID: user.info.id })
          .pipe(Effect.map((items) => (items.some((item) => item.file === "race-test.txt") ? items : undefined))),
        "Formal user-facing file diff missing",
        "5 seconds",
      )
      expect(diff.some((item) => item.file === "race-test.txt")).toBe(true)
      expect(diff.find((item) => item.file === "race-test.txt")?.patch).toContain("snapshot-content")
      yield* llm.tool("bash", {
        command: `node -e "require('fs').writeFileSync('second-turn.txt','second-content')"`,
        workdir: chat.directory,
      })
      yield* llm.text("Second file created")
      const secondRun = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Create a different file" }],
        })
        .pipe(Effect.forkChild)
      const secondApproval = yield* pollWithTimeout(
        permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
        "Second snapshot command approval missing",
      )
      yield* permissions.reply({ requestID: secondApproval.id, reply: "once" })
      yield* Fiber.join(secondRun)
      expect(yield* summary.diff({ sessionID: chat.id, messageID: user.info.id })).toEqual(diff)
      const allDiffs = yield* summary.diff({ sessionID: chat.id })
      expect(allDiffs.map((item) => item.file)).toContain("race-test.txt")
      expect(allDiffs.map((item) => item.file)).toContain("second-turn.txt")
      expect(yield* llm.calls).toBe(4)
    }),
  { git: true },
  30000,
)

for (const outputBytes of [400000, 1200000]) {
  formalIntegration.instance(
    `Formal interrupted bash retains captured output through the unified output pipeline bytes=${outputBytes}`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const core = yield* SessionV2.Service
        const chat = yield* sessions.create({ title: "Interrupted model tool output" })
        const id = SessionV2.ID.make(chat.id)
        const locations = yield* LocationServiceMap.Service
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
        const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
        yield* llm.tool("bash", {
          command: `node -e "process.stdout.write('retained-output-start'+ 'x'.repeat(${outputBytes}),()=>require('fs').writeFileSync('.bash-output-ready','ready'));setInterval(()=>{},1000)"`,
          workdir: chat.directory,
          timeout: 30000,
        })
        const run = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "Run the command" }] })
          .pipe(Effect.forkChild)
        const request = yield* pollWithTimeout(
          permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === chat.id))),
          "Bash approval missing",
        )
        yield* permissions.reply({ requestID: request.id, reply: "once" })
        const fs = yield* FSUtil.Service
        yield* pollWithTimeout(
          fs
            .existsSafe(path.join(chat.directory, ".bash-output-ready"))
            .pipe(Effect.map((ready) => (ready ? true : undefined))),
          "Bash output did not become ready",
          "10 seconds",
        )
        yield* prompt.cancel(chat.id)
        yield* awaitWithTimeout(Fiber.await(run), "Bash cancellation did not settle", "10 seconds")
        const history = yield* core.context(id)
        const tool = history
          .flatMap((item) => (item.type === "assistant" ? item.content : []))
          .find((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.name === "bash")
        expect(tool?.state.status).toBe("error")
        expect(yield* llm.calls).toBe(1)
        if (!tool || tool.state.status !== "error") return yield* Effect.die("Interrupted tool result missing")
        expect(JSON.stringify(tool.state.content)).toContain("retained-output-start")
        expect(JSON.stringify(tool.state.content).length).toBeLessThan(60000)
        expect(tool.state.artifactRefs).toHaveLength(1)
        expect(tool.state.outputPaths).toBeUndefined()
        const artifact = tool.state.artifactRefs?.[0]
        if (!artifact) return yield* Effect.die("Interrupted output receipt missing")
        const storage = yield* ToolOutputStore.Service.pipe(Effect.provide(location))
        const retained = yield* storage.read({ reference: artifact, owner: { scope: "session", id } })
        expect(new TextDecoder().decode(retained.bytes)).toContain("retained-output-start")
        expect(retained.bytes.length).toBeGreaterThan(50000)
        expect(retained.bytes.length).toBeLessThan(1100000)
        expect(tool.state.structured.truncated).toBe(outputBytes > 1048576)
        yield* llm.text("The command was interrupted with retained output")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "Explain the partial result" }],
        })
        expect(JSON.stringify((yield* llm.inputs)[1]?.messages)).toContain("retained-output-start")
        expect(yield* llm.calls).toBe(2)
      }),
    20000,
  )
}

formalIntegration.instance(
  "Formal cancellation settles requests queued behind a running direct Shell",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, sessions, chat } = yield* boot()
      const owner = yield* SessionExecution.Service
      const id = SessionV2.ID.make(chat.id)
      const sh = yield* startApprovedDirectShell(prompt, {
        sessionID: chat.id,
        agent: "build",
        command: `node -e "process.stdout.write('queued-cancel-ready');setInterval(()=>{},1000)"`,
      })
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((items) =>
              items.some((item) =>
                item.parts.some(
                  (part) =>
                    part.type === "tool" &&
                    part.state.status === "running" &&
                    String(part.state.metadata?.output).includes("queued-cancel-ready"),
                ),
              )
                ? true
                : undefined,
            ),
          ),
        "Shell did not start",
      )
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "Wait for the command result" }],
      })
      const first = yield* owner.wakeAndWait(id).pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* owner.wakeAndWait(id).pipe(Effect.forkChild({ startImmediately: true }))

      yield* prompt.cancel(chat.id)

      const exits = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(sh))).toBe(true)
      expect((yield* owner.active).has(id)).toBe(false)
      expect(yield* llm.calls).toBe(0)
      const history = yield* (yield* SessionV2.Service).context(id)
      const shells = history.filter((item): item is SessionMessage.Shell => item.type === "shell")
      expect(shells).toHaveLength(1)
      expect(shells[0].output).toContain("interrupted after execution started")
      expect(shells[0].output).toContain("queued-cancel-ready")
      expect(history.filter((item) => item.type === "assistant")).toHaveLength(0)
    }),
  20_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* startApprovedDirectShell(prompt, { sessionID: chat.id, agent: "build", command: "sleep 30" })
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

noLLMServer.instance(
  "reads an external user attachment through one exact automatic carrier without another approval",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const fs = yield* FSUtil.Service
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const legacyPermissions = yield* Permission.Service
      const chat = yield* sessions.create({ title: "External user attachment" })
      const external = path.join(path.dirname(dir), `${chat.id}-external-attachment.txt`)
      yield* writeText(external, "external attachment content\n")
      yield* Effect.addFinalizer(() => fs.remove(external, { force: true }).pipe(Effect.ignore))

      const locations = yield* LocationServiceMap.Service
      const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(chat.directory) }))
      const permissions = yield* PermissionV2.Service.pipe(Effect.provide(location))
      const msg = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "Please inspect the attached file." },
          {
            type: "file",
            url: pathToFileURL(external).href,
            filename: path.basename(external),
            mime: "text/plain",
          },
        ],
      })

      expect(msg.parts.some((part) => part.type === "text" && part.text.includes("external attachment content"))).toBe(
        true,
      )
      expect(yield* permissions.list()).toEqual([])
      expect(yield* legacyPermissions.list()).toEqual([])

      const { db } = yield* Database.Service
      const proposed = (yield* db.select().from(EventTable).all().pipe(Effect.orDie))
        .filter((row) => row.type === "agent.action.proposed.1")
        .map((row) => Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(row.data))
        .find((event) => event.action.name === "read_user_attachment")
      expect(proposed?.action).toMatchObject({ name: "read_user_attachment", riskTier: "L0" })
      expect(proposed?.action.resources).toHaveLength(1)
      expect(proposed?.action.resources[0]?.replaceAll("\\", "/")).toEndWith(`/${path.basename(external)}`)
      expect(proposed?.action.subject).toMatchObject({
        sessionID: chat.id,
        assistantMessageID: msg.info.id,
        toolCallID: expect.stringContaining("user-attachment:"),
      })
    }),
  { config: cfg },
)

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, aborted, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: pathToFileURL(testFile).href, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      yield* awaitWithTimeout(Deferred.await(aborted), "read tool finalizer did not run", "10 seconds")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, aborted, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: pathToFileURL(dir).href, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      yield* awaitWithTimeout(Deferred.await(aborted), "directory read finalizer did not run", "10 seconds")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
  10_000,
)

// Regression: empty assistant turn loop

formalIntegration.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/arforge/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const core = yield* SessionV2.Service
    const msgs = yield* core.messages({ sessionID: SessionV2.ID.make(session.id), order: "asc" })
    expect(msgs.filter((msg) => msg.type === "assistant")).toHaveLength(1)
    expect(
      (yield* sessions.messages({ sessionID: session.id })).filter((msg) => msg.info.role === "assistant"),
    ).toHaveLength(0)
    expect(yield* llm.calls).toBe(1)
  }),
)

formalIntegration.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.push(reply().text("partial cancelled answer").hang())

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* awaitWithTimeout(llm.wait(1), "cancelled provider did not start", "10 seconds")
    yield* waitForBusy(session.id)
    const core = yield* SessionV2.Service
    yield* pollWithTimeout(
      core
        .messages({ sessionID: SessionV2.ID.make(session.id), order: "asc" })
        .pipe(Effect.map((messages) => (messages.some((message) => message.type === "assistant") ? true : undefined))),
      "cancelled assistant did not start",
      "10 seconds",
    )
    yield* prompt.cancel(session.id)

    const exit = yield* awaitWithTimeout(Fiber.await(fiber), "cancelled prompt did not finish", "10 seconds")
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    const msgs = yield* core.messages({ sessionID: SessionV2.ID.make(session.id), order: "asc" })
    const last = msgs.findLast((msg): msg is SessionMessage.Assistant => msg.type === "assistant")
    expect(last?.error).toEqual({ type: "unknown", message: "Provider turn interrupted" })
    expect(last?.time.completed).toBeDefined()
    expect(last?.content.some((part) => part.type === "text" && part.text === "partial cancelled answer")).toBe(true)
    expect(
      (yield* sessions.messages({ sessionID: session.id })).filter((msg) => msg.info.role === "assistant"),
    ).toHaveLength(0)
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("arforge"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

formalIntegration.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
