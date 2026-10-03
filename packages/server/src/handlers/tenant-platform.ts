import * as TenantPlatform from "@arforge-ai/core/tenant-platform"
import { IdentityContext } from "../identity-context"
import { InvalidRequestError, ServiceUnavailableError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const platformError = (error: unknown) => {
  if (typeof error !== "object" || error === null)
    return new ServiceUnavailableError({ message: "tenant platform service unavailable", service: "tenant-platform" })
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "TenantPlatform.Error"
  const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined
  const detail =
    reason ??
    (tag === "TenantPlatform.QuotaExceededError" &&
      "limitMinor" in error &&
      "projectedMinor" in error &&
      typeof error.limitMinor === "number" &&
      typeof error.projectedMinor === "number"
      ? `tenant quota exceeded: projected ${error.projectedMinor} > limit ${error.limitMinor}`
      : undefined) ??
    ("resource" in error && typeof error.resource === "string" ? `${error.resource} was not found` : undefined) ??
    ("retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number"
      ? `tenant rate limit exceeded; retry after ${error.retryAfterSeconds}s`
      : undefined) ??
    ("message" in error && typeof error.message === "string" ? error.message : "tenant platform operation rejected")
  if (tag.startsWith("SecretProvider."))
    return new ServiceUnavailableError({ message: "tenant secret provider unavailable", service: "tenant-secret-provider" })
  return new InvalidRequestError({ kind: tag.toLowerCase().replaceAll(".", "-"), message: detail })
}

const principal = (value: IdentityContext.Principal): TenantPlatform.Principal => ({
  tenantID: value.tenantID,
  userID: value.userID,
  role: value.role,
})

const guarded = <A>(
  service: TenantPlatform.Interface,
  value: TenantPlatform.Principal,
  effect: Effect.Effect<A, unknown>,
) =>
  Effect.gen(function* () {
    yield* service.consumeRate(value, { bucket: "tenant-platform" })
    return yield* effect
  }).pipe(Effect.mapError(platformError))

export const TenantPlatformHandler = HttpApiBuilder.group(Api, "server.tenantPlatform", (handlers) =>
  handlers
    .handle(
      "tenantPlatform.overview",
      Effect.fn(function* () {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.overview(value))
      }),
    )
    .handle(
      "tenantPlatform.setPolicy",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.setPolicy(value, ctx.payload))
      }),
    )
    .handle(
      "tenantPlatform.requestData",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.requestData(value, ctx.payload))
      }),
    )
    .handle(
      "tenantPlatform.approveData",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(
          service,
          value,
          service.approveData(value, {
            requestID: ctx.params.requestID,
            approve: ctx.payload.approve,
          }),
        )
      }),
    )
    .handle(
      "tenantPlatform.createBackup",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(
          service,
          value,
          service.createBackup(value, {
            region: ctx.payload.region,
            schemaRevision: ctx.payload.schema_revision,
            artifactDigest: ctx.payload.artifact_digest,
          }),
        )
      }),
    )
    .handle(
      "tenantPlatform.verifyBackup",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(
          service,
          value,
          service.verifyBackup(value, {
            manifestID: ctx.params.manifestID,
            artifactDigest: ctx.payload.artifact_digest,
          }),
        )
      }),
    )
    .handle(
      "tenantPlatform.exportAudit",
      Effect.fn(function* () {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.exportAudit(value))
      }),
    )
    .handle(
      "tenantPlatform.listSecrets",
      Effect.fn(function* () {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.listSecretMetadata(value))
      }),
    )
    .handle(
      "tenantPlatform.revokeSecret",
      Effect.fn(function* (ctx) {
        const service = yield* TenantPlatform.Service
        const value = principal(yield* IdentityContext.Current)
        return yield* guarded(service, value, service.revokeSecret(value, { secretID: ctx.params.secretID }))
      }),
    ),
)
