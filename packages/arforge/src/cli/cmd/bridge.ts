import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { createLocalBridgeClient, JsonlBridgeServer } from "../../bridge/jsonl"

/**
 * TypeScript machine bridge for IDE clients. The bridge is deliberately a
 * protocol adapter: session execution, event publication, VCS and policy
 * remain owned by the existing TypeScript server/API layers.
 */
export const BridgeCommand = effectCmd({
  command: "bridge",
  describe: "启动 TypeScript JSONL 机器客户端桥接",
  instance: false,
  handler: Effect.fn("Cli.bridge")(function* () {
    const workspace = process.env.ARFORGE_WORKSPACE?.trim() || process.cwd()
    const client = yield* Effect.promise(() => createLocalBridgeClient(workspace))
    const server = new JsonlBridgeServer({ client, workspace })

    // A machine protocol must never be contaminated by human-readable stdout
    // from an optional dependency. Bridge diagnostics belong on stderr.
    const originalLog = console.log
    console.log = (...args: unknown[]) => console.error(...args)
    try {
      yield* Effect.promise(() => server.serve())
    } finally {
      console.log = originalLog
      yield* Effect.promise(() => server.close())
    }
  }),
})
