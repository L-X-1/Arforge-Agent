import { MANAGEMENT_METHODS, READ_ONLY_METHODS } from "./protocol"

export type OwnershipCoverage = "exact-api" | "semantic-replacement"

export interface NativeVertical {
  readonly id: string
  readonly coverage: OwnershipCoverage
  readonly methods: readonly string[]
  readonly evidence: readonly string[]
  readonly rationale: string
}

export const NATIVE_VERTICALS = [
  {
    id: "session-lifecycle",
    coverage: "exact-api",
    methods: [
      "project.list",
      "session.create",
      "session.fork",
      "session.get",
      "session.rename",
      "session.tags.update",
      "session.list",
      "session.messages",
      "session.export",
      "session.import",
      "session.context.import",
      "session.compact",
      "session.archive",
      "session.resume",
      "session.close",
      "session.checkpoint.create",
      "session.checkpoint.list",
      "session.rewind.preview",
      "session.rewind.apply",
    ],
    evidence: [
      "packages/core/src/session",
      "packages/app/src/components/session/session-operations-dialog.tsx",
      "packages/client/src/generated/client.ts",
    ],
    rationale: "Core owns the session aggregate and the generated Server client exposes the durable lifecycle directly.",
  },
  {
    id: "schedule-trigger-wait-team",
    coverage: "exact-api",
    methods: [
      "schedule.create",
      "schedule.list",
      "schedule.delete",
      "schedule.run_missed",
      "trigger.profiles",
      "trigger.list",
      "trigger.get",
      "trigger.create",
      "trigger.update",
      "trigger.run",
      "wait.active",
      "wait.wake",
      "team.create",
      "team.get",
      "team.delete",
      "team.member.add",
      "team.member.remove",
      "team.message.send",
      "team.message.list",
      "team.shutdown.request",
    ],
    evidence: [
      "packages/core/src/scheduled-prompt.ts",
      "packages/core/src/trigger.ts",
      "packages/core/src/cooperative-wait.ts",
      "packages/core/src/team.ts",
      "packages/app/src/components/session/session-operations-dialog.tsx",
    ],
    rationale: "These session-owned durable services have direct Core, HTTP client, and Desktop operations.",
  },
  {
    id: "chat-operation-history",
    coverage: "semantic-replacement",
    methods: [
      "chat.start",
      "chat.resume",
      "chat.enqueue",
      "chat.queue.list",
      "chat.queue.delete",
      "chat.side.ask",
      "chat.side.get",
      "chat.side.list",
      "chat.side.cancel",
      "chat.steer",
      "chat.cancel",
      "operation.get",
      "history.search",
    ],
    evidence: [
      "packages/core/src/session",
      "packages/core/src/background-job.ts",
      "packages/app/src/pages/session.tsx",
    ],
    rationale:
      "The mature Session runner, prompt queue, side conversations, interrupt path, and searchable session index replace the old Bridge command names.",
  },
  {
    id: "question",
    coverage: "exact-api",
    methods: ["question.get", "question.respond", "question.reject"],
    evidence: ["packages/core/src/question.ts", "packages/app/src/pages/session/composer/session-question-dock.tsx"],
    rationale: "Question is a typed Core service with direct UI settlement.",
  },
  {
    id: "approval-diff-tool-file",
    coverage: "semantic-replacement",
    methods: [
      "action.list",
      "file.history",
      "approval.get",
      "approval.respond",
      "diff.preview",
      "diff.get",
      "diff.reject",
      "diff.apply",
      "diff.rollback",
      "tool.prepare",
      "tool.get",
      "tool.reject",
      "tool.execute",
      "tool.execute_async",
      "file.write.preview",
      "file.write.get",
      "file.write.reject",
      "file.write.apply",
    ],
    evidence: [
      "packages/core/src/permission.ts",
      "packages/core/src/snapshot.ts",
      "packages/core/src/tool",
      "packages/core/src/file-mutation.ts",
    ],
    rationale:
      "Permission, Snapshot, Tool, and FileMutation enforce the same approval and rollback boundaries without retaining the legacy action store.",
  },
  {
    id: "task-graph",
    coverage: "exact-api",
    methods: ["task.get", "task.list", "task.cancel", "task.retry"],
    evidence: ["packages/core/src/task-graph.ts", "packages/app/src/components/session/session-operations-dialog.tsx"],
    rationale: "The revisioned durable task graph replaces the old task registry and adds dependency and claim invariants.",
  },
  {
    id: "goal",
    coverage: "exact-api",
    methods: [
      "goal.create",
      "goal.list",
      "goal.get",
      "goal.run",
      "goal.pause",
      "goal.resume",
      "goal.replace",
      "goal.cancel",
      "goal.delete",
      "goal.reorder",
    ],
    evidence: ["packages/core/src/goal.ts", "packages/app/src/components/session/session-goal-control.tsx"],
    rationale: "Goal is a revisioned session-owned aggregate with queue and lifecycle APIs.",
  },
  {
    id: "feedback-memory-learning",
    coverage: "exact-api",
    methods: [
      "feedback.summary",
      "feedback.list",
      "feedback.submit",
      "feedback.delete",
      "learning.undo",
      "learning.dogfood_sync",
      "memory.delete",
      "memory.bulk_delete",
      "memory.update",
      "memory.governance.apply",
    ],
    evidence: [
      "packages/core/src/feedback.ts",
      "packages/core/src/learning.ts",
      "packages/core/src/memory.ts",
      "packages/app/src/components/session/session-operations-dialog.tsx",
    ],
    rationale: "The unified Core persists and governs these records under workspace/global scopes.",
  },
  {
    id: "settings-presentation-model",
    coverage: "semantic-replacement",
    methods: [
      "logs.query",
      "settings.get",
      "settings.update",
      "keybindings.get",
      "keybindings.update",
      "keybindings.reset",
      "features.set",
      "features.clear",
      "features.refresh",
      "permissions.mode.set",
      "permissions.rule.add",
      "permissions.rule.revoke",
      "model_config.list",
      "model_config.active",
      "model_config.set_key",
      "model_config.delete_key",
      "model_config.set_active",
      "model_config.set_model",
      "model_config.set_context_window",
      "model_config.set_base_url",
      "model_config.set_label",
      "output_styles.list",
      "output_styles.read",
      "output_styles.set",
      "output_styles.clear",
      "themes.list",
      "custom_agents.list",
    ],
    evidence: [
      "packages/app/src/context/settings.tsx",
      "packages/app/src/components/settings-keybinds.tsx",
      "packages/core/src/model.ts",
      "packages/ui/src",
    ],
    rationale:
      "The mature settings, provider/model registry, keybinding, theme, and agent configuration replace the legacy profile-specific command vocabulary.",
  },
  {
    id: "run-recovery",
    coverage: "exact-api",
    methods: ["run.revert", "run.trace.import"],
    evidence: ["packages/core/src/session/revert.ts", "packages/app/src/components/session/session-run-history.tsx"],
    rationale: "Session revert and run trace recovery are exposed through the unified session boundary.",
  },
  {
    id: "git-worktree",
    coverage: "exact-api",
    methods: ["git.checkout", "git.worktree.create", "git.worktree.prepare_remove", "git.worktree.remove"],
    evidence: ["packages/arforge/src/git", "packages/arforge/src/worktree"],
    rationale: "The mature Git and managed worktree services own these workspace mutations.",
  },
] as const satisfies readonly NativeVertical[]

