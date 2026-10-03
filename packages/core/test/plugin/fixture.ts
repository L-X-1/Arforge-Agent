import { AgentV2 } from "@arforge-ai/core/agent"
import { AISDK } from "@arforge-ai/core/aisdk"
import { Catalog } from "@arforge-ai/core/catalog"
import { CommandV2 } from "@arforge-ai/core/command"
import { Credential } from "@arforge-ai/core/credential"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { FileSystem } from "@arforge-ai/core/filesystem"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Integration } from "@arforge-ai/core/integration"
import { Location } from "@arforge-ai/core/location"
import { Npm } from "@arforge-ai/core/npm"
import { PluginV2 } from "@arforge-ai/core/plugin"
import { PluginEvents } from "@arforge-ai/core/plugin/events"
import { Reference } from "@arforge-ai/core/reference"
import { SkillV2 } from "@arforge-ai/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    PluginEvents.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
