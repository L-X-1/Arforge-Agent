import { Billing } from "./billing"
import { NonNegativeInt, PositiveInt, optional } from "./schema"
import { Schema } from "effect"

export const TenantID = Schema.String.check(Schema.isPattern(/^ten_[A-Za-z0-9_-]{1,120}$/)).annotate({
  identifier: "TenantPlatform.TenantID",
})
export type TenantID = typeof TenantID.Type

export const UserID = Schema.String.check(Schema.isPattern(/^usr_[A-Za-z0-9_-]{1,120}$/)).annotate({
  identifier: "TenantPlatform.UserID",
})
export type UserID = typeof UserID.Type

export const ProjectID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)).annotate({
  identifier: "TenantPlatform.ProjectID",
})
export type ProjectID = typeof ProjectID.Type

export const TenantRole = Schema.Literals(["owner", "admin", "member"])
export type TenantRole = typeof TenantRole.Type

export const DataRequestKind = Schema.Literals(["tenant-export", "tenant-delete"])
export type DataRequestKind = typeof DataRequestKind.Type

export const DataRequestStatus = Schema.Literals([
  "requested",
  "approved",
  "executing",
  "completed",
  "rejected",
  "failed",
])
export type DataRequestStatus = typeof DataRequestStatus.Type

export const PlatformPolicy = Schema.Struct({
  schema_version: Schema.Literal(1),
  tenant_id: TenantID,
  region: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  retention_days: PositiveInt.check(Schema.isLessThanOrEqualTo(3_650)),
  quota: Schema.Struct({
    currency: Billing.Currency,
    limit_minor: optional(NonNegativeInt),
  }),
  rate_limit: Schema.Struct({
    requests_per_minute: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000_000)),
    burst: PositiveInt.check(Schema.isLessThanOrEqualTo(100_000)),
  }),
  key_version: PositiveInt,
  revision: PositiveInt,
  updated_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
}).annotate({ identifier: "TenantPlatform.PlatformPolicy" })
export interface PlatformPolicy extends Schema.Schema.Type<typeof PlatformPolicy> {}

export const SecretMetadata = Schema.Struct({
  tenant_id: TenantID,
  secret_id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  key_version: PositiveInt,
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  status: Schema.Literals(["active", "revoked"]),
  created_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  revoked_at: optional(Schema.String),
}).annotate({ identifier: "TenantPlatform.SecretMetadata" })
export interface SecretMetadata extends Schema.Schema.Type<typeof SecretMetadata> {}

export const SettledUsage = Schema.Struct({
  settlement_id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  tenant_id: TenantID,
  owner_user_id: UserID,
  run_id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  currency: Billing.Currency,
  amount_minor: NonNegativeInt,
  recorded_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  source: Schema.Literal("settled-runtime-usage"),
}).annotate({ identifier: "TenantPlatform.SettledUsage" })
export interface SettledUsage extends Schema.Schema.Type<typeof SettledUsage> {}

export const UsageSummary = Schema.Struct({
  tenant_id: TenantID,
  currency: Billing.Currency,
  settled_amount_minor: NonNegativeInt,
  settled_records: NonNegativeInt,
  source: Schema.Literal("settled-runtime-usage"),
}).annotate({ identifier: "TenantPlatform.UsageSummary" })
export interface UsageSummary extends Schema.Schema.Type<typeof UsageSummary> {}

export const DataRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^tdr_[A-Za-z0-9_-]{1,120}$/)),
  tenant_id: TenantID,
  kind: DataRequestKind,
  status: DataRequestStatus,
  requested_by: UserID,
  approved_by: optional(UserID),
  reason: Schema.String.check(Schema.isMaxLength(1_000)),
  request_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  requested_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  completed_at: optional(Schema.String),
}).annotate({ identifier: "TenantPlatform.DataRequest" })
export interface DataRequest extends Schema.Schema.Type<typeof DataRequest> {}

export const BackupManifest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^tbk_[A-Za-z0-9_-]{1,120}$/)),
  tenant_id: TenantID,
  region: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  schema_revision: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  artifact_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  status: Schema.Literals(["created", "verified", "restored", "failed"]),
  created_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  verified_at: optional(Schema.String),
}).annotate({ identifier: "TenantPlatform.BackupManifest" })
export interface BackupManifest extends Schema.Schema.Type<typeof BackupManifest> {}

export const AuditExport = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^tae_[A-Za-z0-9_-]{1,120}$/)),
  tenant_id: TenantID,
  requested_by: UserID,
  item_count: NonNegativeInt,
  export_digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  created_at: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  artifact_filename: Schema.String.check(Schema.isPattern(/^arforge-tenant-audit-tae_[A-Za-z0-9_-]{1,120}\.json$/)),
  artifact_media_type: Schema.Literal("application/json"),
  artifact_json: Schema.String.check(Schema.isNonEmpty()),
}).annotate({ identifier: "TenantPlatform.AuditExport" })
export interface AuditExport extends Schema.Schema.Type<typeof AuditExport> {}

export const PlatformOverview = Schema.Struct({
  schema_version: Schema.Literal(1),
  policy: PlatformPolicy,
  usage: UsageSummary,
  active_rate_window_count: NonNegativeInt,
  pending_requests: NonNegativeInt,
}).annotate({ identifier: "TenantPlatform.PlatformOverview" })
export interface PlatformOverview extends Schema.Schema.Type<typeof PlatformOverview> {}
