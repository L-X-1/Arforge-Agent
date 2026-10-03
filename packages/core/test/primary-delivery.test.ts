import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { GoalV2 } from "@arforge-ai/core/goal"
import { Global } from "@arforge-ai/core/global"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PrimaryDeliveryV2 } from "@arforge-ai/core/primary-delivery"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { PrimaryDeliveryTool } from "@arforge-ai/core/tool/primary-delivery"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_primary_delivery_test")
const permissions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => permissions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withDelivery = <A, E, R>(
  directory: string,
  body: (services: {
    readonly deliveries: PrimaryDeliveryV2.Interface
    readonly registry: ToolRegistry.Interface
    readonly events: EventV2.Interface
  }) => Effect.Effect<A, E, R>,
  activeGoal: () => GoalV2.Info | undefined = () => undefined,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const goal = Layer.succeed(
    GoalV2.Service,
    GoalV2.Service.of({
      create: () => Effect.die("unused"),
      list: () =>
        Effect.sync(() => {
          const active = activeGoal()
          return {
            ...(active ? { active } : {}),
            queued: [],
            history: [],
            items: active ? [active] : [],
          }
        }),
      get: () => Effect.die("unused"),
      start: () => Effect.die("unused"),
      pause: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      block: () => Effect.die("unused"),
      complete: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      replace: () => Effect.die("unused"),
      deleteQueued: () => Effect.die("unused"),
      reorder: () => Effect.die("unused"),
    }),
  )
  return Effect.gen(function* () {
    return yield* body({
      deliveries: yield* PrimaryDeliveryV2.Service,
      registry: yield* ToolRegistry.Service,
      events: yield* EventV2.Service,
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          GoalV2.node,
          LocationMutation.node,
          PrimaryDeliveryV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          PrimaryDeliveryTool.node,
        ]),
        [
          [GoalV2.node, goal],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [Global.node, Global.layerWith({ data: directory, state: path.join(directory, "state") })],
        ],
      ),
    ),
  )
}

const it = testEffect(Layer.empty)