export interface SemanticUiGate {
  readonly vertical: string
  readonly methods: readonly string[]
  readonly surfaces: readonly {
    readonly file: string
    readonly markers: readonly string[]
  }[]
}

const vertical = (id: string) => {
  const found = NATIVE_VERTICALS.find((item) => item.id === id)
  if (!found) throw new Error(`Missing native vertical ${id}`)
  return found
}

export const SEMANTIC_UI_GATES = [
  {
    vertical: "chat-operation-history",
    methods: vertical("chat-operation-history").methods,
    surfaces: [
      {
        file: "packages/app/src/pages/session.tsx",
        markers: ["operationsApi.sessions.prompt", "followupQueueQuery", ".api.session.interrupt", "SessionSidePanel"],
      },
      {
        file: "packages/app/src/pages/session/use-session-commands.tsx",
        markers: ['id: "session.new"', 'id: "session.compact"', 'id: "session.fork"'],
      },
      {
        file: "packages/app/src/pages/home/home-session-search-controller.ts",
        markers: ['command.register("home.search"'],
      },
    ],
  },
  {
    vertical: "approval-diff-tool-file",
    methods: vertical("approval-diff-tool-file").methods,
    surfaces: [
      {
        file: "packages/app/src/pages/session/use-session-commands.tsx",
        markers: ['id: "review.toggle"', 'id: "permissions.autoaccept"'],
      },
      {
        file: "packages/app/src/pages/session/composer/session-composer-region.tsx",
        markers: ["SessionPermissionDock"],
      },
      {
        file: "packages/session-ui/src/components/message-part.tsx",
        markers: ["part.tool", "ToolPart"],
      },
      {
        file: "packages/session-ui/src/components/session-review.tsx",
        markers: ['data-component="session-review"', "DiffChanges"],
      },
    ],
  },
  {
    vertical: "settings-presentation-model",
    methods: vertical("settings-presentation-model").methods,
    surfaces: [
      {
        file: "packages/app/src/components/settings-dialog.tsx",
        markers: ['id: "settings.open"'],
      },
      {
        file: "packages/app/src/pages/session/use-composer-commands.tsx",
        markers: ['id: "model.choose"', 'id: "agent.cycle"'],
      },
      {
        file: "packages/app/src/pages/layout.tsx",
        markers: ['id: "theme.cycle"', 'id: "theme.scheme.cycle"'],
      },
      {
        file: "packages/app/src/app.tsx",
        markers: ['id: "logs.export"'],
      },
      {
        file: "packages/app/src/components/settings-keybinds.tsx",
        markers: ["Keybind"],
      },
      {
        file: "packages/app/src/components/settings-v2/models.tsx",
        markers: ["Models"],
      },
      {
        file: "packages/app/src/components/settings-v2/providers.tsx",
        markers: ["Providers"],
      },
    ],
  },
] as const satisfies readonly SemanticUiGate[]

