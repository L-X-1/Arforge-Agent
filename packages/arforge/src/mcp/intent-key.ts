import path from "node:path"
import { createHmac, randomBytes } from "node:crypto"
import { Effect, Schema } from "effect"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Global } from "@arforge-ai/core/global"
import { ProtectedJson } from "@arforge-ai/core/protected-json"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"

const INTENT_KEY_FILE = path.join(Global.Path.data, "mcp-intent-key.json")
const IntentKeyFile = Schema.Struct({ version: Schema.Literal(1), key: Schema.String })

/**
 * Returns only a keyed digest function; the protected HMAC key never leaves
 * this internal MCP module. Creation is serialized across processes and the
 * protected file is re-read under the lock, so concurrent first boots all use
 * the same persisted key. Provider, envelope, decode, and format failures are
 * deliberately fatal rather than being mistaken for an absent key.
 */
export const makeIntentSealer = Effect.fn("MCP.makeIntentSealer")(function* (file = INTENT_KEY_FILE) {
  const fsUtil = yield* FSUtil.Service
  const secretProvider = yield* SecretProvider.Service
  const flock = yield* EffectFlock.Service
  const readProtected = (target: string) =>
    ProtectedJson.read(target).pipe(
      Effect.provideService(FSUtil.Service, fsUtil),
      Effect.provideService(SecretProvider.Service, secretProvider),
    )
  const writeProtected = (target: string, value: unknown) =>
    ProtectedJson.write(target, value, 0o600).pipe(
      Effect.provideService(FSUtil.Service, fsUtil),
      Effect.provideService(SecretProvider.Service, secretProvider),
    )

  const key = yield* flock
    .withLock(
      Effect.gen(function* () {
        const stored = yield* readProtected(file).pipe(
          Effect.map((value) => value as { readonly value: unknown; readonly needsMigration: boolean } | undefined),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        )
        if (!stored) {
          const created = IntentKeyFile.make({ version: 1, key: randomBytes(32).toString("base64") })
          yield* writeProtected(file, created)
          return Buffer.from(created.key, "base64")
        }
        if (stored.needsMigration)
          return yield* Effect.die(new Error("MCP intent key must be stored in a protected envelope"))
        const decoded = yield* Schema.decodeUnknownEffect(IntentKeyFile)(stored.value).pipe(Effect.orDie)
        const decodedKey = Buffer.from(decoded.key, "base64")
        if (decodedKey.byteLength !== 32) return yield* Effect.die(new Error("MCP intent key is invalid"))
        return decodedKey
      }),
      `mcp-intent-key:${file}`,
    )
    .pipe(Effect.orDie)

  return (value: unknown) => {
    const canonical = canonicalHash(value)
    if (!canonical) return undefined
    return createHmac("sha256", key).update(canonical).digest("base64url")
  }
})
