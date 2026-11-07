import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Context, DateTime, Effect, Equal, Exit, Hash, Layer, Option, RcMap, Schema, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Tool } from "@arforge-ai/core/tool/tool"
import { define } from "@arforge-ai/plugin/v2/effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Catalog } from "@arforge-ai/core/catalog"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PluginV2 } from "@arforge-ai/core/plugin"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { AbsolutePath, RelativePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { WorkspaceV2 } from "@arforge-ai/core/workspace"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { FileSystem } from "../src/filesystem"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("LocationServiceMap", () => {
  it.live("reused acquisition effects resolve the current cache generation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) => Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const ref = Location.Ref.make({ directory: AbsolutePath.make(path.join(dir.path, "restored")) })
        const acquire = locations.contextEffect(ref)
        const acquireFileSystem = FileSystem.Service.pipe(Effect.provide(Layer.fresh(locations.get(ref))))
        expect(Exit.isFailure(yield* acquire.pipe(Effect.scoped, Effect.exit))).toBe(true)
        yield* Effect.promise(() => fs.mkdir(ref.directory))
        const recovered = yield* acquire
        expect(recovered === (yield* locations.contextEffect(ref))).toBe(true)
        expect(yield* acquireFileSystem).toBe(Context.get(recovered, FileSystem.Service))
        yield* locations.invalidate(ref)
        const refreshed = yield* acquire
        expect(refreshed === recovered).toBe(false)
        expect(refreshed === (yield* locations.contextEffect(ref))).toBe(true)
        expect(yield* acquireFileSystem).toBe(Context.get(refreshed, FileSystem.Service))
        const keys = Array.from(yield* RcMap.keys(locations.rcMap))
        expect(keys).toHaveLength(1)
        expect(keys.every(Schema.is(Location.Ref))).toBe(true)
        yield* locations.invalidate(keys[0])
        expect(refreshed === (yield* acquire)).toBe(false)
      })),
    ),
  )

  it.effect("late failed acquisition cleanup preserves recovered same-key leases", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) => Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const ref = Location.Ref.make({ directory: AbsolutePath.make(path.join(dir.path, "recovered")) })
        const scopeA = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const scopeB = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const scopeC = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const failed = yield* Effect.all([
          locations.contextEffect(ref).pipe(Scope.provide(scopeA), Effect.exit),
          locations.contextEffect(ref).pipe(Scope.provide(scopeB), Effect.exit),
        ], { concurrency: "unbounded" })
        expect(failed.every(Exit.isFailure)).toBe(true)
        yield* Scope.close(scopeA, Exit.void)
        yield* Effect.promise(() => fs.mkdir(ref.directory))
        const ready = yield* locations.contextEffect(ref).pipe(Scope.provide(scopeC))

        yield* Scope.close(scopeB, Exit.void)
        expect(ready === (yield* locations.contextEffect(ref).pipe(Scope.provide(scopeC)))).toBe(true)
        yield* TestClock.adjust("61 minutes")
        expect(ready === (yield* locations.contextEffect(ref).pipe(Scope.provide(scopeC)))).toBe(true)
        expect(yield* Context.get(ready, FileSystem.Service).list()).toEqual([])
      })),
    ),
  )

  it.live("retries failed directory construction after recovery while preserving successful caches", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) => Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const healthy = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
        const original = yield* locations.contextEffect(healthy)
        const directory = path.join(dir.path, "restored")
        const native = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const client = Location.Ref.make({ directory: AbsolutePath.make(process.platform === "win32" ? directory.replaceAll("\\", "/") : directory) })
        const failed = yield* Effect.all([
          locations.contextEffect(client).pipe(Effect.scoped, Effect.exit),
          locations.contextEffect(native).pipe(Effect.scoped, Effect.exit),
        ], { concurrency: "unbounded" })
        expect(failed.every(Exit.isFailure)).toBe(true)

        yield* Effect.promise(() => fs.mkdir(directory))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "retained.txt"), "owned recovery"))
        const recovered = yield* locations.contextEffect(native)
        const files = yield* Context.get(recovered, FileSystem.Service).list()
        expect(files.map((file) => file.path)).toContain(RelativePath.make("retained.txt"))
        expect(recovered).toBe(yield* locations.contextEffect(client))
        expect(original).toBe(yield* locations.contextEffect(healthy))
        expect(Option.getOrUndefined(Context.getOption(recovered, Database.Service))).toBe(
          Option.getOrUndefined(Context.getOption(original, Database.Service)),
        )
        const consumerFailure = yield* Effect.fail("request failure").pipe(
          Effect.provide(locations.get(healthy)), Effect.scoped, Effect.exit,
        )
        expect(Exit.isFailure(consumerFailure)).toBe(true)
        expect(original).toBe(yield* locations.contextEffect(healthy))
      })),
    ),
  )

  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            const context = yield* locations.contextEffect(constructed)
            expect(context).toBe(yield* locations.contextEffect(decoded))
            expect(Option.isSome(Context.getOption(context, Database.Service))).toBe(true)
            const clientRef = Location.Ref.make({
              directory: AbsolutePath.make(process.platform === "win32" ? dir.path.replaceAll("\\", "/") : dir.path),
            })
            expect(context).toBe(yield* locations.contextEffect(clientRef))
            expect(Context.get(context, Location.Service).directory).toBe(directory)
            const permission = yield* PermissionV2.Service.pipe(Effect.provide(locations.get(clientRef)))
            expect(permission).toBe(Context.get(context, PermissionV2.Service))
          }),
        ),
      ),
    ),
  )

  it.live("invalidates the same cached location through either separator spelling", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const native = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const client = Location.Ref.make({
            directory: AbsolutePath.make(process.platform === "win32" ? dir.path.replaceAll("\\", "/") : dir.path),
          })
          const before = yield* locations.contextEffect(native)
          const keys = Array.from(yield* RcMap.keys(locations.rcMap))
          expect(keys.some((key) => key.directory === native.directory && key.workspaceID === native.workspaceID)).toBe(true)
          yield* locations.invalidate(client)
          const after = yield* locations.contextEffect(native)
          expect(after).not.toBe(before)
          expect(after).toBe(yield* locations.contextEffect(client))
          const beforeDatabase = Context.getOption(before, Database.Service)
          const afterDatabase = Context.getOption(after, Database.Service)
          expect(Option.isSome(beforeDatabase)).toBe(true)
          expect(Option.isSome(afterDatabase)).toBe(true)
          expect(Option.getOrUndefined(afterDatabase)).toBe(Option.getOrUndefined(beforeDatabase))
        }),
      ),
    ),
  )

  it.live("preserves separate directories and workspace IDs when normalizing location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([first, second]) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const firstRef = Location.Ref.make({ directory: AbsolutePath.make(first.path) })
          const secondRef = Location.Ref.make({ directory: AbsolutePath.make(second.path) })
          const workspaceRef = Location.Ref.make({
            directory: AbsolutePath.make(process.platform === "win32" ? first.path.replaceAll("\\", "/") : first.path),
            workspaceID: WorkspaceV2.ID.make("wrk_location_isolation"),
          })
          const firstContext = yield* locations.contextEffect(firstRef)
          const secondContext = yield* locations.contextEffect(secondRef)
          const workspaceContext = yield* locations.contextEffect(workspaceRef)
          expect(secondContext).not.toBe(firstContext)
          expect(workspaceContext).not.toBe(firstContext)
          expect(Context.get(secondContext, PermissionV2.Service)).not.toBe(Context.get(firstContext, PermissionV2.Service))
          expect(Context.get(workspaceContext, PermissionV2.Service)).not.toBe(Context.get(firstContext, PermissionV2.Service))
          expect(Context.get(workspaceContext, Location.Service).workspaceID).toBe(workspaceRef.workspaceID)
        }),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "arforge.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const expectedTools = [
            "application_context",
            "apply_patch",
            "bash",
            "claim_task",
            "complete_task",
            "cooperative_wait",
            "create_task",
            "delete_task",
            "deliver_user_message",
            "edit",
            "glob",
            "goal_update",
            "grep",
            "list_tasks",
            "multimodal_diagnose",
            "notebook_edit",
            "notebook_read",
            "question",
            "read",
            "search_tasks",
            "skill",
            "team_create",
            "team_delete",
            "team_get",
            "team_member_add",
            "team_member_remove",
            "team_message_list",
            "team_message_send",
            "team_shutdown_request",
            "team_shutdown_respond",
            "todowrite",
            "trigger_manage",
            "trigger_profiles",
            "update_task",
            "webfetch",
            "websearch",
            "write",
          ]
          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
        }),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "arforge.json"),
              JSON.stringify({
                providers: {
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
