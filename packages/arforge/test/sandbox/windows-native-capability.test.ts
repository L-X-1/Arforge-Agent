import { describe, expect, test } from "bun:test"
import { probeWindowsNativeCapability } from "@/sandbox/windows-native-capability"

describe("Windows native sandbox capability probe", () => {
  test("does not load Windows DLLs for a non-Windows host", () => {
    expect(probeWindowsNativeCapability("linux", {}).status).toBe("not-probed")
  })

  test("honours the explicit diagnostic disable switch without probing", () => {
    const result = probeWindowsNativeCapability("win32", {
      ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER: "1",
    })
    expect(result).toEqual({
      api: "processmodel",
      status: "disabled",
      exportPresent: false,
      reason: "BaseContainer probe disabled by ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER",
    })
  })

  test("reports the real host state when running on Windows", () => {
    if (process.platform !== "win32") return
    const result = probeWindowsNativeCapability()
    expect(["available", "disabled", "unavailable"]).toContain(result.status)
    expect(result.api).toBe("processmodel")
    expect(result.reason.length).toBeGreaterThan(0)
    if (result.status === "disabled") expect(result.exportPresent).toBe(true)
  })
})
