import { expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@arforge-ai/core/config"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

let nativePID = 0
mock.module("#pty", () => ({
  spawn: () => ({
    get pid() {
      return nativePID
    },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {},
  }),
}))
const { Pty } = await import("@arforge-ai/core/pty")
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
    ],
  ]),
)

it.live("PTY reads and JSON expose the real PID when the native process becomes ready", () =>
  Effect.gen(function* () {
    nativePID = 0
    const service = yield* Pty.Service
    const created = yield* service.create({ command: "owned-shell", cwd: "/tmp" })
    expect(created.pid).toBe(0)
    nativePID = 43210
    expect((yield* service.get(created.id)).pid).toBe(43210)
    expect((yield* service.list()).find((info) => info.id === created.id)?.pid).toBe(43210)
    expect(JSON.parse(JSON.stringify(yield* service.get(created.id))).pid).toBe(43210)
    yield* service.remove(created.id)
  }),
)
