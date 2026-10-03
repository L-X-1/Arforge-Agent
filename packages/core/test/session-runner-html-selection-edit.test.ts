import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest, type PreparedRequest } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Config } from "@arforge-ai/core/config"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EvolutionV2 } from "@arforge-ai/core/evolution"
import { GoalV2 } from "@arforge-ai/core/goal"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { MemoryV2 } from "@arforge-ai/core/memory"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { QuestionV2 } from "@arforge-ai/core/question"
import { ReferenceGuidance } from "@arforge-ai/core/reference/guidance"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { SessionRunCoordinator } from "@arforge-ai/core/session/run-coordinator"
import { SessionRunner } from "@arforge-ai/core/session/runner"
import * as SessionRunnerLLM from "@arforge-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { SkillGuidance } from "@arforge-ai/core/skill/guidance"
import { Snapshot } from "@arforge-ai/core/snapshot"
import { SystemContext } from "@arforge-ai/core/system-context"
import { SystemContextRegistry } from "@arforge-ai/core/system-context/registry"
import { ApplicationTools } from "@arforge-ai/core/tool/application-tools"
import { EditTool } from "@arforge-ai/core/tool/edit"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Stream } from "effect"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import path from "node:path"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNodePlatform.filesystem))
type Scenario = "approved" | "declined" | "stale"

