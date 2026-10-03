import { Effect } from "effect"
import * as SettlementOutbox from "./settlement-outbox"
import type { InvariantMode, InvariantReport, RuntimeInvariantRegistry } from "./invariants"

/** Package-owned invariant for the durable, payload-free settlement receipt. */
export const OWNER = "settlement-outbox" as const
export const KEY = "receipt" as const
export const VERSION = "1" as const

export type SettlementOutboxInvariantContext = Readonly<{
  readonly record: unknown
}>

export const registerInvariants = (registry: RuntimeInvariantRegistry): void => {
  if (registry.get(OWNER, KEY, VERSION)) return
  registry.register({
    owner: OWNER,
    key: KEY,
    version: VERSION,
    cost: "cheap",
    check: (context) =>
      Effect.sync(() => {
        if (context === null || typeof context !== "object" || Array.isArray(context))
          throw new Error("settlement outbox invariant context is invalid")
        const value = context as Partial<SettlementOutboxInvariantContext>
        SettlementOutbox.assertSettlementOutboxRecord(value.record)
      }),
  })
}

export const inspect = (
  registry: RuntimeInvariantRegistry,
  context: SettlementOutboxInvariantContext,
  mode: InvariantMode = process.env.NODE_ENV === "production" ? "production" : "development",
): Effect.Effect<InvariantReport> => {
  registerInvariants(registry)
  return registry.run(context, { owner: OWNER, key: KEY, mode })
}
