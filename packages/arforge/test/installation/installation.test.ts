import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Installation } from "../../src/installation"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { testEffect } from "../lib/effect"

const previousManifest = process.env.ARFORGE_UPDATE_MANIFEST_URL
const previousMethod = process.env.ARFORGE_INSTALL_METHOD

afterEach(() => {
  if (previousManifest === undefined) delete process.env.ARFORGE_UPDATE_MANIFEST_URL
  else process.env.ARFORGE_UPDATE_MANIFEST_URL = previousManifest
  if (previousMethod === undefined) delete process.env.ARFORGE_INSTALL_METHOD
  else process.env.ARFORGE_INSTALL_METHOD = previousMethod
})

function layer(handler: (url: string) => Response) {
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request.url))),
  )
  return LayerNode.compile(Installation.node, [[httpClient, Layer.succeed(HttpClient.HttpClient, client)]])
}

describe("installation", () => {
  testEffect(
    layer(() => {
      throw new Error("network must not be used")
    }),
  ).effect("stays offline and reports the current version by default", () =>
    Effect.gen(function* () {
      delete process.env.ARFORGE_UPDATE_MANIFEST_URL
      expect(yield* Installation.use.latest()).toBe(InstallationVersion)
    }),
  )

  const calls: string[] = []
  testEffect(
    layer((url) => {
      calls.push(url)
      return Response.json({ version: "2.3.4" })
    }),
  ).effect("reads only an explicitly configured update manifest", () =>
    Effect.gen(function* () {
      process.env.ARFORGE_UPDATE_MANIFEST_URL = "https://updates.example.test/manifest.json"
      expect(yield* Installation.use.latest()).toBe("2.3.4")
      expect(calls).toEqual(["https://updates.example.test/manifest.json"])
    }),
  )

  testEffect(layer(() => Response.json({}))).effect("accepts only known explicitly configured install methods", () =>
    Effect.gen(function* () {
      process.env.ARFORGE_INSTALL_METHOD = "pnpm"
      expect(yield* Installation.use.method()).toBe("pnpm")
      process.env.ARFORGE_INSTALL_METHOD = "untrusted"
      expect(yield* Installation.use.method()).toBe("unknown")
    }),
  )

  testEffect(layer(() => Response.json({}))).effect("fails upgrades without an owned distribution channel", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.message).toContain("disabled")
      expect(error.message).toContain("verified local artifact")
    }),
  )
})
