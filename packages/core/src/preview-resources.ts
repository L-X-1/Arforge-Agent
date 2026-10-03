export * as PreviewResources from "./preview-resources"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { LocationMutation } from "./location-mutation"

export class ResourceError extends Schema.TaggedErrorClass<ResourceError>()("PreviewResources.Error", {
  message: Schema.String,
}) {}
const failure = () => new ResourceError({ message: "The requested preview resource is unavailable or outside the allowed scope." })

export interface Asset { readonly bytes: Uint8Array; readonly mime: string }
export interface Reader { readonly read: (resource: string) => Effect.Effect<Asset, ResourceError> }
export interface Interface { readonly open: (documentPath: string) => Effect.Effect<Reader, ResourceError> }
export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PreviewResources") {}

function validImage(bytes: Uint8Array, mime: string) {
  const start = Buffer.from(bytes.subarray(0, 12))
  if (mime === "image/png") return start.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === "image/jpeg") return start[0] === 255 && start[1] === 216 && start[2] === 255
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(start.subarray(0, 6).toString("ascii"))
  if (mime === "image/webp") return start.subarray(0, 4).toString("ascii") === "RIFF" && start.subarray(8, 12).toString("ascii") === "WEBP"
  return false
}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const resolver = yield* LocationMutation.Service
  return Service.of({
    open: (documentPath) => Effect.gen(function* () {
      if (
        !documentPath || documentPath.length > 4096 || /[\x00-\x1f:]/.test(documentPath) ||
        path.isAbsolute(documentPath) || path.win32.isAbsolute(documentPath) || !/\.(?:html?|xhtml)$/i.test(documentPath)
      ) return yield* failure()
      const document = yield* resolver.resolve({ path: documentPath })
      if (document.externalDirectory || (yield* fs.stat(document.canonical)).type !== "File") return yield* failure()
      const root = path.dirname(document.canonical)
      return {
        read: (resource: string) => Effect.gen(function* () {
          const relative = PreviewResource.resourcePath(resource)
          const mime = PreviewResource.mimeType(resource)
          if (!relative || !mime) return yield* failure()
          const target = yield* resolver.resolve({ path: path.join(root, relative) })
          if (target.externalDirectory || !FSUtil.contains(root, target.canonical)) return yield* failure()
          const info = yield* fs.stat(target.canonical)
          const limit = mime === "text/css" ? PreviewResource.MAX_CSS_BYTES : PreviewResource.MAX_ASSET_BYTES
          if (info.type !== "File" || Number(info.size) > limit) return yield* failure()
          const bytes = yield* fs.readFile(target.canonical)
          if (bytes.byteLength > limit) return yield* failure()
          // Re-resolve before returning bytes; do not cache a path authorization.
          const after = yield* resolver.resolve({ path: path.join(root, relative) })
          if (after.canonical !== target.canonical || after.externalDirectory || !FSUtil.contains(root, after.canonical))
            return yield* failure()
          if (mime === "text/css") {
            const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes), catch: failure })
            if (text.includes("\0")) return yield* failure()
          } else if (!validImage(bytes, mime)) return yield* failure()
          return { bytes, mime }
        }).pipe(Effect.mapError(failure)),
      } satisfies Reader
    }).pipe(Effect.mapError(failure)),
  })
}))

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, LocationMutation.node] })
