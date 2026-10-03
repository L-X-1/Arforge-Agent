import { Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Global } from "@arforge-ai/core/global"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"

const [root, state] = Bun.argv.slice(2)
if (!root || !state) throw new Error("artifact transaction crash worker requires root and state")

const layer = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.nodeWithoutConfig, FSUtil.node]), [
  [Global.node, Global.layerWith({ data: root, state })],
])

await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* ToolOutputStore.Service
    yield* store.bindBytes({
      bytes: new TextEncoder().encode("artifact transaction crash payload"),
      owner: { scope: "session", id: SessionV2.ID.make("ses_artifact_crash") },
      kind: "crash-fixture",
      mime: "text/plain",
    })
  }).pipe(Effect.provide(layer)),
)
