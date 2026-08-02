import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context } from "effect"
import { serviceUse } from "@arforge-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeRuntime } from "@arforge-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@arforge-ai/core/installation/version"
import { InstallationEvent } from "@arforge-ai/schema/installation-event"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `arforge/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

const UpdateManifest = Schema.Struct({ version: Schema.String })
const methods = new Set<Method>(["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"])

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/Installation") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        const configured = process.env.ARFORGE_INSTALL_METHOD?.trim() as Method | undefined
        return configured && methods.has(configured) ? configured : "unknown"
      }),
      latest: Effect.fn("Installation.latest")(function* () {
        const url = process.env.ARFORGE_UPDATE_MANIFEST_URL?.trim()
        if (!url) return InstallationVersion
        const response = yield* http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson))
        return yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(UpdateManifest)),
          Effect.map((manifest) => manifest.version),
        )
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* () {
        return yield* new UpgradeFailedError({
          stderr:
            "Automatic upgrades are disabled because no Arforge-owned distribution channel is configured. Build from source or install a verified local artifact.",
        })
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [httpClient] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
