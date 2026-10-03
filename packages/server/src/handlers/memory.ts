import { MemoryV2 } from "@arforge-ai/core/memory"
import * as MemoryKernel from "@arforge-ai/core/memory-kernel"
import * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"
import { ConflictError, InvalidRequestError, MemoryNotFoundError } from "@arforge-ai/protocol/errors"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { IdentityContext } from "../identity-context"

const projectCandidateReview = (review: MemoryKernel.CandidateReview): MemoryCandidate.Review => {
  const candidate = review.candidate
  const blockedReasons = MemoryKernel.candidateApprovalBlocks(candidate)
  const contentRedacted = candidate.sensitivity === "secret"
  return MemoryCandidate.Review.make({
    candidateID: candidate.candidateID,
    proposedClass: candidate.proposedClass,
    ...(contentRedacted ? {} : { content: candidate.content }),
    contentRedacted,
    sourceEvidenceIDs: candidate.sourceEvidenceIDs,
    scope: candidate.scope,
    sensitivity: candidate.sensitivity,
    confidence: candidate.confidence,
    dedup: candidate.dedup,
    retention: candidate.retention,
    proposer: candidate.proposer,
    policy: candidate.policy,
    status: candidate.status,
    reason: candidate.reason,
    time: candidate.time,
    approvalAllowed: blockedReasons.length === 0,
    activationAllowed: MemoryCandidate.isActivationEligible(candidate),
    blockedReasons,
    audit: review.audit,
  })
}

