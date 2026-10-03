import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("Personal Workspace remains a read-only safe projection in the server contract", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }> | undefined>
  }
  const item = spec.paths?.["/api/personal-workspace"]

  expect(item?.get?.operationId).toBe("v2.personalWorkspace.snapshot")
  expect(item?.post).toBeUndefined()
  expect(item?.put).toBeUndefined()
  expect(item?.patch).toBeUndefined()
  expect(item?.delete).toBeUndefined()
})
