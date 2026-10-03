import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { PluginInstallRuntime } from "@arforge-ai/core/analysis/plugins"

const makeHome = () => {
  const home = join(tmpdir(), `arforge-plugin-security-${randomUUID().replaceAll("-", "")}`)
  mkdirSync(join(home, "plugins"), { recursive: true })
  return home
}

const recoveryID = (value: Readonly<Record<string, unknown>> | null) =>
  typeof value?.recovery_id === "string" ? value.recovery_id : ""

const writePackage = (
  root: string,
  input: {
    readonly name: string
    readonly version?: string
    readonly enabled?: boolean
    readonly egress?: ReadonlyArray<string>
    readonly secrets?: ReadonlyArray<string>
    readonly platforms?: ReadonlyArray<string>
    readonly code?: string
  },
) => {
  const directory = join(root, input.name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "plugin.json"),
    JSON.stringify({
      name: input.name,
      version: input.version ?? "1.0.0",
      description: "Plugin security boundary fixture.",
      enabled: input.enabled ?? false,
      egress: input.egress ?? [],
      secrets: input.secrets ?? [],
      compatibility: { api_version: 1, platforms: input.platforms ?? [process.platform] },
      tools: [{ name: "run", description: "Run", command: ["echo", "ok"] }],
    }),
    "utf8",
  )
  writeFileSync(join(directory, "runner.js"), input.code ?? "export const ready = true\n", "utf8")
  return directory
}

describe("Plugin security boundary", () => {
  test("requires actual egress targets and secret names to match declarations", () => {
    const home = makeHome()
    const source = join(home, "source")
    writePackage(source, {
      name: "scope-mismatch",
      egress: ["https://allowed.example"],
      secrets: ["ALLOWED_TOKEN"],
      code: "fetch('https://undeclared.example/data'); process.env.UNDECLARED_TOKEN\n",
    })

    const candidate = new PluginInstallRuntime({ home }).inspect(source).candidates[0]
    expect(candidate).toMatchObject({
      security: {
        status: "blocked",
        findings: expect.arrayContaining([
          expect.objectContaining({ rule: "undeclared-egress" }),
          expect.objectContaining({ rule: "undeclared-secret" }),
        ]),
      },
    })
  })

  test("accepts statically matched declarations", () => {
    const home = makeHome()
    const source = join(home, "source")
    writePackage(source, {
      name: "scope-match",
      egress: ["https://allowed.example"],
      secrets: ["ALLOWED_TOKEN"],
      code: "fetch('https://allowed.example/data'); process.env.ALLOWED_TOKEN\n",
    })

    const candidate = new PluginInstallRuntime({ home }).inspect(source).candidates[0]
    expect(JSON.stringify(candidate.security)).not.toContain("undeclared-egress")
    expect(JSON.stringify(candidate.security)).not.toContain("undeclared-secret")
  })

  test("blocks oversized executable source instead of silently skipping it", () => {
    const home = makeHome()
    const source = join(home, "source")
    writePackage(source, {
      name: "oversized-source",
      code: `${" ".repeat(512 * 1024)}fetch('https://undeclared.example')\n`,
    })

    const candidate = new PluginInstallRuntime({ home }).inspect(source).candidates[0]
    expect(candidate).toMatchObject({
      security: {
        status: "blocked",
        findings: expect.arrayContaining([expect.objectContaining({ rule: "scan-limit" })]),
      },
    })
  })

  test("rejects a package that excludes the current platform", () => {
    const home = makeHome()
    const source = join(home, "source")
    const incompatible = process.platform === "win32" ? "linux" : "win32"
    writePackage(source, { name: "wrong-platform", platforms: [incompatible] })

    const runtime = new PluginInstallRuntime({ home })
    const inspection = runtime.inspect(source)
    expect(inspection.candidates[0]).toMatchObject({
      problems: expect.arrayContaining([expect.stringMatching(/current platform|compatibility\.platforms/i)]),
    })
    expect(() => runtime.apply(inspection.token)).toThrow(/current platform|compatibility\.platforms/i)
  })

  test("cannot enable a managed plugin after its security boundary fails", () => {
    const home = makeHome()
    writePackage(join(home, "plugins"), {
      name: "blocked-enable",
      enabled: false,
      code: "fetch('https://undeclared.example')\n",
    })
    const runtime = new PluginInstallRuntime({ home })

    expect(() => runtime.setEnabled("blocked-enable", true)).toThrow(/security|invalid|blocked/i)
    expect(runtime.replayApply("blocked-enable").enabled).toBe(false)
  })

  test("refuses to enable a different version than the reviewed plugin", () => {
    const home = makeHome()
    const managedRoot = join(home, "plugins")
    writePackage(managedRoot, { name: "version-bound", version: "1.0.0", enabled: false })
    const runtime = new PluginInstallRuntime({ home })
    const reviewed = runtime.replayApply("version-bound")

    writePackage(managedRoot, { name: "version-bound", version: "2.0.0", enabled: false })

    expect(() =>
      runtime.setEnabled("version-bound", true, { version: reviewed.version, sha256: reviewed.sha256 }),
    ).toThrow(/changed|review/i)
    expect(runtime.replayApply("version-bound").enabled).toBe(false)
  })

  test("rolls an installed update back atomically and preserves an undo recovery", () => {
    const home = makeHome()
    const source = join(home, "source")
    writePackage(source, { name: "rollback-update", version: "1.0.0" })
    const runtime = new PluginInstallRuntime({ home })
    runtime.apply(runtime.inspect(source).token)

    writePackage(source, { name: "rollback-update", version: "2.0.0" })
    const updated = runtime.apply(runtime.inspect(source).token, "rollback-update", true)
    const versionOneRecovery = recoveryID(updated.recovery)
    expect(versionOneRecovery).not.toBe("")

    const rolledBack = runtime.restore(versionOneRecovery)
    expect(runtime.replayApply("rollback-update").version).toBe("1.0.0")
    expect(rolledBack).toMatchObject({ restored: true, enabled: false })
    expect(rolledBack.recovery?.reason).toBe("rollback")

    runtime.restore(recoveryID(rolledBack.recovery))
    expect(runtime.replayApply("rollback-update").version).toBe("2.0.0")
  })
})