const candidateError = (error: MemoryKernel.GateError) =>
  new InvalidRequestError({ field: "memoryCandidate", message: error.reason })

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  handlers
    .handle(
      "memory.list",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.list({
            ...ctx.query,
            includeGlobal: ctx.query.includeGlobal !== "false",
          }),
        }
      }),
    )
    .handle(
      "memory.create",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.create(ctx.payload).pipe(
            Effect.catchTag(
              "Memory.DuplicateError",
              (error) =>
                new ConflictError({
                  resource: error.memoryID,
                  message: `A near-duplicate memory already exists (${error.similarity.toFixed(3)} similarity).`,
                }),
            ),
            Effect.catchTag(
              "Memory.InvalidScopeError",
              (error) => new InvalidRequestError({ field: "scope", message: error.message }),
            ),
            Effect.catchTag(
              "Memory.GovernanceError",
              (error) => new InvalidRequestError({ field: "governance", message: error.message }),
            ),
          ),
        }
      }),
    )
    .handle(
      "memory.get",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.get(ctx.params.memoryID).pipe(
            Effect.catchTag(
              "Memory.NotFoundError",
              (error) =>
                new MemoryNotFoundError({
                  memoryID: error.memoryID,
                  message: `Memory not found in the current workspace scope: ${error.memoryID}`,
                }),
            ),
          ),
        }
      }),
    )
    .handle(
      "memory.update",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.update({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTag(
              "Memory.DuplicateError",
              (error) =>
                new ConflictError({
                  resource: error.memoryID,
                  message: `A near-duplicate memory already exists (${error.similarity.toFixed(3)} similarity).`,
                }),
            ),
            Effect.catchTag(
              "Memory.InvalidScopeError",
              (error) => new InvalidRequestError({ field: "scope", message: error.message }),
            ),
            Effect.catchTag(
              "Memory.GovernanceError",
              (error) => new InvalidRequestError({ field: "governance", message: error.message }),
            ),
            Effect.catchTag(
              "Memory.NotFoundError",
              (error) =>
                new MemoryNotFoundError({
                  memoryID: error.memoryID,
                  message: `Memory not found in the current workspace scope: ${error.memoryID}`,
                }),
            ),
          ),
        }
      }),
    )
    .handle(
      "memory.correct",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.correct({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTag(
              "Memory.DuplicateError",
              (error) =>
                new ConflictError({
                  resource: error.memoryID,
                  message: `A near-duplicate memory already exists (${error.similarity.toFixed(3)} similarity).`,
                }),
            ),
            Effect.catchTag(
              "Memory.NotFoundError",
              (error) =>
                new MemoryNotFoundError({
                  memoryID: error.memoryID,
                  message: `Memory not found in the current workspace scope: ${error.memoryID}`,
                }),
            ),
            Effect.catchTag(
              "Memory.CorrectionConflictError",
              (error) => new ConflictError({ resource: error.resource, message: error.message }),
            ),
            Effect.catchTag(
              "Memory.GovernanceError",
              (error) => new InvalidRequestError({ field: "governance", message: error.message }),
            ),
          ),
        }
      }),
    )
    .handle(
      "memory.correctionHistory",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.correctionHistory(ctx.params.memoryID).pipe(
            Effect.catchTag(
              "Memory.NotFoundError",
              (error) =>
                new MemoryNotFoundError({
                  memoryID: error.memoryID,
                  message: `Memory not found in the current workspace scope: ${error.memoryID}`,
                }),
            ),
          ),
        }
      }),
    )
    .handle(
      "memory.undoCorrection",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.undoCorrection({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTags({
              "Memory.CorrectionNotFoundError": (error) =>
                new ConflictError({
                  resource: error.correctionID,
                  message: `Memory correction not found: ${error.correctionID}`,
                }),
              "Memory.CorrectionConflictError": (error) =>
                new ConflictError({ resource: error.resource, message: error.message }),
            }),
          ),
        }
      }),
    )
    .handle(
      "memory.conflictList",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* MemoryV2.Service).conflictList({
            includeClosed: ctx.query.includeClosed === "true",
            limit: ctx.query.limit,
          }),
        }
      }),
    )
    .handle(
      "memory.conflictScan",
      Effect.fn(function* (ctx) {
        return { data: yield* (yield* MemoryV2.Service).conflictScan(ctx.payload) }
      }),
    )
    .handle(
      "memory.resolveConflict",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* MemoryV2.Service).resolveConflict({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTags({
              "Memory.ConflictNotFoundError": (error) =>
                new ConflictError({ resource: error.conflictID, message: "Memory conflict not found." }),
              "Memory.ConflictDecisionError": (error) =>
                new ConflictError({ resource: error.resource, message: error.message }),
            }),
          ),
        }
      }),
    )
    .handle(
      "memory.dismissConflict",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* MemoryV2.Service).dismissConflict({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTags({
              "Memory.ConflictNotFoundError": (error) =>
                new ConflictError({ resource: error.conflictID, message: "Memory conflict not found." }),
              "Memory.ConflictDecisionError": (error) =>
                new ConflictError({ resource: error.resource, message: error.message }),
            }),
          ),
        }
      }),
    )
    .handle(
      "memory.undoConflict",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* MemoryV2.Service).undoConflict({ ...ctx.params, ...ctx.payload }).pipe(
            Effect.catchTags({
              "Memory.ConflictNotFoundError": (error) =>
                new ConflictError({ resource: error.conflictID, message: "Memory conflict not found." }),
              "Memory.ConflictDecisionError": (error) =>
                new ConflictError({ resource: error.resource, message: error.message }),
            }),
          ),
        }
      }),
    )
    .handle(
      "memory.candidateReview",
      Effect.fn(function* (ctx) {
        const kernel = yield* MemoryKernel.Service
        return {
          data: yield* kernel
            .reviewCandidate(ctx.params.candidateID)
            .pipe(Effect.map(projectCandidateReview), Effect.catchTag("MemoryKernel.GateError", candidateError)),
        }
      }),
    )
    .handle(
      "memory.candidateApprove",
      Effect.fn(function* (ctx) {
        const kernel = yield* MemoryKernel.Service
        yield* kernel
          .approve({
            candidateID: ctx.params.candidateID,
            actor: { kind: "user" },
            policyVersion: MemoryKernel.POLICY_VERSION,
            expectedUpdatedAt: ctx.payload.expectedUpdatedAt,
            reason: ctx.payload.reason,
          })
          .pipe(Effect.catchTag("MemoryKernel.GateError", candidateError))
        return {
          data: yield* kernel
            .reviewCandidate(ctx.params.candidateID)
            .pipe(Effect.map(projectCandidateReview), Effect.catchTag("MemoryKernel.GateError", candidateError)),
        }
      }),
    )
    .handle(
      "memory.candidateReject",
      Effect.fn(function* (ctx) {
        const kernel = yield* MemoryKernel.Service
        yield* kernel
          .reject({
            candidateID: ctx.params.candidateID,
            actor: { kind: "user" },
            policyVersion: MemoryKernel.POLICY_VERSION,
            expectedUpdatedAt: ctx.payload.expectedUpdatedAt,
            reason: ctx.payload.reason,
          })
          .pipe(Effect.catchTag("MemoryKernel.GateError", candidateError))
        return {
          data: yield* kernel
            .reviewCandidate(ctx.params.candidateID)
            .pipe(Effect.map(projectCandidateReview), Effect.catchTag("MemoryKernel.GateError", candidateError)),
        }
      }),
    )
    .handle(
      "memory.candidateActivate",
      Effect.fn(function* (ctx) {
        const kernel = yield* MemoryKernel.Service
        yield* kernel
          .promote({
            candidateID: ctx.params.candidateID,
            actor: { kind: "user" },
            policyVersion: MemoryKernel.POLICY_VERSION,
            expectedUpdatedAt: ctx.payload.expectedUpdatedAt,
            reason: ctx.payload.reason,
            evidenceIDs: [],
          })
          .pipe(Effect.catchTag("MemoryKernel.GateError", candidateError))
        return {
          data: yield* kernel
            .reviewCandidate(ctx.params.candidateID)
            .pipe(Effect.map(projectCandidateReview), Effect.catchTag("MemoryKernel.GateError", candidateError)),
        }
      }),
    )
    .handle(
      "memory.maintenanceDelete",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        const principal = yield* Effect.serviceOption(IdentityContext.Current)
        if (Option.isNone(principal) || !["owner", "admin"].includes(principal.value.role))
          return yield* new InvalidRequestError({
            field: "maintenanceAuthorization",
            message: "Memory deletion requires an authenticated owner/admin maintenance authority.",
          })
        yield* memory
          .maintenanceDelete({
            memoryID: ctx.params.memoryID,
            ...ctx.payload,
            actor: "maintenance",
            maintenanceAuthority: true,
            explicitDestructive: true,
          })
          .pipe(
            Effect.catchTag(
              "Memory.GovernanceError",
              (error) => new InvalidRequestError({ field: "maintenanceAuthorization", message: error.message }),
            ),
          )
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "memory.maintenanceDeleteMany",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        const principal = yield* Effect.serviceOption(IdentityContext.Current)
        if (Option.isNone(principal) || !["owner", "admin"].includes(principal.value.role))
          return yield* new InvalidRequestError({
            field: "maintenanceAuthorization",
            message: "Memory deletion requires an authenticated owner/admin maintenance authority.",
          })
        return {
          data: yield* memory
            .maintenanceDeleteMany(
              ctx.payload.items.map((item) => ({
                ...item,
                actor: "maintenance" as const,
                maintenanceAuthority: true as const,
                explicitDestructive: true as const,
              })),
            )
            .pipe(
              Effect.catchTag(
                "Memory.DeleteLimitError",
                (error) =>
                  new InvalidRequestError({ field: "ids", message: `At most ${error.limit} IDs are allowed.` }),
              ),
              Effect.catchTag(
                "Memory.GovernanceError",
                (error) => new InvalidRequestError({ field: "maintenanceAuthorization", message: error.message }),
              ),
            ),
        }
      }),
    )
    .handle(
      "memory.semantic",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory.semantic({
            ...ctx.query,
            includeGlobal: ctx.query.includeGlobal !== "false",
          }),
        }
      }),
    )
    .handle(
      "memory.facets",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return { data: yield* memory.facets(ctx.query.includeGlobal !== "false") }
      }),
    )
    .handle(
      "memory.status",
      Effect.fn(function* () {
        return { data: yield* (yield* MemoryV2.Service).status() }
      }),
    )
    .handle(
      "memory.recallQuality",
      Effect.fn(function* () {
        return { data: yield* (yield* MemoryV2.Service).recallQuality() }
      }),
    )
    .handle(
      "memory.governancePreview",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* MemoryV2.Service).governancePreview({
            scanLimit: ctx.query.scanLimit,
            sampleLimit: ctx.query.sampleLimit,
          }),
        }
      }),
    )
    .handle(
      "memory.governanceApply",
      Effect.fn(function* (ctx) {
        return { data: yield* (yield* MemoryV2.Service).governanceApply(ctx.payload.scanLimit) }
      }),
    ),
)
