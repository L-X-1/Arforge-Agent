export type LegacyHttpSurface =
  | "desktop-user-surface"
  | "cli-user-surface"
  | "typed-api-replacement"
  | "transport-internal"
  | "host-lifecycle"

export type LegacyHttpRisk = "read" | "write" | "confirm" | "internal"

export interface LegacyHttpOwnership {
  readonly feature: string
  readonly surface: LegacyHttpSurface
  readonly risk: LegacyHttpRisk
  readonly operations: readonly string[]
  readonly evidence: readonly string[]
  readonly rationale: string
}

/**
 * Scheme B ownership contract for the compatibility SDK HTTP surface.
 *
 * These operations remain public because the mature Desktop/CLI clients still
 * consume them. They must not be duplicated as one-button-per-route controls:
 * every operation is assigned to a user-semantic surface, a stronger typed API
 * replacement, or an explicitly private transport/lifecycle boundary.
 */
export const LEGACY_HTTP_FRONTEND_OWNERSHIP = [
  {
    feature: "provider-credentials-and-settings",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "auth.set",
      "auth.remove",
      "config.get",
      "config.update",
      "config.providers",
      "global.config.get",
      "global.config.update",
      "provider.list",
      "provider.auth",
      "provider.oauth.authorize",
    ],
    evidence: [
      "packages/app/src/components/settings-dialog.tsx",
      "packages/app/src/components/settings-v2/providers.tsx",
      "packages/app/src/context/global.tsx",
    ],
    rationale:
      "Provider discovery, credentials, and product configuration belong to the existing Settings and integration flow.",
  },
  {
    feature: "provider-oauth-callback",
    surface: "transport-internal",
    risk: "internal",
    operations: ["provider.oauth.callback"],
    evidence: ["packages/app/src/components/settings-v2/providers.tsx"],
    rationale: "The callback completes a user-started OAuth flow and is not an independent control.",
  },
  {
    feature: "server-observability-and-lifecycle",
    surface: "host-lifecycle",
    risk: "internal",
    operations: [
      "app.log",
      "global.health",
      "global.event",
      "global.dispose",
      "global.upgrade",
      "event.subscribe",
      "instance.dispose",
    ],
    evidence: [
      "packages/app/src/context/global.tsx",
      "packages/app/src/context/sync.tsx",
      "packages/desktop/src/main/server.ts",
    ],
    rationale:
      "Health, event streams, log forwarding, disposal, and host upgrades are lifecycle plumbing owned by the app host.",
  },
  {
    feature: "workspace-files-and-search",
    surface: "desktop-user-surface",
    risk: "read",
    operations: ["find.text", "find.files", "find.symbols", "file.list", "file.read", "file.status"],
    evidence: [
      "packages/app/src/components/file-tree.tsx",
      "packages/app/src/components/directory-picker-domain.ts",
      "packages/app/src/context/file.tsx",
    ],
    rationale: "File browsing, content, status, and search are the workspace surface rather than control-center buttons.",
  },
  {
    feature: "workspace-runtime-and-vcs",
    surface: "desktop-user-surface",
    risk: "write",
    operations: [
      "path.get",
      "vcs.get",
      "vcs.status",
      "vcs.diff",
      "vcs.diff.raw",
      "vcs.apply",
      "command.list",
      "app.agents",
      "app.skills",
      "lsp.status",
      "formatter.status",
    ],
    evidence: [
      "packages/app/src/pages/session.tsx",
      "packages/app/src/pages/session/use-session-commands.tsx",
      "packages/app/src/components/status-popover-body.tsx",
    ],
    rationale:
      "Commands, agents, skills, language tooling, formatting, and VCS state are contextual workspace/session capabilities.",
  },
  {
    feature: "project-and-workspace-management",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "experimental.controlPlane.moveSession",
      "project.list",
      "project.current",
      "project.initGit",
      "project.update",
      "project.directories",
      "experimental.workspace.adapter.list",
      "experimental.workspace.list",
      "experimental.workspace.create",
      "experimental.workspace.syncList",
      "experimental.workspace.status",
      "experimental.workspace.remove",
      "experimental.workspace.warp",
    ],
    evidence: [
      "packages/app/src/pages/home.tsx",
      "packages/app/src/components/edit-project.ts",
      "packages/app/src/components/dialog-select-directory-v2.tsx",
    ],
    rationale:
      "Project metadata, workspace adapters, creation, removal, and session moves are owned by Home and project management.",
  },
  {
    feature: "project-copy-typed-replacement",
    surface: "typed-api-replacement",
    risk: "confirm",
    operations: [
      "experimental.projectCopy.generateName",
      "v2.projectCopy.list",
      "v2.projectCopy.create",
      "v2.projectCopy.remove",
      "v2.projectCopy.refresh",
    ],
    evidence: [
      "packages/app/src/components/control-center/dialog-control-center.tsx",
      "packages/app/src/capabilities/control-center-map.ts",
    ],
    rationale: "The global control center uses the stronger typed projectCopies API and keeps this SDK surface for compatibility.",
  },
  {
    feature: "mcp-connections",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "mcp.status",
      "mcp.add",
      "mcp.auth.start",
      "mcp.auth.remove",
      "mcp.auth.callback",
      "mcp.auth.authenticate",
      "mcp.connect",
      "mcp.disconnect",
    ],
    evidence: [
      "packages/app/src/components/dialog-select-mcp.tsx",
      "packages/app/src/components/control-center/dialog-control-center.tsx",
    ],
    rationale: "MCP connection and authorization lifecycle belongs to extension settings and the Scheme B extension center.",
  },
  {
    feature: "permission-and-question-settlement",
    surface: "desktop-user-surface",
    risk: "write",
    operations: [
      "permission.list",
      "permission.reply",
      "question.list",
      "question.reply",
      "question.reject",
    ],
    evidence: [
      "packages/app/src/pages/session/composer/session-question-dock.tsx",
      "packages/app/src/pages/session/composer/session-composer-region.tsx",
    ],
    rationale: "Pending permissions and questions are settled in the active session, where their context is visible.",
  },
  {
    feature: "terminal",
    surface: "desktop-user-surface",
    risk: "write",
    operations: [
      "pty.shells",
      "pty.list",
      "pty.create",
      "pty.get",
      "pty.update",
      "pty.remove",
      "pty.connectToken",
      "pty.connect",
    ],
    evidence: [
      "packages/app/src/components/terminal.tsx",
      "packages/app/src/context/terminal.tsx",
    ],
    rationale: "PTY discovery, lifecycle, tokens, and streams form the terminal surface.",
  },
  {
    feature: "session-chat-and-recovery",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "session.list",
      "session.create",
      "session.status",
      "session.get",
      "session.update",
      "session.delete",
      "session.children",
      "session.todo",
      "session.diff",
      "session.messages",
      "session.prompt",
      "session.message",
      "session.deleteMessage",
      "session.fork",
      "session.abort",
      "session.init",
      "session.share",
      "session.unshare",
      "session.summarize",
      "session.prompt_async",
      "session.command",
      "session.shell",
      "session.revert",
      "session.unrevert",
      "permission.respond",
      "part.update",
      "part.delete",
    ],
    evidence: [
      "packages/app/src/pages/session.tsx",
      "packages/app/src/pages/session/use-session-commands.tsx",
      "packages/session-ui/src/components/session-review.tsx",
    ],
    rationale: "Chat, message parts, child sessions, diffs, abort, summarize, and recovery are one session-owned experience.",
  },
  {
    feature: "experimental-worktree-and-session",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "worktree.list",
      "worktree.create",
      "worktree.remove",
      "worktree.reset",
      "experimental.session.list",
      "experimental.session.background",
    ],
    evidence: [
      "packages/app/src/pages/home/home-sessions-controller.tsx",
      "packages/app/src/context/global.tsx",
    ],
    rationale: "Managed worktrees and background sessions support the existing Home/session workflow.",
  },
  {
    feature: "experimental-provider-console",
    surface: "desktop-user-surface",
    risk: "confirm",
    operations: [
      "experimental.console.get",
      "experimental.console.listOrgs",
      "experimental.console.switchOrg",
    ],
    evidence: ["packages/app/src/components/settings-v2/providers.tsx"],
    rationale:
      "Provider organization selection remains contextual to provider settings; it must not become a generic control-center action.",
  },
  {
    feature: "runtime-capability-introspection",
    surface: "transport-internal",
    risk: "internal",
    operations: [
      "experimental.capabilities.get",
      "tool.list",
      "tool.ids",
      "experimental.resource.list",
    ],
    evidence: [
      "packages/app/src/context/global.tsx",
      "packages/app/src/context/sync.tsx",
    ],
    rationale: "Capability, tool, and resource catalogs hydrate runtime state and are not directly executable actions.",
  },
  {
    feature: "multi-client-state-synchronization",
    surface: "transport-internal",
    risk: "internal",
    operations: ["sync.start", "sync.replay", "sync.steal", "sync.history.list"],
    evidence: ["packages/app/src/context/sync.tsx"],
    rationale: "Sync leases, replay, and history are consistency primitives underneath user-visible session state.",
  },
  {
    feature: "cli-tui-control",
    surface: "cli-user-surface",
    risk: "write",
    operations: [
      "tui.appendPrompt",
      "tui.openHelp",
      "tui.openSessions",
      "tui.openThemes",
      "tui.openModels",
      "tui.submitPrompt",
      "tui.clearPrompt",
      "tui.executeCommand",
      "tui.showToast",
      "tui.publish",
      "tui.selectSession",
      "tui.control.next",
      "tui.control.response",
    ],
    evidence: [
      "packages/tui/src",
      "packages/arforge/src/server/shared/tui-control.ts",
    ],
    rationale: "These routes are the CLI/TUI frontend control channel and should never be duplicated in Desktop.",
  },
] as const satisfies readonly LegacyHttpOwnership[]

export const legacyHttpOperations = () =>
  LEGACY_HTTP_FRONTEND_OWNERSHIP.flatMap((entry) => [...entry.operations])

export const legacyHttpOwnership = (operation: string) =>
  LEGACY_HTTP_FRONTEND_OWNERSHIP.find((entry) =>
    entry.operations.some((candidate) => candidate === operation),
  )
