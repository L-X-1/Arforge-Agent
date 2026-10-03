import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

test("Memory Candidate review lifecycle is present in the server OpenAPI contract", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }>>
  }
  const item = spec.paths?.["/api/memory/candidates/{candidateID}"]
  expect(item?.get?.operationId).toBe("server.memory.memory.candidateReview")
  expect(spec.paths?.["/api/memory/candidates/{candidateID}/approve"]?.post?.operationId).toBe(
    "server.memory.memory.candidateApprove",
  )
  expect(spec.paths?.["/api/memory/candidates/{candidateID}/reject"]?.post?.operationId).toBe(
    "server.memory.memory.candidateReject",
  )
  expect(spec.paths?.["/api/memory/candidates/{candidateID}/activate"]?.post?.operationId).toBe(
    "server.memory.memory.candidateActivate",
  )
})
