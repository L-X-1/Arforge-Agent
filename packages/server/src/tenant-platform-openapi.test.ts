import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "./api"

const expected = {
  "/api/tenant-platform/overview": ["get", "server.tenantPlatform.tenantPlatform.overview"],
  "/api/tenant-platform/policy": ["post", "server.tenantPlatform.tenantPlatform.setPolicy"],
  "/api/tenant-platform/data-requests": ["post", "server.tenantPlatform.tenantPlatform.requestData"],
  "/api/tenant-platform/data-requests/{requestID}/approval": [
    "post",
    "server.tenantPlatform.tenantPlatform.approveData",
  ],
  "/api/tenant-platform/backups": ["post", "server.tenantPlatform.tenantPlatform.createBackup"],
  "/api/tenant-platform/backups/{manifestID}/verify": ["post", "server.tenantPlatform.tenantPlatform.verifyBackup"],
  "/api/tenant-platform/audit/export": ["post", "server.tenantPlatform.tenantPlatform.exportAudit"],
  "/api/tenant-platform/secrets": ["get", "server.tenantPlatform.tenantPlatform.listSecrets"],
  "/api/tenant-platform/secrets/{secretID}/revoke": ["post", "server.tenantPlatform.tenantPlatform.revokeSecret"],
} as const

test("TenantPlatform protocol is present in the server OpenAPI contract", () => {
  const spec = OpenApi.fromApi(Api) as {
    paths?: Record<string, Record<string, { operationId?: string }>>
    components?: {
      schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>
    }
  }

  const actual = Object.fromEntries(
    Object.entries(expected).map(([path, [method, operationId]]) => [
      path,
      [method, spec.paths?.[path]?.[method]?.operationId],
    ]),
  )
  expect(actual).toEqual(
    Object.fromEntries(Object.entries(expected).map(([path, [method, operationId]]) => [path, [method, operationId]])),
  )
  const auditExport = spec.components?.schemas?.["TenantPlatform.AuditExport"]
  const artifactFields = ["artifact_filename", "artifact_media_type", "artifact_json"]
  expect(Object.keys(auditExport?.properties ?? {})).toEqual(expect.arrayContaining(artifactFields))
  expect(auditExport?.required).toEqual(expect.arrayContaining(artifactFields))
})
