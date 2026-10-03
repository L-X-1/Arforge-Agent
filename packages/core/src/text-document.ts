export * as TextDocument from "./text-document"

import { createHash } from "node:crypto"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { TextDocument as Contract } from "@arforge-ai/schema/text-document"
import { makeLocationNode } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FSUtil } from "./fs-util"
import { LocationMutation } from "./location-mutation"

export class DocumentError extends Schema.TaggedErrorClass<DocumentError>()("TextDocument.Error", {
  reason: Schema.Literals(["invalid_path", "unsupported", "conflict", "io"]),
  message: Schema.String,
}) {}

const problem = (reason: DocumentError["reason"], message: string) => new DocumentError({ reason, message })
const ioError = (error: unknown) =>
  error instanceof DocumentError
    ? error
    : problem("io", "The workspace file could not be accessed safely. Check its path and permissions.")

function decode(filePath: string, bytes: Uint8Array): Contract.Info {
  if (bytes.byteLength > Contract.MAX_FILE_BYTES) throw problem("unsupported", "The file exceeds the editing size limit.")
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes)
  } catch {
    throw problem("unsupported", "Only valid UTF-8 text files can be edited.")
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source))
    throw problem("unsupported", "Binary files cannot be edited as text.")
  const crlf = source.includes("\r\n")
  const remainder = source.replaceAll("\r\n", "")
  if (remainder.includes("\r") || (crlf && remainder.includes("\n")))
    throw problem("unsupported", "Mixed or CR-only line endings are not supported; the original file was not changed.")
  const text = source.replaceAll("\r\n", "\n")
  if (text.length > Contract.MAX_TEXT_LENGTH) throw problem("unsupported", "The file exceeds the editing size limit.")
  return {
    path: filePath,
    text,
    version: createHash("sha256").update(bytes).digest("hex"),
    bom,
    lineEnding: crlf ? "crlf" : "lf",
  }
}

const snapshot = Effect.fn("TextDocument.snapshot")(function* (filePath: string) {
  if (
    !filePath ||
    filePath.length > 4096 ||
    filePath.includes("\0") ||
    filePath.includes(":") ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath)
  )
    return yield* problem("invalid_path", "Choose an existing file inside the current workspace.")

  const resolver = yield* LocationMutation.Service
  const target = yield* resolver.resolve({ path: filePath })
  if (target.externalDirectory) return yield* problem("invalid_path", "Files outside the workspace cannot be edited.")
  const fs = yield* FSUtil.Service
  const info = yield* fs.stat(target.canonical)
  if (info.type !== "File") return yield* problem("unsupported", "Only existing regular files can be edited.")
  if (Number(info.size) > Contract.MAX_FILE_BYTES)
    return yield* problem("unsupported", "The file exceeds the editing size limit.")
  const bytes = yield* fs.readFile(target.canonical)
  const document = yield* Effect.try({ try: () => decode(filePath, bytes), catch: ioError })
  return { target, bytes, document }
})

const readSnapshot = (filePath: string) =>
  snapshot(filePath).pipe(Effect.map((value) => value.document), Effect.mapError(ioError))

const saveSnapshot = (input: Contract.SaveInput) =>
  Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/.test(input.baseVersion))
      return yield* problem("conflict", "A valid file version is required before saving.")
    if (input.text.length > Contract.MAX_TEXT_LENGTH || input.text.includes("\r"))
      return yield* problem("unsupported", "The edit exceeds the size limit or contains unsupported line endings.")
    if (new TextDecoder().decode(new TextEncoder().encode(input.text)) !== input.text)
      return yield* problem("unsupported", "The edit contains invalid Unicode text.")
    const current = yield* snapshot(input.path)
    if (current.document.version !== input.baseVersion)
      return yield* problem("conflict", "The file changed on disk. Your draft was not written; reload before editing again.")
    const source = current.document.lineEnding === "crlf" ? input.text.replaceAll("\n", "\r\n") : input.text
    const bytes = new TextEncoder().encode((current.document.bom ? "\uFEFF" : "") + source)
    const document = yield* Effect.try({ try: () => decode(input.path, bytes), catch: ioError })
    const mutation = yield* FileMutation.Service
    yield* mutation.writeIfUnchanged({ target: current.target, expected: current.bytes, content: bytes }).pipe(
      Effect.mapError((error) =>
        error instanceof FileMutation.StaleContentError
          ? problem("conflict", "The file changed while saving. Your draft was retained; no blind retry was attempted.")
          : ioError(error),
      ),
    )
    return document
  }).pipe(Effect.mapError(ioError))

export interface Interface {
  readonly read: (filePath: string) => Effect.Effect<Contract.Info, DocumentError>
  readonly save: (input: Contract.SaveInput) => Effect.Effect<Contract.Info, DocumentError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/TextDocument") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const resolver = yield* LocationMutation.Service
    const mutation = yield* FileMutation.Service
    const provide = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service | LocationMutation.Service | FileMutation.Service>) =>
      effect.pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(LocationMutation.Service, resolver),
        Effect.provideService(FileMutation.Service, mutation),
      )

    return Service.of({
      read: (filePath) => provide(readSnapshot(filePath)),
      save: (input) => provide(saveSnapshot(input)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, LocationMutation.node, FileMutation.node],
})

export const read = (filePath: string) => Effect.flatMap(Service, (service) => service.read(filePath))
export const save = (input: Contract.SaveInput) => Effect.flatMap(Service, (service) => service.save(input))
