import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import * as TenantPlatform from "@arforge-ai/core/tenant-platform"
import { SecretProvider } from "@arforge-ai/core/secret-provider"

const [databasePath, workerID, bytesText] = Bun.argv.slice(2)
if (!databasePath || !workerID || !bytesText) throw new Error("tenant rate worker requires database, ID, and byte cost")
const bytes = Number(bytesText)
if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("tenant rate worker byte cost is invalid")

const secrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(31), "tenant-rate-worker")
const layer = AppNodeBuilder.build(LayerNode.group([Database.node, TenantPlatform.node]), [
  [Database.node, Database.layerFromPath(databasePath)],
  [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
])

const exit = await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* TenantPlatform.Service
    return yield* service.consumeRate(
      { tenantID: "ten_local", userID: "usr_local", role: "owner" },
      { bucket: TenantPlatform.ARTIFACT_READ_BUCKET, bytes, now: 50_000 },
    )
  }).pipe(Effect.provide(layer), Effect.exit),
)

if (Exit.isSuccess(exit)) {
  process.stdout.write(JSON.stringify({ workerID, success: true, allowed: exit.value.allowed, remainingBytes: exit.value.remainingBytes }))
} else {
  process.stdout.write(JSON.stringify({ workerID, success: false, error: String(exit.cause) }))
}
