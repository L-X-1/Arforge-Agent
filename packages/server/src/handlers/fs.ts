import { FileSystem } from "@arforge-ai/core/filesystem"
import { PreviewResources } from "@arforge-ai/core/preview-resources"
import { Location } from "@arforge-ai/core/location"
import { TextDocument } from "@arforge-ai/core/text-document"
import { TextDocumentConflict, TextDocumentError } from "@arforge-ai/protocol/groups/fs"
import { RelativePath } from "@arforge-ai/core/schema"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { IdentityContext } from "../identity-context"
import { PreviewResourceHost, previewResourceHostLayer } from "../preview-resource-host"

const previewOwner = Effect.gen(function* () {
  const location = yield* Location.Service
  const principal = yield* IdentityContext.Current
  return JSON.stringify([principal.tenantID, principal.userID, principal.sessionID, location.directory, location.workspaceID])
})

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const previewHost = yield* PreviewResourceHost
    return handlers
      .handle("fs.preview.open", (ctx) => response(Effect.gen(function* () {
        const resources = yield* PreviewResources.Service
        const reader = yield* resources.open(ctx.payload.path)
        const owner = yield* previewOwner
        return yield* Effect.tryPromise({
          try: () => previewHost.open(owner, ctx.payload.path, (path) => Effect.runPromise(reader.read(path))),
          catch: () => new PreviewResources.ResourceError({ message: "Local preview resources could not be enabled." }),
        })
      })).pipe(Effect.mapError((error) => new TextDocumentError({ name: "TextDocumentError", data: { message: error.message } }))))
      .handle("fs.preview.close", (ctx) => response(Effect.gen(function* () {
        return { revoked: previewHost.revoke(yield* previewOwner, ctx.payload.id) }
      })))
      .handle("fs.text.read", (ctx) =>
        response(TextDocument.read(ctx.query.path)).pipe(
          Effect.mapError((error) => new TextDocumentError({ name: "TextDocumentError", data: { message: error.message } })),
        ),
      )
      .handle("fs.text.save", (ctx) =>
        response(TextDocument.save(ctx.payload)).pipe(
          Effect.mapError((error) =>
            error.reason === "conflict"
              ? new TextDocumentConflict({ name: "TextDocumentConflict", data: { message: error.message } })
              : new TextDocumentError({ name: "TextDocumentError", data: { message: error.message } }),
          ),
        ),
      )
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const file = yield* (yield* FileSystem.Service).read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
  }),
).pipe(Layer.provide(previewResourceHostLayer))
