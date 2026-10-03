import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"

const packageDir = path.dirname(fileURLToPath(import.meta.url))
const configuredElectronDist = process.env.ARFORGE_ELECTRON_DIST?.trim()
const installedElectronDist = path.join(packageDir, "node_modules", "electron", "dist")
const electronDist = configuredElectronDist
  ? path.resolve(configuredElectronDist)
  : existsSync(installedElectronDist)
    ? installedElectronDist
    : undefined
const nativeResources = path.join(packageDir, "native")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "arforge-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.arforge.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "arforge-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/arforge-desktop.desktop`

const channel = (() => {
  const raw = process.env.ARFORGE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const windowsSigning = (): NonNullable<Configuration["win"]> => {
  const provider = process.env.ARFORGE_WINDOWS_SIGNING_PROVIDER?.trim()
  if (!provider) return {}
  if (provider !== "digicert-keylocker") {
    throw new Error(`Unsupported ARFORGE_WINDOWS_SIGNING_PROVIDER: ${provider}`)
  }
  if (!process.env.ARFORGE_WINDOWS_KEYPAIR_ALIAS?.trim()) {
    throw new Error("ARFORGE_WINDOWS_KEYPAIR_ALIAS is required for DigiCert KeyLocker signing")
  }
  return {
    forceCodeSigning: true,
    signtoolOptions: {
      sign: path.join(packageDir, "scripts", "windows-sign.cjs"),
    },
  }
}

const APP_IDS = {
  dev: "ai.arforge.desktop.dev",
  beta: "ai.arforge.desktop.beta",
  prod: "ai.arforge.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  ...(electronDist ? { electronDist } : {}),
  artifactName: "arforge-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Native dependencies are pinned to their platform-specific N-API packages
  // in the workspace lockfile. Rebuilding them during packaging makes an
  // otherwise offline Windows build depend on Electron's headers CDN.
  npmRebuild: false,
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.arforge.desktop" becomes
  // "ai.arforge.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    // These ignored directories can remain on a developer machine after the
    // retired Python bridge migration. Exclude them explicitly so a stale
    // local build can never leak the old runtime back into a desktop package.
    "!resources/agent-python-dist/**/*",
    "!resources/.agent-python-build/**/*",
    // @arforge-ai/core is compiled into out/main. Leaving its TypeScript source in
    // app.asar both bloats the package and makes an accidental runtime import fail
    // with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
    "!node_modules/@arforge-ai/core/**/*",
    "!**/AGENTS.md",
  ],
  extraResources: [
    {
      from: "resources/icons/",
      to: "icons/",
    },
    ...(existsSync(nativeResources)
      ? [
          {
            from: "native/",
            to: "native/",
            filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
          },
        ]
      : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Arforge",
    schemes: ["arforge"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
    verifyUpdateCodeSignature: channel !== "dev",
    ...windowsSigning(),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Arforge Dev",
        rpm: { packageName: "arforge-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Arforge Beta",
        protocols: { name: "Arforge Beta", schemes: ["arforge"] },
        rpm: { packageName: "arforge-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Arforge",
        protocols: { name: "Arforge", schemes: ["arforge"] },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "arforge", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