describe("PrimaryDelivery", () => {
  it.live("publishes one primary local-only message with deduplicated, hashed attachment metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          permissions.length = 0
          const report = path.join(tmp.path, "report.txt")
          yield* Effect.promise(() => fs.writeFile(report, "release evidence"))
          yield* withDelivery(tmp.path, ({ deliveries, registry, events }) =>
            Effect.gen(function* () {
              const captured: EventV2.Payload[] = []
              yield* events.listen((event) =>
                Effect.sync(() => {
                  if (event.type === "session.next.primary.delivered") captured.push(event)
                }),
              )
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["deliver_user_message"])
              expect(
                yield* executeTool(registry, {
                  sessionID,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: "delivery",
                    name: "deliver_user_message",
                    input: {
                      message: "Release evidence is ready.",
                      status: "proactive",
                      attachments: ["report.txt", report],
                    },
                  },
                }),
              ).toMatchObject({
                type: "text",
                value: expect.stringContaining("Primary message delivered (proactive, 1 local attachment(s))"),
              })
              yield* Effect.sleep("10 millis")
              expect(deliveries.delivered(sessionID)).toBeTrue()
              expect(deliveries.consume(sessionID)).toBeTrue()
              expect(deliveries.delivered(sessionID)).toBeFalse()
              expect(captured).toHaveLength(1)
              expect(captured[0]?.data).toMatchObject({
                message: "Release evidence is ready.",
                delivery: {
                  status: "proactive",
                  attachmentCount: 1,
                  localOnly: true,
                  uploaded: false,
                  attachments: [
                    {
                      path: report,
                      displayName: "report.txt",
                      mime: "text/plain",
                      sizeBytes: 16,
                      source: "user_message",
                      isImage: false,
                    },
                  ],
                },
              })
              const artifact = (
                captured[0]!.data as { delivery: { attachments: Array<{ sha256: string; artifactID: string }> } }
              ).delivery.attachments[0]!
              expect(artifact.sha256).toBe("55721654f9f5ee40e2acd466f488de43bcf890ee0d7fcb20272c5bfd0708ea8c")
              expect(artifact.artifactID).toBe(`msg-${artifact.sha256.slice(0, 16)}`)
              expect((artifact as { artifactRef?: { kind: string; owner: { scope: string; id: string }; digest: string } }).artifactRef).toMatchObject({
                kind: "primary_delivery",
                owner: { scope: "session", id: sessionID },
                digest: artifact.sha256,
              })
              expect(permissions.map((item) => item.action)).toEqual(["deliver_user_message", "read"])
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails closed for escapes, disallowed types, symbolic links, and oversized files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const outside = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-outside.txt`)
          const executable = path.join(tmp.path, "unsafe.exe")
          const oversized = path.join(tmp.path, "oversized.txt")
          const target = path.join(tmp.path, "target.txt")
          const link = path.join(tmp.path, "link.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(outside, "outside")
            await fs.writeFile(executable, "MZ")
            await fs.writeFile(target, "target")
            const handle = await fs.open(oversized, "w")
            await handle.truncate(PrimaryDeliveryV2.MAX_ATTACHMENT_BYTES + 1)
            await handle.close()
            await fs.symlink(target, link).catch(() => undefined)
          })
          yield* withDelivery(tmp.path, ({ deliveries }) =>
            Effect.gen(function* () {
              const base = {
                sessionID,
                agent: toolIdentity.agent,
                assistantMessageID: toolIdentity.assistantMessageID,
                callID: "unsafe",
                message: "message",
                status: "normal" as const,
              }
              expect(
                yield* deliveries.deliver({ ...base, attachments: [`../${path.basename(outside)}`] }).pipe(Effect.flip),
              ).toMatchObject({ code: "INVALID_PATH" })
              expect(
                yield* deliveries.deliver({ ...base, attachments: ["unsafe.exe"] }).pipe(Effect.flip),
              ).toMatchObject({ code: "TYPE_NOT_ALLOWED" })
              expect(
                yield* deliveries.deliver({ ...base, attachments: ["oversized.txt"] }).pipe(Effect.flip),
              ).toMatchObject({ code: "FILE_TOO_LARGE" })
              if (yield* Effect.promise(() => fileExists(link)))
                expect(
                  yield* deliveries.deliver({ ...base, attachments: ["link.txt"] }).pipe(Effect.flip),
                ).toMatchObject({ code: "SYMLINK_NOT_ALLOWED" })
            }),
          )
          yield* Effect.promise(() => fs.rm(outside, { force: true }))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects primary delivery until a running Goal is completed or blocked", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        let status: GoalV2.Status = "running"
        const active = () =>
          ({
            id: GoalV2.ID.create(),
            sessionID,
            objective: "Verify the requested outcome before delivery.",
            status,
            queuePosition: 0,
            revision: 1,
            lastError: "",
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          }) satisfies GoalV2.Info
        return withDelivery(
          tmp.path,
          ({ deliveries }) =>
            Effect.gen(function* () {
              permissions.length = 0
              const input = {
                sessionID,
                agent: toolIdentity.agent,
                assistantMessageID: toolIdentity.assistantMessageID,
                callID: "goal-gate",
                message: "This must not be delivered early.",
                status: "normal" as const,
                attachments: [],
              }

              expect(yield* deliveries.deliver(input).pipe(Effect.flip)).toMatchObject({
                code: "GOAL_INCOMPLETE",
              })
              expect(permissions).toHaveLength(0)
              status = "completed"
              expect(yield* deliveries.deliver(input)).toMatchObject({
                status: "normal",
                attachmentCount: 0,
              })
              expect(permissions.map((item) => item.action)).toEqual(["deliver_user_message"])
            }),
          active,
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

async function fileExists(target: string) {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}