export type LegacyOwnership =
  | {
      readonly mode: "python-capability"
      readonly coverage: "exact-api"
      readonly vertical: "python-capability"
      readonly evidence: readonly string[]
    }
  | {
      readonly mode: "typescript-native"
      readonly coverage: OwnershipCoverage
      readonly vertical: string
      readonly evidence: readonly string[]
    }

const native = new Map<string, LegacyOwnership>()
for (const vertical of NATIVE_VERTICALS) {
  for (const method of vertical.methods) {
    if (native.has(method)) throw new Error(`Duplicate native ownership for ${method}`)
    native.set(method, {
      mode: "typescript-native",
      coverage: vertical.coverage,
      vertical: vertical.id,
      evidence: vertical.evidence,
    })
  }
}

const capability = new Set<string>([...READ_ONLY_METHODS, ...MANAGEMENT_METHODS])

export function legacyOwnership(method: string): LegacyOwnership | undefined {
  if (capability.has(method)) {
    return {
      mode: "python-capability",
      coverage: "exact-api",
      vertical: "python-capability",
      evidence: [
        "packages/agent-python/src/protocol.ts",
        "packages/server/src/handlers/agent-capability.ts",
      ],
    }
  }
  return native.get(method)
}

export const NATIVE_METHOD_COUNT = native.size
export const CAPABILITY_METHOD_COUNT = capability.size
