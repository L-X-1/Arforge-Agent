import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { node as rollbackArtifactNode } from "@arforge-ai/core/runtime/rollback-artifact"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"

const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(11), "sigkill-action-test-aes-256-gcm"),
)

export const action = () => {
  const context = {
    sessionID: SessionSchema.ID.make("ses_sigkill_probe"),
    assistantMessageID: SessionMessage.ID.make("msg_sigkill_probe"),
    toolCallID: "call_sigkill_probe",
  }
  return {
    ...context,
    actionID: ActionGateway.stableActionID(context),
    agent: AgentV2.ID.make("build"),
    name: "sigkill-crash-probe",
    resources: ["external-side-effect:sigkill-probe"],
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L0",
      authority: "automatic",
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "irreversible",
      filesystemScope: [],
      networkScope: [],
      secretScope: [],
      externalServices: ["sigkill-probe"],
      expectedArtifacts: [],
      successCriteria: ["the external side effect is observed"],
    }),
    reasonSummary: "Crash-recovery integration probe",
    inputDigest: "sigkill-crash-probe-input",
  } as const
}

/** Safe/idempotent variant used to prove the mutation gate, rather than the
 * generic guarded-action recovery policy, survives a real SIGKILL. */
export const mutationAction = () => {
  const context = {
    sessionID: SessionSchema.ID.make("ses_sigkill_mutation_probe"),
    assistantMessageID: SessionMessage.ID.make("msg_sigkill_mutation_probe"),
    toolCallID: "call_sigkill_mutation_probe",
  }
  return {
    ...context,
    actionID: ActionGateway.stableActionID(context),
    agent: AgentV2.ID.make("build"),
    name: "sigkill-mutation-crash-probe",
    resources: ["workspace-file:sigkill-mutation-probe"],
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L0",
      authority: "automatic",
      idempotency: "idempotent",
      retryability: "safe",
      reversibility: "reversible",
      filesystemScope: ["workspace"],
      networkScope: [],
      secretScope: [],
      externalServices: [],
      expectedArtifacts: ["workspace-file:sigkill-mutation-probe"],
      successCriteria: ["the mutation transaction is durably settled"],
    }),
    reasonSummary: "Mutation crash-recovery integration probe",
    inputDigest: "sigkill-mutation-crash-probe-input",
  } as const
}

export const mutationEntries = (): ReadonlyArray<AgentRuntime.MutationIntentEntry> => [
  {
    target: "sigkill-mutation.txt",
    operation: "create",
    afterDigest: createHash("sha256").update("c").digest("hex"),
    afterByteLength: 1,
    recovery: "remove-if-matching",
  },
]

export const mutationManifestDigest = () => MutationIntent.manifestDigest(mutationEntries())!

export const artifactMutationEntries = (artifact: AgentRuntime.MutationRollbackArtifact) =>
  [
    {
      target: "sigkill-artifact-mutation.txt",
      operation: "write" as const,
      beforeDigest: createHash("sha256").update("before").digest("hex"),
      afterDigest: createHash("sha256").update("after").digest("hex"),
      afterByteLength: 5,
      rollbackArtifact: artifact,
      recovery: "restore-from-artifact" as const,
    },
  ] satisfies ReadonlyArray<AgentRuntime.MutationIntentEntry>

export const artifactMutationManifestDigest = (artifact: AgentRuntime.MutationRollbackArtifact) =>
  MutationIntent.manifestDigest(artifactMutationEntries(artifact))!

export const runtimeLayer = (databasePath: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableAction.node,
      DurableRun.node,
      rollbackArtifactNode,
      Authorizer.node,
      ActionGateway.node,
    ]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [PermissionV2.node, permissionLayer],
      [SecretProvider.node, secretLayer],
    ],
  )
