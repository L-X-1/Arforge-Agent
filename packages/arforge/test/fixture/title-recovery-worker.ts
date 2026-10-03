// A fresh process over an isolated database copy: no original background registry.
const [databasePath, workspace, projectID, sessionID, expectedTitle] = Bun.argv.slice(2)
if (!databasePath || !workspace || !projectID || !sessionID || !expectedTitle)
  throw new Error("Missing title recovery fixture arguments")
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = workspace

const { Effect, Layer, Stream } = await import("effect")
const { LLMClient } = await import("@arforge-ai/llm")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { llmClient } = await import("@arforge-ai/core/effect/app-node-platform")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { Location } = await import("@arforge-ai/core/location")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { ProjectID } = await import("@arforge-ai/schema/project-id")
const { AgentV2 } = await import("@arforge-ai/core/agent")
const runner = await import("@arforge-ai/core/session/runner/llm")
const { SessionRunner } = await import("@arforge-ai/core/session/runner")
const { SessionRunnerModel } = await import("@arforge-ai/core/session/runner/model")
const { SessionProjector } = await import("@arforge-ai/core/session/projector")
const { SessionStore } = await import("@arforge-ai/core/session/store")
const { SessionSchema } = await import("@arforge-ai/core/session/schema")
const { DurableAction } = await import("@arforge-ai/core/runtime/durable-action")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
let providerCalls = 0
let modelResolutions = 0
const directory = AbsolutePath.make(workspace)
const layer = AppNodeBuilder.build(
  LayerNode.group([
    runner.node,
    SessionProjector.node,
    AgentV2.node,
    DurableAction.node,
    DurableRun.node,
    SessionStore.node,
  ]),
  [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory,
          project: { id: ProjectID.make(projectID), directory },
        }),
      ),
    ],
    [
      llmClient,
      Layer.mock(LLMClient.Service, {
        stream: () => {
          providerCalls++
          return Stream.die("Recovery must not send a provider request")
        },
      }),
    ],
    [
      SessionRunnerModel.node,
      Layer.mock(SessionRunnerModel.Service, {
        resolve: () => {
          modelResolutions++
          return Effect.die("Recovery must not resolve a model")
        },
      }),
    ],
  ],
)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    // Rehydrate the enabled fixture agent, not a provider or cached title result.
    yield* agents.transform((editor) => editor.update(AgentV2.ID.make("title"), () => {}))
    const id = SessionSchema.ID.make(sessionID)
    const actions = yield* DurableAction.Service
    const runs = yield* DurableRun.Service
    const store = yield* SessionStore.Service
    const before = JSON.stringify({
      actions: yield* actions.list({ sessionID: id }),
      runs: yield* runs.list({ sessionID: id }),
    })
    const execution = yield* SessionRunner.Service
    yield* execution.run({ sessionID: id, force: false })
    yield* execution.run({ sessionID: id, force: false })
    const title = (yield* store.get(id))?.title
    const after = JSON.stringify({
      actions: yield* actions.list({ sessionID: id }),
      runs: yield* runs.list({ sessionID: id }),
    })
    if (title !== expectedTitle || before !== after || providerCalls !== 0 || modelResolutions !== 0)
      throw new Error("Fresh-process title recovery violated its contract")
    return { title, providerCalls, modelResolutions, historyUnchanged: before === after }
  }).pipe(Effect.provide(layer), Effect.scoped),
)
console.log(JSON.stringify(result))
