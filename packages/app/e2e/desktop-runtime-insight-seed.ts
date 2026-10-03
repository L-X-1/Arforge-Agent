import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentV2 } from "@arforge-ai/core/agent"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Egress } from "@arforge-ai/core/egress"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap, buildLocationServiceMap } from "@arforge-ai/core/location-services"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Project } from "@arforge-ai/core/project"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"
import { Effect, Layer, Logger } from "effect"
import { ToolRegistry as CoreToolRegistry } from "@arforge-ai/core/tool/registry"
import { fileURLToPath, pathToFileURL } from "node:url"

// The seed is launched as an independent Bun process from the desktop acceptance
// runner.  Keep the mature Arforge imports runtime-only so the app e2e TypeScript
// project does not accidentally type-check the entire Arforge source tree under
// the app's `@/*` path aliases.  The Arforge package has its own typecheck and
// remains the canonical owner of these modules.
const matureSource = (relative: string) =>
  pathToFileURL(fileURLToPath(new URL(`../../arforge/src/${relative}`, import.meta.url))).href
const [
  { EventV2Bridge },
  { Format },
  { Agent },
  { InstanceRef },
  { LSP },
  { Truncate },
  { Tool: MatureTool },
  { WriteTool },
  { makeLegacySessionTools },
] = await Promise.all([
  import(matureSource("event-v2-bridge.ts")),
  import(matureSource("format/index.ts")),
  import(matureSource("agent/agent.ts")),
  import(matureSource("effect/instance-ref.ts")),
  import(matureSource("lsp/lsp.ts")),
  import(matureSource("tool/truncate.ts")),
  import(matureSource("tool/tool.ts")),
  import(matureSource("tool/write.ts")),
  import(matureSource("tool/core-bridge.ts")),
])

type SeedAgentInfo = { name: string; permission: readonly unknown[] }
type SeedPlugin = { trigger: (name: string, input: unknown, output: unknown) => unknown }

const [databasePath, workspace, target = "runtime-review.txt"] = Bun.argv.slice(2)
if (!databasePath || !workspace) throw new Error("database path, workspace, and optional target are required")

const postimage = "desktop-runtime-insight-postimage\n"
const preimage = "desktop-runtime-insight-preimage\n"
const assetHTMLResource = "src/index.html"
const assetSourceURL = "https://cdn.example.test/desktop-app.js"
const assetHTML = `<script src="${assetSourceURL}"></script>\n`
const assetPostimage = "console.log('desktop asset localization')\n"
const artifactRoot = join(process.env.ARFORGE_HOME ?? workspace, "tmp", "rollback-artifacts")
const directory = AbsolutePath.make(workspace)
const sessionID = SessionSchema.ID.make("ses_desktop_runtime_insight_review")
const assistantMessageID = SessionMessage.ID.make("msg_desktop_runtime_insight_review")
const toolCallID = "call_desktop_runtime_insight_review"
const actionID = ActionGateway.stableActionID({ sessionID, assistantMessageID, toolCallID })
const boundaryReadyFile = process.env.ARFORGE_TEST_BOUNDARY_READY_FILE?.trim()
const location = Layer.succeed(
  Location.Service,
  Location.Service.of({ directory, project: { id: Project.ID.global, directory } }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

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

const format = Layer.succeed(
  Format.Service,
  Format.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    file: () => Effect.succeed(false),
  }),
)

const truncate = Layer.succeed(
  Truncate.Service,
  Truncate.Service.of({
    cleanup: () => Effect.void,
    write: () => Effect.die("unused"),
    output: (content: string) => Effect.succeed({ content, truncated: false }),
    limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
  }),
)

const agent = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed({ name: "build", permission: [] } as SeedAgentInfo),
    list: () => Effect.succeed([]),
    defaultInfo: () => Effect.succeed({ name: "build", permission: [] } as SeedAgentInfo),
    defaultAgent: () => Effect.succeed("build"),
    generate: () => Effect.die("unused"),
  }),
)

const locationMap = buildLocationServiceMap([
  [RollbackArtifact.node, RollbackArtifact.layerWith(artifactRoot)],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    DurableAction.node,
    ActionGateway.node,
    RollbackArtifact.node,
    CoreToolRegistry.node,
    CoreToolRegistry.toolsNode,
    FileMutation.node,
    LocationServiceMap.node,
    LSP.node,
    Format.node,
    Truncate.node,
    Agent.node,
    FSUtil.node,
    EventV2Bridge.node,
  ]),
  [
    [Database.node, Database.layerFromPath(databasePath)],
    [Location.node, location],
    [RollbackArtifact.node, RollbackArtifact.layerWith(artifactRoot)],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [LocationServiceMap.node, locationMap],
    [LSP.node, lsp],
    [Format.node, format],
    [Truncate.node, truncate],
    [Agent.node, agent],
  ],
)

await writeFile(join(workspace, target), preimage, "utf8")
await mkdir(join(workspace, "src"), { recursive: true })
await writeFile(join(workspace, assetHTMLResource), assetHTML, "utf8")
if (boundaryReadyFile)
  await writeFile(
    boundaryReadyFile,
    JSON.stringify({ actionID, target, mode: process.env.ARFORGE_TEST_MUTATION_BOUNDARY ?? null }),
    "utf8",
  )

