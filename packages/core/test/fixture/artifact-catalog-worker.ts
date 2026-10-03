import { Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Global } from "@arforge-ai/core/global"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"

const [root, state, workerID] = Bun.argv.slice(2)
if (!root || !state || !workerID) throw new Error("artifact catalog worker requires root, state, and worker ID")

const layer = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.nodeWithoutConfig, FSUtil.node]), [
  [Global.node, Global.layerWith({ data: root, state })],
])

try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* ToolOutputStore.Service
      yield* store.bound({
        sessionID: SessionV2.ID.make(`ses_catalog_${workerID}`),
        toolCallID: `catalog-${workerID}`,
        output: {
          structured: {},
          content: [{ type: "text", text: `${workerID}:` + "x".repeat(ToolOutputStore.MAX_BYTES + 1) }],
        },
      })
    }).pipe(Effect.provide(layer)),
  )
  console.log(`artifact-catalog-worker-ok:${workerID}`)
} catch (cause) {
  console.error(cause)
  process.exitCode = 1
}
