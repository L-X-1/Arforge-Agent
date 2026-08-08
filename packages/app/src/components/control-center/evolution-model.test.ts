import { describe, expect, test } from "bun:test"
import {
  evolutionActionRequiresReason,
  evolutionActions,
  evolutionEvidenceRefs,
  evolutionRefreshError,
  readableEvolutionError,
} from "./evolution-model"

describe("governed Evolution UI model", () => {
  test("exposes only lifecycle-valid actions", () => {
    expect(evolutionActions("proposed", false, false)).toEqual(["evaluate", "reject"])
    expect(evolutionActions("evaluated", false, false)).toEqual(["evaluate", "reject"])
    expect(evolutionActions("evaluated", true, false)).toEqual(["evaluate", "approve", "reject"])
    expect(evolutionActions("approved", true, false)).toEqual(["reject", "startCanary"])
    expect(evolutionActions("canary", true, false)).toEqual(["rollback"])
    expect(evolutionActions("canary", true, true)).toEqual(["promote", "rollback"])
    expect(evolutionActions("promoted", true, true)).toEqual(["rollback"])
    expect(evolutionActions("rejected", true, true)).toEqual([])
    expect(evolutionActions("rolled_back", true, true)).toEqual([])
  })

  test("requires human reasons for every decision except isolated evaluation", () => {
    expect(evolutionActionRequiresReason("evaluate")).toBe(false)
    for (const action of ["approve", "reject", "startCanary", "promote", "rollback"] as const)
      expect(evolutionActionRequiresReason(action)).toBe(true)
  })

  test("normalizes and deduplicates evidence references", () => {
    expect(evolutionEvidenceRefs("run:1\n learning-pattern:2 \nrun:1\n")).toEqual(["run:1", "learning-pattern:2"])
  })

  test("turns transport JSON into a readable and deduplicated refresh error", () => {
    const transportError = new Error(
      JSON.stringify({ error: "Web UI unavailable: build the embedded UI or configure ARFORGE_UI_UPSTREAM_URL." }),
    )
    expect(readableEvolutionError(transportError)).toBe(
      "Web UI unavailable: build the embedded UI or configure ARFORGE_UI_UPSTREAM_URL.",
    )
    expect(evolutionRefreshError([transportError, transportError], "Restart required")).toBe("Restart required")
  })
})
