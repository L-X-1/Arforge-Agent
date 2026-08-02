import { run as runTui, type TuiInput } from "@arforge-ai/tui"
import { Global } from "@arforge-ai/core/global"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
