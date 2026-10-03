import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { Plugins, PluginInstallError, PluginInstallRuntime } from "@arforge-ai/core/analysis/plugins"

function tempHome(): string {
  const home = join(tmpdir(), `arforge-plugins-test-${randomBytes(8).toString("hex")}`)
  mkdirSync(join(home, "plugins"), { recursive: true })
  return home
}

function writePlugin(root: string, name: string, extra = ""): string {
  const dir = join(root, "plugins", name)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    version: "1.0.0",
    description: `Plugin ${name}`,
    tools: [
      {
        name: "run",
        description: "Run a bounded command",
        command: ["echo", "ok"],
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
  }
  writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  writeFileSync(join(dir, "note.txt"), `${name} payload`, "utf8")
  void extra
  return dir
}

describe("Plugins", () => {
  test("discovers plugins with managed marking", () => {
    const home = tempHome()
    writePlugin(home, "demo")
    const listed = Plugins.listPlugins({ home })
    expect(listed.count).toBe(1)
    const item = listed.items[0]
    expect(item).toMatchObject({ name: "demo", version: "1.0.0", managed: true, enabled: true })
    expect(item.tools).toHaveLength(1)
    expect(existsSync(item.manifest_path)).toBe(true)
  })

  test("exposes the manifest contract and blocks forbidden runtime access", () => {
    const home = tempHome()
    const dir = writePlugin(home, "secure-demo")
    writeFileSync(
      join(dir, "runner.js"),
      "fetch('https://example.com'); process.env.API_KEY; EventV2.publish('x')",
      "utf8",
    )
    const manifestPath = join(dir, "plugin.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "secure-demo",
        version: "1.0.0",
        description: "Contract test",
        permissions: [{ action: "filesystem.read", resources: ["profile://plugins/secure-demo"] }],
        egress: ["https://example.com"],
        secrets: ["API_KEY"],
        compatibility: { api_version: 1, platforms: ["win32"] },
        tools: [{ name: "run", description: "Run", command: ["echo", "ok"] }],
      }),
      "utf8",
    )

    const item = Plugins.listPlugins({ home }).items[0]
    expect(item).toMatchObject({
      source: "profile",
      compatibility: { api_version: 1, platforms: ["win32"] },
      signature: { status: "unsigned" },
    })
    expect(item.permissions).toEqual([{ action: "filesystem.read", resources: ["profile://plugins/secure-demo"] }])
    expect(item.egress).toEqual(["https://example.com"])
    expect(item.secrets).toEqual(["API_KEY"])
    expect(item.security.status).toBe("blocked")
    expect(item.security.findings.some((finding) => finding.rule === "forbidden-runtime-boundary")).toBe(true)
    expect(item.problems.some((problem) => problem.includes("forbidden EventV2"))).toBe(true)
  })

  test("fails closed when an inspected package has undeclared network or secret access", () => {
    const home = tempHome()
    const source = join(home, "unsafe")
    const dir = join(source, "unsafe-demo")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "unsafe-demo",
        version: "1.0.0",
        description: "Unsafe package",
        tools: [{ name: "run", description: "Run", command: ["echo", "ok"] }],
      }),
      "utf8",
    )
    writeFileSync(join(dir, "runner.js"), "fetch('https://example.com'); process.env.SECRET_TOKEN", "utf8")

    const runtime = new PluginInstallRuntime({ home })
    const inspection = runtime.inspect(source)
    const candidate = inspection.candidates[0] as {
      readonly security: {
        readonly status: string
        readonly findings: ReadonlyArray<{ readonly rule: string }>
      }
    }
    expect(candidate.security.status).toBe("blocked")
    expect(candidate.security.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["undeclared-egress", "undeclared-secret"]),
    )
    expect(() => runtime.apply(inspection.token)).toThrow(/secret|egress|manifest/i)
  })

  test("persists enablement overrides", () => {
    const home = tempHome()
    const dir = writePlugin(home, "demo")
    Plugins.setPluginEnabled(join(dir, "plugin.json"), false, home)
    const listed = Plugins.listPlugins({ home })
    expect(listed.items[0].enabled).toBe(false)
    const reloaded = Plugins.loadPluginOverrides(home)
    expect(Object.values(reloaded)[0]).toBe(false)
  })

  test("routes enablement changes through the managed runtime", () => {
    const home = tempHome()
    writePlugin(home, "demo")
    const runtime = new PluginInstallRuntime({ home })

    runtime.setEnabled("demo", false)

    expect(Plugins.listPlugins({ home }).items[0].enabled).toBe(false)
  })

  test("flags invalid manifests", () => {
    const home = tempHome()
    const dir = join(home, "plugins", "broken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "Broken Name!", tools: [{ name: "x" }] }), "utf8")
    const listed = Plugins.listPlugins({ home })
    const item = listed.items.find((entry) => entry.name === "broken")
    expect(item?.problems.length).toBeGreaterThan(0)
  })

  test("inspects and installs a local directory plugin", () => {
    const home = tempHome()
    const source = join(home, "package")
    const pluginDir = join(source, "demo")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        version: "2.0.0",
        description: "From package",
        tools: [
          {
            name: "go",
            description: "Do",
            command: ["echo", "x"],
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      }),
      "utf8",
    )
    writeFileSync(join(pluginDir, "run.txt"), "payload", "utf8")

    const runtime = new PluginInstallRuntime({ home })
    const inspection = runtime.inspect(source)
    expect(inspection.token).toMatch(/^[0-9a-f]{32}$/)
    expect(inspection.selection_required).toBe(false)
    expect(inspection.candidates[0]).toMatchObject({ name: "demo", version: "2.0.0" })

    const applied = runtime.apply(inspection.token)
    expect(applied).toMatchObject({ name: "demo", version: "2.0.0", updated: false, enabled: false })
    expect(runtime.replayApply("demo")).toMatchObject({ name: "demo", source: "replay", enabled: false })
    expect(existsSync(join(home, "plugins", "demo", "plugin.json"))).toBe(true)
    expect(existsSync(join(home, "plugins", "demo", "run.txt"))).toBe(true)
  })

  test("rejects unsafe and unsupported sources", () => {
    const home = tempHome()
    const runtime = new PluginInstallRuntime({ home })
    expect(() => runtime.inspect("https://example.com/repo.git")).toThrow(PluginInstallError)
    expect(() => runtime.inspect(join(home, "missing-dir"))).toThrow(PluginInstallError)
  })

  test("removes and restores a managed plugin", () => {
    const home = tempHome()
    writePlugin(home, "demo")
    const runtime = new PluginInstallRuntime({ home })
    const removal = runtime.remove("demo")
    expect(removal).toMatchObject({ name: "demo", removed: true, recoverable: true })
    expect(runtime.replayRemove("demo")).toMatchObject({ name: "demo", removed: true, recoverable: true })
    expect(existsSync(join(home, "plugins", "demo"))).toBe(false)

    const restored = runtime.restore(removal.recovery.recovery_id as string)
    expect(restored).toMatchObject({ name: "demo", restored: true, enabled: false })
    expect(runtime.replayRestore(removal.recovery.recovery_id as string)).toMatchObject({
      name: "demo",
      restored: true,
    })
    expect(existsSync(join(home, "plugins", "demo", "plugin.json"))).toBe(true)
  })

  test("re-scans recovery contents before restoring a plugin", () => {
    const home = tempHome()
    writePlugin(home, "demo")
    const runtime = new PluginInstallRuntime({ home })
    const removal = runtime.remove("demo")
    const recoveryID = removal.recovery.recovery_id as string
    const recoveryRoot = join(home, "trash", "plugins", recoveryID)
    writeFileSync(join(recoveryRoot, "runner.js"), "fetch('https://untrusted.example')", "utf8")

    expect(() => runtime.restore(recoveryID)).toThrow(/egress|manifest/i)
    expect(existsSync(join(home, "plugins", "demo"))).toBe(false)
    expect(existsSync(recoveryRoot)).toBe(true)
  })

  test("rejects duplicate installation without replace", () => {
    const home = tempHome()
    writePlugin(home, "demo")
    const source = join(home, "package", "demo")
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, "plugin.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        description: "dup",
        tools: [
          {
            name: "go",
            description: "Do",
            command: ["echo", "x"],
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      }),
      "utf8",
    )

    const runtime = new PluginInstallRuntime({ home })
    const inspection = runtime.inspect(join(home, "package"))
    expect(() => runtime.apply(inspection.token)).toThrow(/already installed/)
  })
})
