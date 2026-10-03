export * as PrimaryDeliveryV2 from "./primary-delivery"

import { PrimaryDelivery } from "@arforge-ai/schema/primary-delivery"
import { lstat } from "node:fs/promises"
import path from "node:path"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { FSUtil } from "./fs-util"
import { GoalV2 } from "./goal"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { PermissionV2 } from "./permission"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { AgentV2 } from "./agent"
import { PrimaryDeliveryState } from "./primary-delivery-state"
import { ToolOutputStore } from "./tool-output-store"

export const MAX_MESSAGE_CHARS = 20_000
export const MAX_ATTACHMENTS = 8
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_PATH_CHARS = 2_048

const AllowedMime: ReadonlyMap<string, string> = new Map([
  [".c", "text/x-c"],
  [".cpp", "text/x-c++"],
  [".csv", "text/csv"],
  [".css", "text/css"],
  [".diff", "text/x-diff"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".go", "text/x-go"],
  [".h", "text/x-c"],
  [".hpp", "text/x-c++"],
  [".html", "text/html"],
  [".java", "text/x-java-source"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsx", "text/jsx"],
  [".log", "text/plain"],
  [".md", "text/markdown"],
  [".patch", "text/x-diff"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".py", "text/x-python"],
  [".rs", "text/x-rust"],
  [".svg", "image/svg+xml"],
  [".toml", "application/toml"],
  [".ts", "text/typescript"],
  [".tsv", "text/tab-separated-values"],
  [".tsx", "text/tsx"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".zip", "application/zip"],
] as const)

export class DeliveryError extends Schema.TaggedErrorClass<DeliveryError>()("PrimaryDelivery.DeliveryError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface DeliverInput {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
  readonly message: string
  readonly status: PrimaryDelivery.Status
  readonly attachments: ReadonlyArray<string>
  /** Gateway-scoped leaf authorization supplied by the built-in tool path. */
  readonly authorize?: (input: PermissionV2.AssertInput) => Effect.Effect<void, unknown>
}

export interface Interface {
  readonly deliver: (input: DeliverInput) => Effect.Effect<PrimaryDelivery.Metadata, DeliveryError>
  readonly delivered: (sessionID: SessionSchema.ID) => boolean
  readonly consume: (sessionID: SessionSchema.ID) => boolean
  readonly withinRun: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PrimaryDelivery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const state = yield* PrimaryDeliveryState.Service
    const goals = yield* GoalV2.Service
    const artifacts = yield* ToolOutputStore.Service
    const assertPermission = (input: DeliverInput, request: PermissionV2.AssertInput) =>
      input.authorize ? input.authorize(request) : permission.assert(request)

    const inspect = Effect.fn("PrimaryDelivery.inspect")(function* (rawPath: string, input: DeliverInput) {
      const value = rawPath.trim()
      if (!value || value.length > MAX_PATH_CHARS || value.includes("\0"))
        return yield* invalid("INVALID_PATH", "attachment path is invalid or too long")
      const lexical = path.resolve(location.directory, value)
      const before = yield* fileStat(lexical, value)
      if (before.isSymbolicLink())
        return yield* invalid("SYMLINK_NOT_ALLOWED", `attachment must not be a symbolic link: ${value}`)
      if (!before.isFile()) return yield* invalid("NOT_A_FILE", `attachment is not a regular file: ${value}`)

      const target = yield* mutation
        .resolve({ path: value, kind: "file" })
        .pipe(
          Effect.mapError(() => new DeliveryError({ code: "INVALID_PATH", message: `invalid attachment: ${value}` })),
        )
      const source = {
        type: "tool" as const,
        messageID: input.assistantMessageID,
        callID: input.callID,
      }
      if (target.externalDirectory)
        yield* assertPermission(input, {
            ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
            sessionID: input.sessionID,
            agent: input.agent,
            source,
          })
          .pipe(
            Effect.mapError(
              () => new DeliveryError({ code: "NOT_AUTHORIZED", message: "attachment is not authorized" }),
            ),
          )
      yield* assertPermission(input, {
          action: "read",
          resources: [target.resource],
          save: ["*"],
          sessionID: input.sessionID,
          agent: input.agent,
          source,
        })
        .pipe(
          Effect.mapError(() => new DeliveryError({ code: "NOT_AUTHORIZED", message: "attachment is not authorized" })),
        )

      const suffix = path.extname(target.canonical).toLowerCase()
      const mime = AllowedMime.get(suffix)
      if (!mime) return yield* invalid("TYPE_NOT_ALLOWED", `attachment type is not allowed: ${suffix || "(none)"}`)
      if (before.size > BigInt(MAX_ATTACHMENT_BYTES))
        return yield* invalid("FILE_TOO_LARGE", "attachment exceeds 25 MB")
      const content = yield* fs
        .readFile(target.canonical)
        .pipe(
          Effect.mapError(() => new DeliveryError({ code: "READ_FAILED", message: "attachment could not be read" })),
        )
      const after = yield* fileStat(lexical, value)
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs)
        return yield* invalid("FILE_CHANGED", `attachment changed during inspection: ${value}`)
      const bytes = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer
      const sha256 = yield* Effect.promise(async () =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      )
      const artifactRef = yield* artifacts
        .bindBytes({
          bytes: content,
          owner: { scope: "session", id: input.sessionID },
          kind: "primary_delivery",
          mime,
          label: path.basename(target.canonical),
        })
        .pipe(
          Effect.mapError(
            () => new DeliveryError({ code: "READ_FAILED", message: "attachment could not be retained safely" }),
          ),
        )
      return PrimaryDelivery.Artifact.make({
        artifactID: `msg-${sha256.slice(0, 16)}`,
        artifactRef,
        path: target.canonical,
        displayName: path.basename(target.canonical),
        mime,
        sizeBytes: Number(after.size),
        createdAt: yield* DateTime.now,
        sha256,
        source: "user_message",
        isImage: mime.startsWith("image/"),
      })
    })

    const deliver: Interface["deliver"] = Effect.fn("PrimaryDelivery.deliver")(function* (input) {
      const message = input.message.trim()
      if (!message) return yield* invalid("INVALID_MESSAGE", "message must not be empty")
      if (message.length > MAX_MESSAGE_CHARS)
        return yield* invalid("MESSAGE_TOO_LARGE", `message exceeds ${MAX_MESSAGE_CHARS} characters`)
      if ([...message].some((character) => character.charCodeAt(0) < 32 && !"\n\r\t".includes(character)))
        return yield* invalid("INVALID_MESSAGE", "message contains unsupported control characters")
      if (input.attachments.length > MAX_ATTACHMENTS)
        return yield* invalid("TOO_MANY_ATTACHMENTS", `no more than ${MAX_ATTACHMENTS} attachments are allowed`)

      const activeGoal = (yield* goals.list({ sessionID: input.sessionID, includeHistory: false })).active
      if (activeGoal?.status === "running")
        return yield* invalid(
          "GOAL_INCOMPLETE",
          "the running Goal must be completed or blocked before delivering a primary user message",
        )

      yield* assertPermission(input, {
          action: "deliver_user_message",
          resources: ["*"],
          save: ["*"],
          sessionID: input.sessionID,
          agent: input.agent,
          source: { type: "tool", messageID: input.assistantMessageID, callID: input.callID },
        })
        .pipe(
          Effect.mapError(() => new DeliveryError({ code: "NOT_AUTHORIZED", message: "delivery was not approved" })),
        )

      const artifacts: PrimaryDelivery.Artifact[] = []
      const paths = new Set<string>()
      const inspectedPaths = new Set<string>()
      let total = 0
      for (const attachment of input.attachments) {
        const candidate = path.resolve(location.directory, attachment.trim())
        if (inspectedPaths.has(candidate)) continue
        inspectedPaths.add(candidate)
        const artifact = yield* inspect(attachment, input)
        if (paths.has(artifact.path)) continue
        paths.add(artifact.path)
        total += artifact.sizeBytes
        if (total > MAX_TOTAL_ATTACHMENT_BYTES)
          return yield* invalid("ATTACHMENTS_TOO_LARGE", "attachments exceed 50 MB in total")
        artifacts.push(artifact)
      }
      const metadata = PrimaryDelivery.Metadata.make({
        status: input.status,
        sentAt: yield* DateTime.now,
        attachmentCount: artifacts.length,
        attachments: artifacts,
        localOnly: true,
        uploaded: false,
      })
      state.mark(input.sessionID)
      yield* events
        .publish(SessionEvent.PrimaryDelivered, {
          sessionID: input.sessionID,
          timestamp: metadata.sentAt,
          assistantMessageID: input.assistantMessageID,
          callID: input.callID,
          message,
          delivery: metadata,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              state.clear(input.sessionID)
            }),
          ),
          Effect.orDie,
        )
      return metadata
    })

    return Service.of({
      deliver,
      delivered: state.delivered,
      consume: state.consume,
      withinRun: state.withinRun,
    })
  }),
)

const invalid = (code: string, message: string) => Effect.fail(new DeliveryError({ code, message }))

const fileStat = (absolute: string, display: string) =>
  Effect.tryPromise({
    try: () => lstat(absolute, { bigint: true }),
    catch: () => new DeliveryError({ code: "FILE_NOT_FOUND", message: `attachment does not exist: ${display}` }),
  })

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    FSUtil.node,
    GoalV2.node,
    Location.node,
    LocationMutation.node,
    PermissionV2.node,
    PrimaryDeliveryState.node,
    ToolOutputStore.node,
  ],
})
