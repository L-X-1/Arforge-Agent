import { SessionV2 } from "@arforge-ai/core/session"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@arforge-ai/protocol/groups/session"
import {
  CheckpointNotFoundError,
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@arforge-ai/protocol/errors"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionOrganization } from "@arforge-ai/core/session/organization"
import * as ProfileMaintenanceLifecycle from "@arforge-ai/core/runtime/profile-maintenance-lifecycle"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

const controlledRestoreUnavailable = (operation: "revert.stage" | "revert.clear" | "revert.commit") =>
  new ServiceUnavailableError({
    message: `Session ${operation} is disabled until controlled restore runs through a sealed ControlRun worker`,
    service: `session.${operation}`,
  })

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const profileMaintenance = yield* ProfileMaintenanceLifecycle.Service

    const lifecycleFailure = () =>
      new InvalidRequestError({
        kind: "profile-maintenance-lifecycle-failed",
        message: "Profile maintenance could not be reconciled; retry the operation.",
      })

    const lifecycleCall = <A, E, R>(
      phase: ProfileMaintenanceLifecycle.LifecyclePhase,
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | InvalidRequestError, R> =>
      Effect.gen(function* () {
        const started = yield* (
          phase === "open"
            ? profileMaintenance.open()
            : phase === "resume"
              ? profileMaintenance.resume()
              : profileMaintenance.idle()
        ).pipe(Effect.mapError(lifecycleFailure))
        const finish =
          phase === "resume"
            ? profileMaintenance.idle({ profileID: started.profileID })
            : profileMaintenance.close({ profileID: started.profileID })
        return yield* operation.pipe(Effect.ensuring(finish.pipe(Effect.ignore)))
      }) as Effect.Effect<A, E | InvalidRequestError, R>

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const parsed =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const tags =
            parsed.tags === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(SessionOrganization.Tags)(
                  parsed.tags
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ).pipe(
                  Effect.mapError(
                    () =>
                      new InvalidRequestError({
                        message: "Session tags must be a comma-separated list of at most 16 valid tags.",
                        field: "tags",
                      }),
                  ),
                )
          const { tags: _tags, ...query } = parsed
          const sessions = yield* lifecycleCall(
            "open",
            session.list({
              ...query,
              tags,
              workspaceID: query.workspace,
              limit: ctx.query.limit ?? DefaultSessionsLimit,
            }),
          )
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* lifecycleCall(
              "open",
              session.create({
                id: ctx.payload.id,
                agent: ctx.payload.agent,
                model: ctx.payload.model,
                location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
              }),
            ),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* lifecycleCall("idle", session.active), (sessionID) => [
                sessionID,
                { type: "running" as const },
              ]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* lifecycleCall(
              "open",
              session.get(ctx.params.sessionID).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.tagsUpdate",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.updateTags({ ...ctx.params, tags: ctx.payload.tags }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.BusyError",
                (error) =>
                  new ConflictError({
                    message: `Session is active and cannot ${error.operation}.`,
                    resource: error.sessionID,
                  }),
              ),
              Effect.catchTag(
                "Session.InvalidTagsError",
                (error) => new InvalidRequestError({ message: error.message, field: "tags" }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.checkpointCreate",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.checkpoints.create({ ...ctx.params, label: ctx.payload.label }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.BusyError",
                (error) =>
                  new ConflictError({
                    message: `Session is active and cannot ${error.operation}.`,
                    resource: error.sessionID,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.checkpointList",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.checkpoints.list(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.rewindPreview",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.rewind.preview({ ...ctx.params, checkpointID: ctx.payload.checkpointID }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.CheckpointNotFoundError",
                (error) =>
                  new CheckpointNotFoundError({
                    sessionID: error.sessionID,
                    checkpointID: error.checkpointID,
                    message: `Checkpoint not found: ${error.checkpointID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.rewindApply",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.rewind.apply({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.CheckpointNotFoundError",
                (error) =>
                  new CheckpointNotFoundError({
                    sessionID: error.sessionID,
                    checkpointID: error.checkpointID,
                    message: `Checkpoint not found: ${error.checkpointID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.BusyError",
                (error) =>
                  new ConflictError({
                    message: `Session is active and cannot ${error.operation}.`,
                    resource: error.sessionID,
                  }),
              ),
              Effect.catchTag(
                "Session.StaleRewindError",
                (error) =>
                  new ConflictError({
                    message: `Rewind preview is stale: expected sequence ${error.expectedLastSequence}, current sequence is ${error.actualLastSequence}.`,
                    resource: error.checkpointID,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* lifecycleCall(
              ctx.payload.resume === false ? "open" : "resume",
              session
                .prompt({
                  sessionID: ctx.params.sessionID,
                  id: ctx.payload.id,
                  prompt: ctx.payload.prompt,
                  delivery: ctx.payload.delivery,
                  resume: ctx.payload.resume,
                })
                .pipe(
                  Effect.catchTag("Session.NotFoundError", (error) =>
                    Effect.fail(
                      new SessionNotFoundError({
                        sessionID: error.sessionID,
                        message: `Session not found: ${error.sessionID}`,
                      }),
                    ),
                  ),
                  Effect.catchTag("Session.PromptConflictError", (error) =>
                    Effect.fail(
                      new ConflictError({
                        message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                        resource: error.messageID,
                      }),
                    ),
                  ),
                ),
            ),
          }
        }),
      )
      .handle(
        "session.promptQueueList",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.promptQueue.list(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.promptQueueUpdate",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.promptQueue.update({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("SessionInput.QueuedPromptNotFoundError", (error) =>
                Effect.fail(
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Queued prompt not found or already promoted: ${error.messageID}`,
                  }),
                ),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.promptQueueRemove",
        Effect.fn(function* (ctx) {
          yield* session.promptQueue.remove({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("SessionInput.QueuedPromptNotFoundError", (error) =>
              Effect.fail(
                new MessageNotFoundError({
                  sessionID: error.sessionID,
                  messageID: error.messageID,
                  message: `Queued prompt not found or already promoted: ${error.messageID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* lifecycleCall(
            "resume",
            session.wait(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.OperationUnavailableError", (error) =>
                Effect.fail(
                  new ServiceUnavailableError({
                    message: `Session ${error.operation} is not available yet`,
                    service: `session.${error.operation}`,
                  }),
                ),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("SessionRevert.MutationUnavailableError", () =>
                controlledRestoreUnavailable("revert.stage"),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("SessionRevert.MutationUnavailableError", () =>
              controlledRestoreUnavailable("revert.clear"),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("SessionRevert.MutationUnavailableError", () =>
              controlledRestoreUnavailable("revert.commit"),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* lifecycleCall("idle", session.interrupt(ctx.params.sessionID))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)
