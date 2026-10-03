import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("Personal Job execution is present in the server OpenAPI contract", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }>>
  }
  expect(spec.paths?.["/api/session/{sessionID}/personal-job/{jobID}/execute"]?.post?.operationId).toBe(
    "v2.personalJob.execute",
  )
  expect(spec.paths?.["/api/session/{sessionID}/personal-job/dispatch"]?.post?.operationId).toBe(
    "v2.personalJob.dispatch",
  )
})
