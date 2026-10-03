export * as EmbeddedAuthorization from "./embedded-authorization"

import { Context, Effect } from "effect"

export type Callback = () => Effect.Effect<void>

export const Current = Context.Reference<Callback | undefined>("@arforge/v2/EmbeddedAuthorization", {
  defaultValue: () => undefined,
})

/** Called after the exact leaf permission gate succeeds and before its side effect starts. */
export const notify = Effect.gen(function* () {
  const current = yield* Current
  if (current) yield* current()
})
