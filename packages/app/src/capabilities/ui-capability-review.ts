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
    id: "memory-candidate-review-adapter",
    disposition: "semantic-ui",
    methods: [
      "memories.candidateReview",
      "memories.candidateApprove",
      "memories.candidateReject",
      "memories.candidateActivate",
    ],
    evidence: [
      "packages/app/src/components/control-center/personal-workspace.tsx",
      "packages/app/src/components/control-center/memory-candidate-review.tsx",
      "packages/app/src/utils/memory-candidate-api.ts",
    ],
    rationale:
      "The Personal Workspace exposes candidate inspection and the approve, reject, and activate lifecycle through a scoped typed adapter with decision reasons, optimistic concurrency, redaction, and audit history.",
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
    id: "skill-lifecycle-observation-ingestion-internal",
    disposition: "automation-internal",
    methods: ["agentCapabilities.skillLifecycleCanaryObservation"],
    evidence: ["packages/server/src/handlers/agent-capability.ts", "packages/core/src/skill-lifecycle.ts"],
    rationale:
      "Candidate creation from explicitly selected verified Experience is exposed by the Control Center workbench. Canary observations remain automation-owned because they ingest runtime evidence rather than represent an ordinary user action.",
  },
  {
    id: "personal-job-dynamic-actions",
    disposition: "semantic-ui",
    methods: [
      "personalJobs.get",
      "personalJobs.approve",
      "personalJobs.reject",
      "personalJobs.start",
      "personalJobs.execute",
      "personalJobs.pause",
      "personalJobs.resume",
      "personalJobs.cancel",
      "personalJobs.notifications",
    ],
    evidence: ["packages/app/src/components/session/session-personal-jobs-control.tsx"],
    rationale:
      "The Personal Jobs control binds dynamic lifecycle actions through a typed group alias; the static capability scan cannot see every action name, but the visible session UI does.",
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
  {
    id: "mcp-action-reconciliation-maintenance",
    disposition: "transport-internal",
    methods: ["mcp.actionReconciliation", "mcp.recordReconciliation"],
    evidence: ["packages/arforge/src/server/routes/instance/httpapi/handlers/mcp-v2.ts"],
    rationale:
      "Reconciliation lookup and explicit evidence write-back are maintainer operations until the desktop can show a fresh, identity-bound confirmation card; exposing a generic button would imply automatic retry authority.",
  },
  {
    id: "artifact-byte-read-adapters",
    disposition: "transport-internal",
    methods: ["artifacts.read", "artifacts.readRange", "artifacts.readScoped", "artifacts.readScopedRange"],
    evidence: ["packages/client/test/promise.test.ts", "packages/client/test/effect.test.ts"],
    rationale:
      "Opaque artifact bytes stay behind authenticated, bounded SDK reads; the Control Center deliberately shows metadata and audit evidence instead of exposing paths or content through a generic button.",
  },
  {
    id: "subagent-status-aggregation",
    disposition: "semantic-ui",
    methods: ["subagentControl.status"],
    evidence: ["packages/app/src/components/control-center/personal-workspace.tsx"],
    rationale:
      "The Personal Workspace renders the child status returned by the parent-scoped children/control adapter; a second status request would duplicate the same child state owner.",
  },
  {
    id: "mcp-capability-discovery-internal",
    disposition: "transport-internal",
    methods: ["mcp.capabilities"],
    evidence: ["packages/arforge/src/server/routes/instance/httpapi/handlers/mcp-v2.ts"],
    rationale:
      "MCP capability discovery feeds CLI and transport diagnostics; the desktop status surface consumes the richer server-sync projection and does not expose a duplicate raw capability endpoint.",
  },
] as const satisfies readonly UiCapabilityReview[]

export const reviewedUiCapabilityMethods = () => UI_CAPABILITY_REVIEW.flatMap((entry) => [...entry.methods])
