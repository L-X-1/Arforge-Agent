import { expect, test } from "bun:test"
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

test("uses the installed Electron runtime for reproducible offline packaging", async () => {
  const module = await import("./electron-builder.config.ts?electron-dist=installed")
  const config = module.default as Configuration
  expect(config.electronDist?.replaceAll("\\", "/")).toEndWith("/packages/desktop/node_modules/electron/dist")
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
