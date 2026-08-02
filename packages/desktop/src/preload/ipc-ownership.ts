export type DesktopIpcSurface =
  | "desktop-bootstrap"
  | "desktop-settings"
  | "desktop-storage"
  | "desktop-files-and-shell"
  | "desktop-window"
  | "desktop-diagnostics"
  | "desktop-updater"
  | "desktop-wsl"
  | "desktop-events"

export interface DesktopIpcOwnership {
  readonly feature: string
  readonly surface: DesktopIpcSurface
  readonly channels: readonly string[]
  readonly rationale: string
}

/**
 * Scheme B ownership contract for the sandboxed Electron renderer bridge.
 *
 * IPC is a host capability boundary, not a second application API. Every
 * registered channel is grouped by the user-semantic Desktop feature it
 * supports, while transport subscriptions remain inside their owning feature.
 */
export const DESKTOP_IPC_OWNERSHIP = [
  {
    feature: "sidecar-and-first-launch-bootstrap",
    surface: "desktop-bootstrap",
    channels: [
      "kill-sidecar",
      "await-initialization",
      "consume-initial-deep-links",
      "is-first-launch-onboarding-pending",
      "finish-first-launch-onboarding",
      "is-old-layout-eligible",
    ],
    rationale: "The Desktop host starts the local Server, restores launch state, and gates first-launch onboarding.",
  },
  {
    feature: "desktop-server-and-rendering-settings",
    surface: "desktop-settings",
    channels: [
      "get-default-server-url",
      "set-default-server-url",
      "get-display-backend",
      "get-rendering-mode",
      "set-display-backend",
      "parse-markdown",
      "check-app-exists",
      "resolve-app-path",
    ],
    rationale: "These calls adapt OS/server preferences for the shared application settings and renderer.",
  },
  {
    feature: "durable-renderer-storage",
    surface: "desktop-storage",
    channels: ["store-get", "store-set", "store-delete", "store-clear", "store-keys", "store-length"],
    rationale: "The preload exposes bounded key/value persistence because the sandboxed renderer cannot access files directly.",
  },
  {
    feature: "files-attachments-clipboard-and-shell",
    surface: "desktop-files-and-shell",
    channels: [
      "open-directory-picker",
      "open-file-picker",
      "read-picked-file",
      "release-picked-files",
      "save-file-picker",
      "open-link",
      "open-path",
      "reveal-path",
      "read-clipboard-image",
      "show-notification",
    ],
    rationale: "Native dialogs and shell/clipboard access remain behind explicit Desktop host mediation.",
  },
  {
    feature: "window-menu-focus-and-zoom",
    surface: "desktop-window",
    channels: [
      "get-window-count",
      "get-window-id",
      "get-window-focused",
      "set-window-focus",
      "show-window",
      "relaunch",
      "get-zoom-factor",
      "set-zoom-factor",
      "get-pinch-zoom-enabled",
      "set-pinch-zoom-enabled",
      "set-titlebar",
      "run-desktop-menu-action",
      "set-background-color",
      "menu-command",
      "pinch-zoom-enabled-changed",
      "zoom-factor-changed",
    ],
    rationale: "Window state and native menu/zoom events are Desktop-only presentation responsibilities.",
  },
  {
    feature: "desktop-diagnostics",
    surface: "desktop-diagnostics",
    channels: ["export-debug-logs", "set-force-focus", "record-fatal-renderer-error"],
    rationale: "Crash evidence and debug focus controls are owned by the Desktop host and exposed through diagnostics.",
  },
  {
    feature: "desktop-updater",
    surface: "desktop-updater",
    channels: [
      "updater-subscribe",
      "updater-unsubscribe",
      "updater-check",
      "updater-install",
      "updater-state",
    ],
    rationale: "Update state and installation require the native application lifecycle.",
  },
  {
    feature: "wsl-server-management",
    surface: "desktop-wsl",
    channels: [
      "wsl-servers-get-state",
      "wsl-servers-subscribe",
      "wsl-servers-unsubscribe",
      "wsl-servers-probe-runtime",
      "wsl-servers-refresh-distros",
      "wsl-servers-install-wsl",
      "wsl-servers-install-distro",
      "wsl-servers-probe-addable",
      "wsl-servers-install-arforge",
      "wsl-servers-open-terminal",
      "wsl-servers-add",
      "wsl-servers-remove",
      "wsl-servers-start",
      "wsl-servers-event",
    ],
    rationale: "WSL discovery, installation, and remote Server lifecycle are a Windows Desktop feature.",
  },
  {
    feature: "deep-link-delivery",
    surface: "desktop-events",
    channels: ["deep-link"],
    rationale: "Protocol links are queued by the native host and delivered to the shared application router.",
  },
] as const satisfies readonly DesktopIpcOwnership[]

/**
 * This preload residue has no main-process implementation and no reachable
 * product entry point. A packaged CLI artifact also is not shipped today, so
 * silently inventing an installer would be unsafe. Keep it explicit until the
 * product decision is made to package a CLI or remove the obsolete residue.
 */
export const KNOWN_ORPHANED_PRELOAD_CHANNELS = ["install-cli"] as const

export const desktopIpcChannels = () => DESKTOP_IPC_OWNERSHIP.flatMap((entry) => [...entry.channels])

export const desktopIpcOwnership = (channel: string) =>
  DESKTOP_IPC_OWNERSHIP.find((entry) => entry.channels.some((candidate) => candidate === channel))
