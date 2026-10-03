import { describe, expect, it } from "bun:test"

import { CLI_AUTO_SHARE_SUPPRESSED, CLI_SHARE_MUTATION_UNAVAILABLE, runLegacyCliShare } from "@/cli/cmd/run"

describe("run legacy share gate", () => {
  it("suppresses config or environment auto-share", async () => {
    const warnings: string[] = []

    const outcome = await runLegacyCliShare({
      explicit: false,
      automatic: true,
      warn: (message) => warnings.push(message),
    })

    expect(outcome).toBe("suppressed")
    expect(warnings).toEqual([CLI_AUTO_SHARE_SUPPRESSED])
    expect(warnings[0]).toContain("sealed ControlRun worker")
  })

  it("blocks an explicit --share request without reporting a successful publication", async () => {
    const warnings: string[] = []

    const outcome = await runLegacyCliShare({
      explicit: true,
      automatic: true,
      warn: (message) => warnings.push(message),
    })

    expect(outcome).toBe("blocked")
    expect(warnings).toEqual([CLI_SHARE_MUTATION_UNAVAILABLE])
    expect(warnings[0]).toContain("did not publish anything")
  })

  it("does nothing when neither explicit nor automatic sharing is requested", async () => {
    const outcome = await runLegacyCliShare({
      explicit: false,
      automatic: false,
      warn: () => {
        throw new Error("unexpected warning")
      },
    })

    expect(outcome).toBe("idle")
  })
})
