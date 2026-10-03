import { describe, expect, test } from "bun:test"
import { SandboxPolicy } from "../../src/sandbox/policy"
import path from "node:path"

describe("SandboxPolicy session presets", () => {
  test("keeps explicit read grants separate from writable roots", () => {
    const workspace = path.resolve("workspace-fixture")
    const dependency = path.resolve("dependency-fixture")
    const policy = SandboxPolicy.resolve({ workspace, cwd: workspace, readOnlyRoots: [dependency, dependency] })
    expect(policy.roots).toEqual([workspace])
    expect(policy.readOnlyRoots).toEqual([dependency])
    expect(SandboxPolicy.resolve({ workspace, cwd: workspace }).readOnlyRoots).toBeUndefined()
  })

  test("keeps the historical workspace-write default for legacy sessions", () => {
    expect(SandboxPolicy.profileFromMetadata(undefined)).toBe("workspace-write")
    expect(SandboxPolicy.profileFromMetadata({ other: "value", sandboxProfile: "unknown" })).toBe("workspace-write")
  })

  test("accepts only the three explicit user presets", () => {
    expect(SandboxPolicy.isProfile("read-only")).toBe(true)
    expect(SandboxPolicy.isProfile("workspace-write")).toBe(true)
    expect(SandboxPolicy.isProfile("unrestricted")).toBe(true)
    expect(SandboxPolicy.isProfile("full-host")).toBe(false)
    expect(SandboxPolicy.isProfile(null)).toBe(false)
  })

  test("updates only the owned metadata key and survives a second read", () => {
    const metadata = SandboxPolicy.setProfileMetadata({ source: "ui", nested: { keep: true } }, "read-only")
    expect(metadata).toEqual({ source: "ui", nested: { keep: true }, sandboxProfile: "read-only" })
    expect(SandboxPolicy.profileFromMetadata(metadata)).toBe("read-only")

    const changed = SandboxPolicy.setProfileMetadata(metadata, "unrestricted")
    expect(changed).toEqual({ source: "ui", nested: { keep: true }, sandboxProfile: "unrestricted" })
  })

  test("provides plain-language descriptions for each preset", () => {
    for (const profile of ["read-only", "workspace-write", "unrestricted"] as const) {
      expect(SandboxPolicy.ProfileInfo[profile].label.length).toBeGreaterThan(0)
      expect(SandboxPolicy.ProfileInfo[profile].description.length).toBeGreaterThan(20)
    }
  })
})
