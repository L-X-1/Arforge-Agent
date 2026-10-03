import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

// `deriveSubagentSessionPermission` is imported from production. The test
// exercises the actual helper that task.ts uses to build the subagent's
// session permission, so any regression in that helper trips this test.

it.instance("subagent permissions take precedence over parent agent restrictions", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    const generalAgent = yield* Agent.use.get("general")

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    const parentSessionPermission: PermissionV1.Ruleset = []

    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: generalAgent!,
    })

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).not.toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.instance("subagent's own read-only restriction remains effective", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.use.get("explore")
    expect(explore).toBeDefined()

    const parentSessionPermission: PermissionV1.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
  }),
)

it.instance(
  "custom subagent can explicitly enable edits denied to its parent agent",
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.use.get("plan")
      const my = yield* Agent.use.get("my_subagent")
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: PermissionV1.Ruleset = []
      const subagentSessionPermission = deriveSubagentSessionPermission({
        parentSessionPermission,
        subagent: my!,
      })
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("allow")
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
          permission: {
            edit: "allow",
          },
        },
      },
    },
  },
)

it.effect("subagent self permissions are preserved", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        bash: "allow",
        task: {
          "*": "deny",
          worker: "allow",
        },
        edit: "allow",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.effect("subagent inherits parent session deny rules as hard runtime ceilings", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "allow",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ bash: "deny" }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
  }),
)

it.effect("explicit child capabilities become a fail-closed permission allow-list", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: { "*": "allow" },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent: executor,
        capabilities: [
          {
            action: "edit",
            resources: ["workspace"],
            access: "write",
          } satisfies AgentRuntime.ChildCapability,
        ],
      }),
    )

    expect(Permission.evaluate("edit", "src/a.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("read", "src/a.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("deny")

    const externalGrant = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "external_directory", pattern: "*", action: "allow" }],
        subagent: executor,
        capabilities: [
          {
            action: "edit",
            resources: ["workspace"],
            access: "write",
          } satisfies AgentRuntime.ChildCapability,
        ],
      }),
    )
    expect(Permission.evaluate("external_directory", "C:/outside", externalGrant).action).toBe("deny")
  }),
)

it.effect("subagent capability grants cannot bypass a profile's own hard tool ceiling", () =>
  Effect.sync(() => {
    const readOnlyProfile = testAgent({
      name: "CustomAgent.reviewer",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        grep: "allow",
      },
    })
    const effective = Permission.merge(
      readOnlyProfile.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ "*": "allow" }),
        subagent: readOnlyProfile,
        capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
      }),
    )

    expect(Permission.evaluate("edit", "src/index.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("read", "src/index.ts", effective).action).toBe("deny")
  }),
)

it.effect("explicit child capabilities preserve parent ask as a hard ceiling", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: { "*": "allow" },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({
          "*": "allow",
          edit: "ask",
          external_directory: "ask",
        }),
        subagent: executor,
        capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
      }),
    )

    expect(Permission.evaluate("edit", "src/a.ts", effective).action).toBe("ask")
    expect(Permission.evaluate("read", "src/a.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("external_directory", "C:/outside", effective).action).toBe("deny")
  }),
)

it.effect("a narrower parent allow cannot widen a different child resource scope", () =>
  Effect.sync(() => {
    const executor = testAgent({ name: "executor", mode: "subagent", permission: { "*": "allow" } })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({
          "*": "deny",
          read: { "src/safe/*": "allow" },
        }),
        subagent: executor,
        capabilities: [{ action: "read", resources: ["src/other/*"], access: "read" }],
      }),
    )

    expect(Permission.evaluate("read", "src/other/file.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("read", "src/safe/file.ts", effective).action).toBe("deny")
  }),
)
