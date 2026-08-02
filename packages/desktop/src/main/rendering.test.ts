import { describe, expect, test } from "bun:test"
import { shouldDisableHardwareAcceleration } from "./rendering"

describe("desktop rendering policy", () => {
  test("uses the GPU compositor by default on Windows", () => {
    expect(shouldDisableHardwareAcceleration("win32", undefined, undefined)).toBe(false)
    expect(shouldDisableHardwareAcceleration("win32", "", "")).toBe(false)
  })

  test("allows an explicit Windows software fallback", () => {
    expect(shouldDisableHardwareAcceleration("win32", undefined, "1")).toBe(true)
    expect(shouldDisableHardwareAcceleration("win32", undefined, "true")).toBe(true)
    expect(shouldDisableHardwareAcceleration("win32", undefined, " SOFTWARE ")).toBe(true)
  })

  test("keeps the legacy rendering override compatible", () => {
    expect(shouldDisableHardwareAcceleration("win32", "1", undefined)).toBe(false)
    expect(shouldDisableHardwareAcceleration("win32", "true", undefined)).toBe(false)
    expect(shouldDisableHardwareAcceleration("win32", "0", undefined)).toBe(true)
    expect(shouldDisableHardwareAcceleration("win32", "false", undefined)).toBe(true)
  })

  test("does not change rendering on other platforms", () => {
    expect(shouldDisableHardwareAcceleration("darwin", undefined, "1")).toBe(false)
    expect(shouldDisableHardwareAcceleration("linux", undefined, "1")).toBe(false)
  })
})
