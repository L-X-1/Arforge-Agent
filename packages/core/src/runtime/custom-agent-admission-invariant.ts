import { Effect } from "effect"
import {
  customAgentRuntimeAdmissionEvidence,
  type CustomAgentRuntimeAdmission,
} from "../custom-agent-profile"
import type { InvariantMode, InvariantReport, RuntimeInvariantRegistry } from "./invariants"

export const OWNER = "custom-agent-runtime" as const
export const KEY = "admission-receipt" as const
export const VERSION = "1" as const

/** Register the cheap, payload-free custom-agent admission invariant once. */
export const registerInvariants = (registry: RuntimeInvariantRegistry): void => {
  if (registry.get(OWNER, KEY, VERSION)) return
  registry.register({
    owner: OWNER,
    key: KEY,
    version: VERSION,
    cost: "cheap",
    check: (context) =>
      Effect.sync(() => {
        const evidence = customAgentRuntimeAdmissionEvidence(context)
        if (!evidence.valid)
          throw new Error(evidence.violations.join("; ") || "custom-agent admission receipt is invalid")
      }),
  })
}

/** Run the admission invariant without creating a second state machine. */
export const inspect = (
  registry: RuntimeInvariantRegistry,
  admission: CustomAgentRuntimeAdmission,
  mode: InvariantMode = process.env.NODE_ENV === "production" ? "production" : "development",
): Effect.Effect<InvariantReport> =>
  registry.run(admission, {
    owner: OWNER,
    key: KEY,
    mode,
  })
