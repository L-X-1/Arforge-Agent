export type UiCapabilityDisposition = "semantic-ui" | "transport-internal" | "automation-internal" | "ui-gap"

export interface UiCapabilityReview {
  readonly id: string
  readonly disposition: UiCapabilityDisposition
  readonly methods: readonly string[]
  readonly evidence: readonly string[]
  readonly rationale: string
  readonly recommendation?: string
}

/**
 * Manual reconciliation for generated Server methods that do not have a
 * direct `operationsApi.<group>.<method>()` call in App source.
 *
 * `semantic-ui` means the same behavior is reached through the mature SDK or
 * a typed feature adapter. `ui-gap` is intentionally not treated as complete:
 * it must be agreed with the product owner before implementation.
 */
export const UI_CAPABILITY_REVIEW = [
  {
    id: "workspace-mature-surfaces",
    disposition: "semantic-ui",
    methods: [
      "files.list",
      "commands.list",
      "ptys.list",
      "ptys.create",
      "ptys.get",
      "ptys.update",
      "ptys.remove",
      "references.list",
    ],
    evidence: [
      "packages/app/src/components/file-tree.tsx",
      "packages/app/src/components/command-palette.ts",
      "packages/app/src/pages/session/terminal-panel-v2.tsx",
      "packages/app/src/components/prompt-input.tsx",
    ],
    rationale:
      "Files, commands, terminals, and references already have richer workspace surfaces through the mature SDK adapters.",
  },
  {
    id: "goal-operations-adapter",
    disposition: "semantic-ui",
    methods: [
      "goals.create",
      "goals.get",
      "goals.run",
      "goals.pause",
      "goals.resume",
      "goals.complete",
      "goals.block",
      "goals.cancel",
      "goals.replace",
      "goals.deleteQueued",
      "goals.reorder",
    ],
    evidence: ["packages/app/src/components/session/session-goal-control.tsx"],
    rationale:
      "The component binds the Goal group once as an alias and completes the revisioned lifecycle through that typed adapter.",
  },
  {
    id: "evolution-candidate-detail-transport",
    disposition: "transport-internal",
    methods: ["agentCapabilities.evolutionCandidateGet"],
    evidence: ["packages/app/src/components/control-center/evolution-workbench.tsx"],
    rationale:
      "The bounded candidate list returns the complete manifest, lifecycle state, and current evaluation used by each card; the single-candidate endpoint remains available for deep links and refresh recovery without adding a duplicate button.",
  },
  {
    id: "learning-ingestion-internal",
    disposition: "automation-internal",
    methods: ["learning.record", "learning.syncDogfood"],
    evidence: ["packages/core/src/learning.ts", "packages/core/src/feedback.ts"],
    rationale:
      "Outcome recording is part of runtime/feedback ingestion and dogfood sync is a bounded import operation; neither should be an ordinary UI button.",
  },
  {
    id: "permission-question-docks",
    disposition: "semantic-ui",
    methods: [
      "permissions.create",
      "permissions.list",
      "permissions.get",
      "permissions.reply",
      "questions.list",
      "questions.reply",
      "questions.reject",
    ],
    evidence: [
      "packages/app/src/pages/session/composer/session-permission-dock.tsx",
      "packages/app/src/pages/session/composer/session-question-dock.tsx",
      "packages/app/src/pages/session/composer/session-composer-state.ts",
    ],
    rationale:
      "Request creation/list/get are runtime settlement plumbing; users act through the visible permission and question docks.",
  },
  {
    id: "provider-model-integration-surfaces",
    disposition: "semantic-ui",
    methods: [
      "models.list",
      "providers.list",
      "providers.get",
      "integrations.get",
      "integrations.connectKey",
      "integrations.connectOauth",
      "integrations.attemptStatus",
      "integrations.attemptComplete",
    ],
    evidence: [
      "packages/app/src/components/dialog-connect-provider.tsx",
      "packages/app/src/components/settings-v2/providers.tsx",
      "packages/app/src/components/settings-v2/models.tsx",
    ],
    rationale:
      "The provider dialog uses the compatible singular integration adapter and settings/model selectors expose the same lifecycle.",
  },
  {
    id: "session-mature-surfaces",
    disposition: "semantic-ui",
    methods: [
      "sessions.list",
      "sessions.create",
      "sessions.switchAgent",
      "sessions.switchModel",
      "sessions.compact",
      "sessions.interrupt",
      "sessions.message",
    ],
    evidence: [
      "packages/app/src/pages/home/home-sessions-controller.tsx",
      "packages/app/src/components/prompt-input/submit.ts",
      "packages/app/src/pages/session/use-session-commands.tsx",
      "packages/app/src/pages/session.tsx",
    ],
    rationale:
      "These lifecycle operations are already exposed by the home index, composer, model/agent selectors, command palette, and stop control.",
  },
  {
    id: "mcp-runtime-surfaces",
    disposition: "semantic-ui",
    methods: ["mcp.list", "mcp.resourceCatalog"],
    evidence: [
      "packages/app/src/context/server-sync.tsx",
      "packages/app/src/components/status-popover-body.tsx",
      "packages/app/src/components/prompt-input.tsx",
    ],
    rationale: "MCP status is shown in the status surface and resources are loaded into the composer reference picker.",
  },
] as const satisfies readonly UiCapabilityReview[]

export const reviewedUiCapabilityMethods = () => UI_CAPABILITY_REVIEW.flatMap((entry) => [...entry.methods])
