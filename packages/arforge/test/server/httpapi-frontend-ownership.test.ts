import { expect, test } from "bun:test"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { OpenApi } from "effect/unstable/httpapi"
import {
  LEGACY_HTTP_FRONTEND_OWNERSHIP,
  legacyHttpOperations,
  legacyHttpOwnership,
} from "../../src/server/frontend-ownership"
import "./httpapi-exercise/environment"
import { runtime } from "./httpapi-exercise/runtime"

const root = resolve(import.meta.dir, "../../../..")
const methods = ["get", "post", "put", "patch", "delete"] as const

test(
  "assigns every compatibility SDK route to exactly one Scheme B frontend owner",
  async () => {
    const modules = await runtime()
    const spec = OpenApi.fromApi(modules.PublicApi)
    const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      methods.flatMap((method) => {
        const route = item[method]
        if (!route || path.startsWith("/api/")) return []
        if (!route.operationId)
          throw new Error(`${method.toUpperCase()} ${path} has no operationId`)
        return [route.operationId]
      }),
    )
    const mapped = legacyHttpOperations()

    expect(operations.length).toBe(131)
    expect(new Set(operations).size).toBe(operations.length)
    expect(mapped.length).toBe(operations.length)
    expect(new Set(mapped).size).toBe(mapped.length)
    expect(mapped.filter((operation) => !operations.includes(operation))).toEqual([])
    expect(operations.filter((operation) => !legacyHttpOwnership(operation))).toEqual([])

    const evidence = new Set(
      LEGACY_HTTP_FRONTEND_OWNERSHIP.flatMap((ownership) => ownership.evidence),
    )
    for (const path of evidence) await access(resolve(root, path))
  },
  15_000,
)
