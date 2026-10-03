import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"
import {
  ARTIFACT_READ_MAX_BYTES,
  ARTIFACT_READ_MAX_REQUESTS,
  ARTIFACT_READ_WINDOW_MS,
  admitArtifactRead,
} from "./artifact-read-guard"

test("artifact read admission bounds requests and bytes per authenticated session", () => {
  const identity = { tenantID: "ten_test", userID: "usr_test", sessionID: "ses_test" }
  const start = 10_000
  expect(admitArtifactRead({ ...identity, bytes: ARTIFACT_READ_MAX_BYTES, now: start }).allowed).toBe(true)
  expect(admitArtifactRead({ ...identity, bytes: 1, now: start }).allowed).toBe(false)

  const requestIdentity = { tenantID: "ten_test", userID: "usr_test", sessionID: "ses_requests" }
  for (let index = 0; index < ARTIFACT_READ_MAX_REQUESTS; index++) {
    expect(admitArtifactRead({ ...requestIdentity, bytes: 0, now: start }).allowed).toBe(true)
  }
  const limited = admitArtifactRead({ ...requestIdentity, bytes: 0, now: start })
  expect(limited.allowed).toBe(false)
  expect(limited.retryAfterSeconds).toBeGreaterThan(0)
  expect(admitArtifactRead({ ...requestIdentity, bytes: 0, now: start + ARTIFACT_READ_WINDOW_MS }).allowed).toBe(true)
})

test("artifact reads expose full and bounded session/profile/tenant routes in OpenAPI", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }> | undefined>
  }

  expect(spec.paths?.["/api/session/{sessionID}/artifacts/read"]?.post?.operationId).toBe("v2.artifact.read")
  expect(spec.paths?.["/api/session/{sessionID}/artifacts/read-range"]?.post?.operationId).toBe("v2.artifact.readRange")
  expect(spec.paths?.["/api/session/{sessionID}/artifacts/catalog"]?.post?.operationId).toBe("v2.artifact.catalog")
  expect(spec.paths?.["/api/session/{sessionID}/artifacts/audit"]?.post?.operationId).toBe("v2.artifact.audit")
  expect(spec.paths?.["/api/artifacts/read"]?.post?.operationId).toBe("v2.artifact.readScoped")
  expect(spec.paths?.["/api/artifacts/read-range"]?.post?.operationId).toBe("v2.artifact.readScopedRange")
  expect(spec.paths?.["/api/artifacts/owner-context"]?.get?.operationId).toBe("v2.artifact.ownerContext")
  expect(spec.paths?.["/api/artifacts/maintenance-context"]?.get?.operationId).toBe("v2.artifact.maintenanceContext")
  expect(spec.paths?.["/api/artifacts/catalog"]?.post?.operationId).toBe("v2.artifact.catalogScoped")
  expect(spec.paths?.["/api/artifacts/audit"]?.post?.operationId).toBe("v2.artifact.auditScoped")
  expect(spec.paths?.["/api/session/{sessionID}/artifacts/read"]?.get).toBeUndefined()
  expect(spec.paths?.["/api/session/{sessionID}/artifacts/read-range"]?.get).toBeUndefined()
  expect(spec.paths?.["/api/artifacts/read"]?.get).toBeUndefined()
  expect(spec.paths?.["/api/artifacts/read-range"]?.get).toBeUndefined()
  expect(spec.paths?.["/api/artifacts/owner-context"]?.post).toBeUndefined()
})