// Only the provider is simulated. Each case replies to the real PermissionV2
// queue and uses the real SessionRunner, Gateway, edit tool and filesystem.
// The scoped temporary directory never contains the user's working files.
const runScenario = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = AbsolutePath.make(yield* fs.makeTempDirectoryScoped({ prefix: "arforge-html-runner-" }))
    const filePath = path.join(directory, "page.html")
    const oldString = '<h1 id="title">Before</h1>'
    const newString = '<h1 id="title" style="font-size:32px">After</h1>'
    const source = `<!doctype html>\r\n<body>\r\n${oldString}\r\n<p>Keep me</p>\r\n</body>`
    const original = `\uFEFF${source}`
    const externallyChanged = `${original}\r\n<p>External change</p>`
    yield* fs.writeFileString(filePath, original)
    const htmlSelection = {
      path: "page.html",
      directory,
      revision: createHash("sha256").update(source).digest("hex"),
      mode: "file-preview" as const,
      start: source.indexOf(oldString),
      end: source.indexOf(oldString) + oldString.length,
    }
    const input = { path: "page.html", oldString, newString, htmlSelection }
    const sessionID = SessionV2.ID.make(`ses_html_guard_${scenario}`)
    const callID = `call-html-guard-${scenario}`
    const requests: LLMRequest[] = []
    const preparedRequests = new WeakMap<PreparedRequest, LLMRequest>()
    const responses: LLMEvent[][] = [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: callID, name: "edit", input }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "html-edit-result" }),
        LLMEvent.textDelta({
          id: "html-edit-result",
          text: scenario === "stale" ? "Select the changed source again." : "The selected HTML was saved.",
        }),
        LLMEvent.textEnd({ id: "html-edit-result" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ],
    ]
    const client = Layer.succeed(
      LLMClient.Service,
      LLMClient.Service.of({
        prepare: <Body = unknown>(request: LLMRequest) =>
          LLMClient.prepare<Body>(request).pipe(
            Effect.tap((prepared) => Effect.sync(() => preparedRequests.set(prepared, request))),
          ),
        streamPrepared: (prepared) =>
          Stream.suspend(() => {
            const request = preparedRequests.get(prepared)
            if (!request) return Stream.die("Unknown or consumed HTML edit fixture request")
            preparedRequests.delete(prepared)
            requests.push(request)
            const response = responses.shift()
            return response ? Stream.fromIterable(response) : Stream.die("Unexpected provider continuation")
          }),
        stream: (() => Stream.die("Expected the prepared provider request")) as LLMClientShape["stream"],
        generate: () => Effect.die("unused"),
      }),
    )
    const pending = yield* Deferred.make<PermissionV2.Request>()
    const model = Model.make({ id: "html-edit-fixture", provider: "fake", route: OpenAIChat.route })
    const models = SessionRunnerModel.layerWith(
      () => Effect.succeed(model),
      () => Effect.succeed(undefined),
    )
    const boundLocation = Location.boundNode({ directory })
    const systemContext = Layer.effectDiscard(
      SystemContextRegistry.Service.pipe(
        Effect.flatMap((registry) =>
          registry.register({
            key: SystemContext.Key.make("test/html-selection-edit"),
            load: Effect.succeed(SystemContext.empty),
          }),
        ),
      ),
    ).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
    const skillGuidance = Layer.mock(SkillGuidance.Service, {
      route: () => Effect.succeed(undefined),
      load: () => Effect.succeed(SystemContext.empty),
    })
    const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
    const evolution = Layer.mock(EvolutionV2.Service, {
      prepare: () => Effect.succeed(EvolutionV2.emptyContext),
      recordOutcome: () => Effect.succeed(0),
      syncLearningPatterns: () =>
        Effect.succeed({ schema_version: 1 as const, seen: 0, created: 0, existing: 0, skipped: 0, failed: 0, items: [] }),
    })
    const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
    const secretLayer = Layer.succeed(
      SecretProvider.Service,
      SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(7), "test-html-selection-edit-aes-256-gcm"),
    )
    const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
      [Snapshot.node, Snapshot.noopLayer],
      [LayerNodePlatform.llmClient, client],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, boundLocation],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [EvolutionV2.node, evolution],
      [SecretProvider.node, secretLayer],
      [Config.node, config],
    ])
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const runner = yield* SessionRunner.Service
        const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError, SessionExecution.RunOptions>({
          drain: (id, force) => runner.run({ sessionID: id, force }),
        })
        return SessionExecution.Service.of({
          active: coordinator.active,
          exclusive: coordinator.exclusive,
          resume: coordinator.run,
          resumeWith: ({ sessionID, options }) => coordinator.runWith(sessionID, options),
          wake: coordinator.wake,
          wakeAndWait: coordinator.wakeAndWait,
          interrupt: coordinator.interrupt,
        })
      }),
    ).pipe(Layer.provide(runnerLayer))
    const layer = AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventV2.node,
        PermissionV2.node,
        QuestionV2.node,
        SessionProjector.node,
        SessionStore.node,
        ApplicationTools.node,
        AgentV2.node,
        LayerNodePlatform.filesystem,
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        ToolRegistry.builtInsNode,
        EditTool.node,
        SessionRunnerModel.node,
        SystemContextRegistry.node,
        SkillGuidance.node,
        ReferenceGuidance.node,
        Config.node,
        GoalV2.node,
        DurableAction.node,
        DurableRun.node,
        SubagentChildExecutor.node,
        SubagentProvider.node,
        Authorizer.node,
        ActionGateway.node,
        Snapshot.node,
        MemoryV2.node,
        LearningV2.node,
        EvolutionV2.node,
        SessionRunnerLLM.node,
        SessionExecution.node,
        SessionV2.node,
      ]),
      [
        [LayerNodePlatform.llmClient, client],
        [SecretProvider.node, secretLayer],
        [SessionRunnerModel.node, models],
        [SystemContextRegistry.node, systemContext],
        [Location.node, boundLocation],
        [SkillGuidance.node, skillGuidance],
        [ReferenceGuidance.node, referenceGuidance],
        [EvolutionV2.node, evolution],
        [Snapshot.node, Snapshot.noopLayer],
        [
          SubagentChildExecutor.node,
          {
            ...SubagentChildExecutor.node,
            dependencies: [...SubagentChildExecutor.node.dependencies, SubagentProvider.node],
          },
        ],
        [SessionExecution.node, execution],
        [Config.node, config],
      ],
    )

    yield* Effect.gen(function* () {
      // The bare AgentV2 node starts empty. A real permission check must have
      // an explicit agent; missing agents correctly fail closed before asking.
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.update(AgentV2.defaultID, (agent) => {
          agent.permissions = [{ action: "edit", resource: "*", effect: "ask" }]
        })
        editor.default(AgentV2.defaultID)
      })
      expect(yield* agents.resolve(AgentV2.defaultID)).toMatchObject({
        id: AgentV2.defaultID,
        permissions: [{ action: "edit", resource: "*", effect: "ask" }],
      })
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory, title: "HTML edit", version: "test" })
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const permissions = yield* PermissionV2.Service
      const approvals: PermissionV2.Request[] = []
      const updates: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type === "file.watcher.updated") updates.push(event)
          if (event.type !== PermissionV2.Event.Asked.type) return
          const approval = (yield* permissions.forSession(sessionID)).find(
            (request) => request.action === "edit" && request.source?.type === "tool" && request.source.callID === callID,
          )
          if (!approval) return
          approvals.push(approval)
          yield* Deferred.succeed(pending, approval)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Update only the selected heading in page.html, after approval." }),
        resume: false,
      })
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      const approval = yield* Deferred.await(pending).pipe(
        Effect.raceFirst(
          Fiber.join(run).pipe(
            Effect.flatMap((result) =>
              Effect.die(
                new Error(
                  Exit.isFailure(result)
                    ? `Runner ended before HTML approval: ${Cause.prettyErrors(result.cause).map((error) => error.message).join("; ")}`
                    : "Runner completed without requesting HTML edit approval",
                ),
              ),
            ),
          ),
        ),
        Effect.timeout("10 seconds"),
      )

      expect(approval).toMatchObject({
        sessionID,
        action: "edit",
        requiresHumanConfirmation: true,
        metadata: { riskTier: "L3", authority: "human" },
        source: { type: "tool", callID },
      })
      // Compare raw bytes so text decoding cannot hide or remove the UTF-8 BOM.
      expect(Buffer.from(yield* fs.readFile(filePath))).toEqual(Buffer.from(original, "utf8"))
      expect(requests).toHaveLength(1)
      expect(updates).toHaveLength(0)
      if (scenario === "stale") yield* fs.writeFileString(filePath, externallyChanged)

      yield* permissions.reply({ requestID: approval.id, reply: scenario === "declined" ? "reject" : "once" })
      const result = yield* Fiber.join(run)
      expect(approvals).toHaveLength(1)
      expect(yield* permissions.forSession(sessionID)).toEqual([])
      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .filter((part) => part.type === "tool")
        .find((part) => part.id === callID)
      if (!tool) throw new Error("The runner did not persist its HTML edit tool call")
      expect(tool.state.input).toEqual(input)

      if (scenario === "declined") {
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
        expect(tool.state.status).toBe("error")
        expect(requests).toHaveLength(1)
        expect(updates).toHaveLength(0)
        expect(Buffer.from(yield* fs.readFile(filePath))).toEqual(Buffer.from(original, "utf8"))
        return
      }

      expect(Exit.isSuccess(result)).toBe(true)
      expect(requests).toHaveLength(2)
      const receipt = JSON.stringify(requests[1]!.messages)
      if (scenario === "stale") {
        expect(tool.state.status).toBe("error")
        if (tool.state.status !== "error") throw new Error("A stale HTML selection was not rejected")
        expect(tool.state.error.message.length).toBeGreaterThan(0)
        expect(receipt).toContain(tool.state.error.message)
        expect(updates).toHaveLength(0)
        expect(Buffer.from(yield* fs.readFile(filePath))).toEqual(Buffer.from(externallyChanged, "utf8"))
        return
      }

      expect(tool.state.status).toBe("completed")
      expect(receipt).toContain("Edited file successfully: page.html")
      expect(updates).toHaveLength(1)
      expect(Buffer.from(yield* fs.readFile(filePath))).toEqual(Buffer.from(`\uFEFF${source.replace(oldString, newString)}`, "utf8"))
    }).pipe(Effect.provide(layer))
  })

describe("SessionRunner guarded HTML editing", () => {
  it.live("waits for approval, saves the selected source and returns the result to the model", () => runScenario("approved"), 30_000)
  it.live("does not write or continue the model when approval is declined", () => runScenario("declined"), 30_000)
  it.live("preserves a file changed during approval and returns the stale snapshot error", () => runScenario("stale"), 30_000)
})
