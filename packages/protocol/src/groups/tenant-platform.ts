import * as TenantPlatform from "@arforge-ai/schema/tenant-platform"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"

const PolicyPayload = Schema.Struct({
  region: TenantPlatform.PlatformPolicy.fields.region,
  retention_days: TenantPlatform.PlatformPolicy.fields.retention_days,
  quota: TenantPlatform.PlatformPolicy.fields.quota,
  rate_limit: TenantPlatform.PlatformPolicy.fields.rate_limit,
  key_version: TenantPlatform.PlatformPolicy.fields.key_version,
})

export const TenantPlatformGroup = HttpApiGroup.make("server.tenantPlatform")
  .add(
    HttpApiEndpoint.get("tenantPlatform.overview", "/api/tenant-platform/overview", {
      success: TenantPlatform.PlatformOverview,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.setPolicy", "/api/tenant-platform/policy", {
      payload: PolicyPayload,
      success: TenantPlatform.PlatformPolicy,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.requestData", "/api/tenant-platform/data-requests", {
      payload: Schema.Struct({
        kind: TenantPlatform.DataRequest.fields.kind,
        reason: Schema.String.check(Schema.isMaxLength(1_000)),
      }),
      success: TenantPlatform.DataRequest,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.approveData", "/api/tenant-platform/data-requests/:requestID/approval", {
      params: { requestID: TenantPlatform.DataRequest.fields.id },
      payload: Schema.Struct({ approve: Schema.Boolean }),
      success: TenantPlatform.DataRequest,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.createBackup", "/api/tenant-platform/backups", {
      payload: Schema.Struct({
        region: TenantPlatform.BackupManifest.fields.region,
        schema_revision: TenantPlatform.BackupManifest.fields.schema_revision,
        artifact_digest: TenantPlatform.BackupManifest.fields.artifact_digest,
      }),
      success: TenantPlatform.BackupManifest,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.verifyBackup", "/api/tenant-platform/backups/:manifestID/verify", {
      params: { manifestID: TenantPlatform.BackupManifest.fields.id },
      payload: Schema.Struct({ artifact_digest: TenantPlatform.BackupManifest.fields.artifact_digest }),
      success: TenantPlatform.BackupManifest,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.exportAudit", "/api/tenant-platform/audit/export", {
      success: TenantPlatform.AuditExport,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.get("tenantPlatform.listSecrets", "/api/tenant-platform/secrets", {
      success: Schema.Array(TenantPlatform.SecretMetadata),
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .add(
    HttpApiEndpoint.post("tenantPlatform.revokeSecret", "/api/tenant-platform/secrets/:secretID/revoke", {
      params: { secretID: TenantPlatform.SecretMetadata.fields.secret_id },
      success: TenantPlatform.SecretMetadata,
      error: [InvalidRequestError, ServiceUnavailableError],
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "tenant platform",
      description:
        "Tenant-scoped policy, settled usage, encrypted secret metadata, data requests, backup manifests, and downloadable audit artifacts with durable receipts.",
    }),
  )
