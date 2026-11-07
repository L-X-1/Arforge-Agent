import { expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { tmpdir } from "node:os"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/arforge-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.arforge.desktop.dev" },
  { channel: "beta", appId: "ai.arforge.desktop.beta" },
  { channel: "prod", appId: "ai.arforge.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.ARFORGE_CHANNEL
    process.env.ARFORGE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.ARFORGE_CHANNEL
    else process.env.ARFORGE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.ARFORGE_CHANNEL
  process.env.ARFORGE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.ARFORGE_CHANNEL
  else process.env.ARFORGE_CHANNEL = previous

  const expectedLauncher = `${legacyDesktopEntry}=/usr/share/applications/arforge-desktop.desktop`
  expect(config.deb?.fpm?.[0]?.replaceAll("\\", "/")).toEndWith(expectedLauncher)
  expect(config.rpm?.fpm?.[0]?.replaceAll("\\", "/")).toEndWith(expectedLauncher)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/Arforge/ai.arforge.desktop %U")
  expect(desktop).toContain("Icon=ai.arforge.desktop")
  expect(desktop).toContain("StartupWMClass=ai.arforge.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("does not ship the retired Python capability Sidecar", async () => {
  const module = await import("./electron-builder.config.ts?agent-python=resource")
  const config = module.default as Configuration
  const resources = config.extraResources ?? []
  expect(resources.some((entry) => JSON.stringify(entry).includes("agent-python"))).toBe(false)
  expect(config.files).toContain("!resources/agent-python-dist/**/*")
  expect(config.files).toContain("!resources/.agent-python-build/**/*")
})

test("does not ship bundled Core TypeScript source inside app.asar", async () => {
  const module = await import("./electron-builder.config.ts?core=bundled")
  const config = module.default as Configuration
  expect(config.files).toContain("!node_modules/@arforge-ai/core/**/*")
})

test("normal package preserves the existing prod identity and delivers SDK outside ASAR", async () => {
  const previous = process.env.ARFORGE_CHANNEL
  process.env.ARFORGE_CHANNEL = "prod"
  try {
    const config = (await import("./electron-builder.config.ts?usage=prod")).default
    expect(config.appId).toBe("ai.arforge.desktop")
    expect(config.productName).toBe("Arforge")
    expect(config.extraMetadata?.version).toBe("1.0.0")
    expect(config.extraResources).toContainEqual({ from: "out/main/assets/plugin-sdk", to: "plugin-sdk" })
    expect(config.files).toContain("!out/main/assets/plugin-sdk/**/*")
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_CHANNEL
    else process.env.ARFORGE_CHANNEL = previous
  }
})

test("uses the installed Electron runtime for reproducible offline packaging", async () => {
  const module = await import("./electron-builder.config.ts?electron-dist=installed")
  const config = module.default as Configuration
  expect(config.electronDist?.replaceAll("\\", "/")).toEndWith("/packages/desktop/node_modules/electron/dist")
})

test("canonical normalization retains the root manifest with isolated compiled output", async () => {
  const previous = process.env.ARFORGE_DESKTOP_OUT
  process.env.ARFORGE_DESKTOP_OUT = path.join(tmpdir(), "arforge-package-regression-compiled")
  try {
    const raw = (await import("./electron-builder.config.ts?manifest=normalized-isolated")).default
    const require = createRequire(import.meta.url)
    const builderRequire = createRequire(require.resolve("electron-builder"))
    const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config.js")
    const { getMainFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher.js")
    const config = doMergeConfigs([structuredClone(raw)])
    const appDir = import.meta.dir
    const info = { config, projectDir: appDir, buildResourcesDir: "resources", debugLogger: { isEnabled: false } }
    const matchers = getMainFileMatchers(
      appDir, path.join(tmpdir(), "arforge-package-regression-app"), (value: string) => value,
      {}, { info, config }, path.join(tmpdir(), "arforge-package-regression-dist"), false,
    )
    const manifest = path.join(appDir, "package.json")
    expect(matchers[0].from).toBe(appDir)
    expect(matchers[0].createFilter()(manifest, statSync(manifest))).toBe(true)
    expect(matchers.some((matcher: { from: string }) => matcher.from === process.env.ARFORGE_DESKTOP_OUT)).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_DESKTOP_OUT
    else process.env.ARFORGE_DESKTOP_OUT = previous
  }
})

test("actual resource copy retains the compiled SDK dependency closure", async () => {
  const owned = await mkdtemp(path.join(tmpdir(), "arforge-sdk-package-regression-"))
  const compiled = path.join(owned, "compiled")
  const sdk = path.join(compiled, "main/assets/plugin-sdk")
  const output = path.join(owned, "packaged-resources")
  const previous = process.env.ARFORGE_DESKTOP_OUT
  process.env.ARFORGE_DESKTOP_OUT = compiled
  try {
    await mkdir(path.join(sdk, "runtime"), { recursive: true })
    await mkdir(path.join(sdk, "node_modules/owned-dependency/node_modules/owned-nested"), { recursive: true })
    await writeFile(path.join(sdk, "package.json"), '{"name":"owned-sdk"}')
    await writeFile(path.join(sdk, "runtime/index.js"), 'export const value = 1')
    await writeFile(path.join(sdk, "node_modules/owned-dependency/package.json"), '{"name":"owned-dependency"}')
    await writeFile(path.join(sdk, "node_modules/owned-dependency/node_modules/owned-nested/package.json"), '{"name":"owned-nested"}')
    const raw = (await import("./electron-builder.config.ts?sdk=actual-resource-copy")).default
    const require = createRequire(import.meta.url)
    const builderRequire = createRequire(require.resolve("electron-builder"))
    const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config.js")
    const { getFileMatchers, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher.js")
    const config = doMergeConfigs([structuredClone(raw)])
    config.extraResources = config.extraResources.filter((entry: { to: string }) => entry.to.startsWith("plugin-sdk"))
    const matchers = getFileMatchers(config, "extraResources", output, {
      defaultSrc: import.meta.dir, macroExpander: (value: string) => value,
      customBuildOptions: {}, globalOutDir: output,
    })
    await copyFiles(matchers, null, false)
    expect(await readFile(path.join(output, "plugin-sdk/runtime/index.js"), "utf8")).toContain("export const value")
    expect(JSON.parse(await readFile(path.join(output, "plugin-sdk/node_modules/owned-dependency/package.json"), "utf8")).name).toBe("owned-dependency")
    expect(JSON.parse(await readFile(path.join(output, "plugin-sdk/node_modules/owned-dependency/node_modules/owned-nested/package.json"), "utf8")).name).toBe("owned-nested")
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_DESKTOP_OUT
    else process.env.ARFORGE_DESKTOP_OUT = previous
  }
})

test("does not emit a missing native-resource entry", async () => {
  const module = await import("./electron-builder.config.ts?native-resource=optional")
  const config = module.default as Configuration
  const resources = config.extraResources ?? []
  expect(resources.some((resource) => typeof resource === "object" && resource.from === "native/")).toBe(false)
})

test("fails closed into the DigiCert signer for a signed Beta build", async () => {
  const previous = {
    channel: process.env.ARFORGE_CHANNEL,
    provider: process.env.ARFORGE_WINDOWS_SIGNING_PROVIDER,
    alias: process.env.ARFORGE_WINDOWS_KEYPAIR_ALIAS,
  }
  process.env.ARFORGE_CHANNEL = "beta"
  process.env.ARFORGE_WINDOWS_SIGNING_PROVIDER = "digicert-keylocker"
  process.env.ARFORGE_WINDOWS_KEYPAIR_ALIAS = "arforge-beta"

  try {
    const module = await import("./electron-builder.config.ts?signing=digicert")
    const config = module.default as Configuration

    expect(config.win?.forceCodeSigning).toBe(true)
    expect(String(config.win?.signtoolOptions?.sign).replaceAll("\\", "/")).toEndWith("/scripts/windows-sign.cjs")
    expect(config.win?.verifyUpdateCodeSignature).toBe(true)
  } finally {
    for (const [name, value] of Object.entries({
      ARFORGE_CHANNEL: previous.channel,
      ARFORGE_WINDOWS_SIGNING_PROVIDER: previous.provider,
      ARFORGE_WINDOWS_KEYPAIR_ALIAS: previous.alias,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
