import { mkdirSync, writeFileSync } from "node:fs"
import { readFile as readFileBytes } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Egress } from "@arforge-ai/core/egress"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import {
  ASSET_BYTES,
  HTML_RESOURCE,
  HTML_SOURCE,
  action,
  discovery,
  runtimeLayer,
  workspaceLayer,
} from "./asset-localization-crash-contract"

const [databasePath, workspace, rollbackRoot, committedMarker] = Bun.argv.slice(2)
if (!databasePath || !workspace || !rollbackRoot || !committedMarker)
  throw new Error("asset localization SIGKILL worker requires database, workspace, rollback root, and marker")

mkdirSync(join(workspace, "src"), { recursive: true })
writeFileSync(join(workspace, HTML_RESOURCE), HTML_SOURCE, { encoding: "utf8" })

const program = Effect.gen(function* () {
  const service = yield* ActionGateway.Service
  const files = yield* FileMutation.Service
  const artifacts = yield* RollbackArtifact.Service
  const originalRecord = service.recordMutationIntent
  if (!originalRecord) throw new Error("asset localization SIGKILL worker needs mutation intent recording")

  const crashAfterCommit = {
    execute: service.execute,
    recordMutationIntent: (input: Parameters<typeof originalRecord>[0]) =>
      Effect.gen(function* () {
        const recorded = yield* originalRecord(input)
        if (input.phase === "committed") {
          writeFileSync(committedMarker, "committed", { encoding: "utf8", flag: "wx" })
          yield* Effect.never
        }
        return recorded
      }),
  } satisfies Pick<ActionGateway.Interface, "execute" | "recordMutationIntent">

  const readFile = (target: FileMutation.Target) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await readFileBytes(target.canonical)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
      },
      catch: (error) => new Error(`asset fixture read failed: ${String(error)}`),
    })
  const input = {
    gateway: crashAfterCommit,
    worktree: workspace,
    htmlResource: HTML_RESOURCE,
    assetRoot: "vendor",
    action,
    readFile,
    files,
    egress: (capability: ActionGateway.AuthorizationGrantCapability) => {
      const resources = ActionGateway.capabilityRequests(capability).flatMap((request) => request.resources)
      return Egress.make({
        action: AssetLocalizationAction.ACTION_NAME,
        networkScope: resources.filter((resource) => resource.startsWith("http")),
        secretScope: [],
        allowedMethods: ["GET"],
        grantedResources: resources,
      })
    },
    fetchAsset: ({ url, egress }: Parameters<NonNullable<AssetLocalizationAction.AssetLocalizationFetcher>>[0]) =>
      egress.assert({ url, method: "GET" }).pipe(
        Effect.as({ url, contentType: "text/javascript", bytes: new Uint8Array(ASSET_BYTES) }),
      ),
    storeRollbackArtifact: (bytes: Uint8Array) => Effect.promise(() => artifacts.store.put(bytes)),
  } satisfies AssetLocalizationAction.AssetLocalizationActionInput

  yield* AssetLocalizationAction.execute(input)
})

await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(runtimeLayer(databasePath), workspaceLayer(workspace, rollbackRoot))),
  ),
)
