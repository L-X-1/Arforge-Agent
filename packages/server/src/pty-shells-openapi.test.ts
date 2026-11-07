import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("available shells use their own static location-scoped v2 route", () => {
  const spec = OpenApi.fromApi(Api)
  const operation = spec.paths?.["/api/pty/shells"]?.get
  expect(operation?.operationId).toBe("v2.pty.shells")
  expect(operation?.responses?.["200"]).toBeDefined()
  expect(spec.paths?.["/api/pty/{ptyID}"]?.get).toBeDefined()
})
