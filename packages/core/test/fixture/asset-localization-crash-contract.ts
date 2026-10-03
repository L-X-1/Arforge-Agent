import { Effect, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { filesystem } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import { AbsolutePath } from "@arforge-ai/core/schema"

export const HTML_RESOURCE = "src/index.html"
export const HTML_SOURCE = '<script src="https://cdn.example.test/app.js"></script>'
export const ASSET_BYTES = new TextEncoder().encode("console.log('asset-sigkill')")

const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" as const }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(17), "asset-localization-sigkill-secret"),
)

/** The same persisted Core services are reopened by both worker and restarter. */
export const runtimeLayer = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, DurableAction.node, DurableRun.node, Authorizer.node, ActionGateway.node]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [PermissionV2.node, permissionLayer],
      [SecretProvider.node, secretLayer],
    ],
  )

/** Real platform FileMutation and profile-owned inverse artifact storage. */
export const workspaceLayer = (workspace: string, rollbackRoot: string) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory: AbsolutePath.make(workspace),
      workspaceID: undefined,
      project: { id: "global", directory: AbsolutePath.make(workspace) },
    } as Location.Interface),
  )
  return AppNodeBuilder.build(
    LayerNode.group([LocationMutation.node, FileMutation.node, RollbackArtifact.node]),
    [
      [Location.node, activeLocation],
      [filesystem, LayerNode.compile(filesystem)],
      [FSUtil.node, LayerNode.compile(FSUtil.node)],
      [RollbackArtifact.node, RollbackArtifact.layerWith(rollbackRoot)],
    ],
  )
}

export const action = (discovery: AssetLocalization.AssetDiscovery): ActionGateway.Input => {
  const subject = {
    sessionID: SessionSchema.ID.make("ses_asset_sigkill_probe"),
    agent: AgentV2.ID.make("build"),
    assistantMessageID: SessionMessage.ID.make("msg_asset_sigkill_probe"),
    toolCallID: "call_asset_sigkill_probe",
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

export const discovery = () =>
  AssetLocalization.discover({ htmlResource: HTML_RESOURCE, html: HTML_SOURCE, assetRoot: "vendor" })
