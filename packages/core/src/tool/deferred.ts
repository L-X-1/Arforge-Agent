export * as DeferredTools from "./deferred"

import { Context, Effect, Layer } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"

const Immediate = new Set([
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "goal_update",
  "deliver_user_message",
  "grep",
  "question",
  "read",
  "skill",
  "todowrite",
  "create_task",
  "list_tasks",
  "notebook_read",
  "notebook_edit",
  "search_tasks",
  "update_task",
  "claim_task",
  "complete_task",
  "delete_task",
  "team_message_send",
  "team_message_list",
  "team_shutdown_respond",
  "tool_search",
  "write",
])

export interface Interface {
  readonly enabled: () => boolean
  readonly configure: (enabled: boolean) => Effect.Effect<void>
  readonly setPermissions: (sessionID: SessionSchema.ID, rules: PermissionV2.Ruleset) => Effect.Effect<void>
  readonly permissions: (sessionID: SessionSchema.ID) => PermissionV2.Ruleset
  readonly visible: (sessionID: SessionSchema.ID | undefined, name: string) => boolean
  readonly activate: (sessionID: SessionSchema.ID, names: ReadonlyArray<string>) => Effect.Effect<void>
  readonly withinRun: <A, E, R>(
    sessionID: SessionSchema.ID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/DeferredTools") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let enabled = false
    const selected = new Map<SessionSchema.ID, Set<string>>()
    const permissions = new Map<SessionSchema.ID, PermissionV2.Ruleset>()
    const withinRun: Interface["withinRun"] = (sessionID, effect) =>
      Effect.sync(() => {
        selected.delete(sessionID)
        permissions.delete(sessionID)
      }).pipe(
        Effect.andThen(effect),
        Effect.ensuring(
          Effect.sync(() => {
            selected.delete(sessionID)
            permissions.delete(sessionID)
          }),
        ),
      )

    return Service.of({
      enabled: () => enabled,
      configure: (value) =>
        Effect.sync(() => {
          enabled = value
          if (!value) {
            selected.clear()
            permissions.clear()
          }
        }),
      setPermissions: (sessionID, rules) =>
        Effect.sync(() => {
          permissions.set(sessionID, rules)
        }),
      permissions: (sessionID) => permissions.get(sessionID) ?? [],
      visible: (sessionID, name) =>
        !enabled || Immediate.has(name) || (sessionID ? (selected.get(sessionID)?.has(name) ?? false) : false),
      activate: (sessionID, names) =>
        Effect.sync(() => {
          const active = selected.get(sessionID) ?? new Set<string>()
          names.forEach((name) => active.add(name))
          selected.set(sessionID, active)
        }),
      withinRun,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })

const configLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const deferred = yield* Service
    const config = yield* Config.Service
    yield* deferred.configure(Config.latest(yield* config.entries(), "experimental")?.deferred_tools === true)
  }),
)

export const configNode = makeLocationNode({
  name: "deferred-tools-config",
  layer: configLayer,
  deps: [node, Config.node],
})