const program = Effect.gen(function* () {
  const plugin = {
    trigger: ((_name: string, _input: unknown, output: unknown) => Effect.succeed(output)) as SeedPlugin["trigger"],
  } as SeedPlugin
  const write = yield* MatureTool.init(yield* WriteTool)
  const carrier = makeLegacySessionTools(
    [write],
    { plugin, directory: workspace, worktree: workspace },
    {
      messages: [],
      sandboxProfile: SandboxPolicy.DefaultProfile,
      extra: {},
      workspace,
      metadata: () => Effect.void,
    },
  )
  const registry = yield* CoreToolRegistry.Service
  const materialized = yield* registry.materialize([], sessionID, {
    includeRegistered: false,
    legacySessionTools: carrier,
  })
  const settlement = yield* materialized.settle({
    sessionID,
    agent: AgentV2.ID.make("build"),
    assistantMessageID,
    call: {
      type: "tool-call",
      id: toolCallID,
      name: "write",
      input: { filePath: join(workspace, target), content: postimage },
    },
  })
  if (settlement.result.type === "error") throw new Error(String(settlement.result.value))
  const actions = yield* DurableAction.Service
  const snapshot = yield* actions.load(actionID)
  if (snapshot.action.status !== "settled" || snapshot.mutationIntent?.phase !== "settled")
    throw new Error("mature write did not settle a durable mutation intent")

  // Exercise the actual Core asset-localization adapter in the same isolated
  // runtime that the Electron renderer will inspect. The fetch callback is
  // deterministic test data, but it still receives and asserts the exact
  // egress capability issued by ActionGateway; no product tool is registered.
  const gateway = yield* ActionGateway.Service
  const fs = yield* FSUtil.Service
  const files = yield* FileMutation.Service
  const rollbackArtifacts = yield* RollbackArtifact.Service
  const assetSessionID = SessionSchema.ID.make("ses_desktop_asset_localization")
  const assetAssistantMessageID = SessionMessage.ID.make("msg_desktop_asset_localization")
  const assetToolCallID = "call_desktop_asset_localization"
  const assetDiscovery = AssetLocalization.discover({
    htmlResource: assetHTMLResource,
    html: new TextEncoder().encode(assetHTML),
    assetRoot: "vendor",
  })
  const assetAction = (discovery: AssetLocalization.AssetDiscovery): ActionGateway.Input => {
    const subject = {
      sessionID: assetSessionID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: assetAssistantMessageID,
      toolCallID: assetToolCallID,
    }
    return {
      ...subject,
      actionID: ActionGateway.stableActionID(subject),
      name: AssetLocalizationAction.ACTION_NAME,
      resources: AssetLocalizationAction.actionResources(discovery),
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier: "L2",
        authority: "scoped_grant",
        idempotency: "conditional",
        retryability: "guarded",
        reversibility: "compensatable",
        filesystemScope: [discovery.htmlResource, AssetLocalizationAction.filesystemPrefixResource(discovery)],
        networkScope: discovery.networkScope,
        secretScope: [],
        externalServices: ["HTTP origin from asset references"],
        expectedArtifacts: [discovery.htmlResource],
        successCriteria: ["every staged asset and the HTML rewrite commit or roll back atomically"],
      }),
      reasonSummary: "Localize external frontend assets into the workspace",
      inputDigest: discovery.requestDigest,
    }
  }
  const assetActionInput = assetAction(assetDiscovery)
  const assetResult = yield* AssetLocalizationAction.execute({
    gateway,
    worktree: workspace,
    htmlResource: assetHTMLResource,
    assetRoot: "vendor",
    action: assetAction,
    readFile: (file) =>
      fs.readFile(file.canonical).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      ),
    files,
    egress: (capability) => {
      const requests = ActionGateway.capabilityRequests(capability)
      const networkScope = requests
        .flatMap((request) => request.resources)
        .filter((resource) => resource.startsWith("http"))
      return Egress.make({
        action: AssetLocalizationAction.ACTION_NAME,
        networkScope,
        secretScope: [],
        allowedMethods: ["GET"],
        grantedResources: requests.flatMap((request) => request.resources),
      })
    },
    fetchAsset: ({ url, egress }) =>
      Effect.gen(function* () {
        yield* egress.assert({ url, method: "GET" })
        return {
          url,
          contentType: "text/javascript",
          bytes: new TextEncoder().encode(assetPostimage),
        }
      }),
    storeRollbackArtifact: (bytes) =>
      Effect.tryPromise({
        try: () => rollbackArtifacts.store.put(bytes),
        catch: (error) => error,
      }),
  })
  if (!assetResult.changed || assetResult.targets.length !== 2 || assetResult.transactionID === undefined)
    throw new Error("asset localization did not settle its expected HTML and staged asset writes")
  return {
    actionID,
    transactionID: snapshot.mutationIntent.transactionID,
    executions: 1,
    target,
    assetActionID: assetActionInput.actionID,
    assetTransactionID: assetResult.transactionID,
    assetTargets: assetResult.targets,
  }
})

const result = await Effect.runPromise(
  program.pipe(
    Effect.provide(layer),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provideService(InstanceRef, {
      directory: workspace,
      worktree: workspace,
      project: { id: "desktop-runtime-insight", worktree: workspace },
    } as never),
  ),
)
process.stdout.write(JSON.stringify(result))
