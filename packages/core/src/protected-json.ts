export * as ProtectedJson from "./protected-json"

import { Effect, Schema } from "effect"
import { dirname } from "node:path"
import { FSUtil } from "./fs-util"
import { SecretProvider } from "./secret-provider"

export const Envelope = Schema.Struct({
  schema_version: Schema.Literal(1),
  kind: Schema.Literal("arforge-protected-json"),
  provider: Schema.String,
  ciphertext: Schema.String,
})
export type Envelope = Schema.Schema.Type<typeof Envelope>

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)

export const read = Effect.fn("ProtectedJson.read")(function* (file: string) {
  const fs = yield* FSUtil.Service
  const provider = yield* SecretProvider.Service
  const raw = yield* fs.readJson(file)
  const envelope = decodeEnvelope(raw)
  if (envelope._tag === "None") return { value: raw, needsMigration: true as const }
  if (envelope.value.provider !== provider.id)
    return yield* new SecretProvider.Error({
      operation: "unprotect",
      provider: provider.id,
      message: `credential file requires provider ${envelope.value.provider}`,
    })
  const plaintext = yield* provider.unprotect(envelope.value.ciphertext)
  const value = yield* Effect.try({
    try: () => JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown,
    catch: () =>
      new SecretProvider.Error({
        operation: "unprotect",
        provider: provider.id,
        message: "decrypted credential JSON is invalid",
      }),
  })
  return { value, needsMigration: false as const }
})

export const write = Effect.fn("ProtectedJson.write")(function* (file: string, value: unknown, mode = 0o600) {
  const fs = yield* FSUtil.Service
  const provider = yield* SecretProvider.Service
  const plaintext = Buffer.from(JSON.stringify(value), "utf8")
  const ciphertext = yield* provider.protect(plaintext)
  const envelope = Envelope.make({
    schema_version: 1,
    kind: "arforge-protected-json",
    provider: provider.id,
    ciphertext,
  })
  yield* fs.ensureDir(dirname(file))
  yield* fs.writeJson(file, envelope, mode)
})
