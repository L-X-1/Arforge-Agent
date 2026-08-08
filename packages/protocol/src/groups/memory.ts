import { Memory } from "@arforge-ai/schema/memory"
import { NonNegativeInt, PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, MemoryNotFoundError } from "../errors"
import { locationQueryOpenApi } from "./location"

const root = "/api/memory"
const item = `${root}/:memoryID`
const mutationErrors = [ConflictError, InvalidRequestError]
const location = {
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}

export const makeMemoryGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.memory")
    .add(
      HttpApiEndpoint.get("memory.list", root, {
        query: {
          ...location,
          query: Schema.String.pipe(Schema.optional),
          type: Memory.Type.pipe(Schema.optional),
          tag: Memory.Tag.pipe(Schema.optional),
          source: Memory.Source.pipe(Schema.optional),
          minimumImportance: Memory.Importance.pipe(Schema.optional),
          includeGlobal: Schema.Literals(["true", "false"]).pipe(Schema.optional),
          limit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Memory.Page }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.create", root, {
        payload: Schema.Struct({
          content: Memory.Content,
          type: Memory.Type.pipe(Schema.optional),
          tags: Memory.Tags.pipe(Schema.optional),
          importance: Memory.Importance.pipe(Schema.optional),
          source: Memory.Source.pipe(Schema.optional),
          scope: Memory.Scope.pipe(Schema.optional),
          relatedTo: Memory.ID.pipe(Schema.optional),
          strength: Memory.Strength.pipe(Schema.optional),
          reviewLevel: Memory.ReviewLevel.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Memory.Info }),
        error: mutationErrors,
        query: location,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.get", item, {
        params: { memoryID: Memory.ID },
        query: location,
        success: Schema.Struct({ data: Memory.Info }),
        error: MemoryNotFoundError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.patch("memory.update", item, {
        params: { memoryID: Memory.ID },
        query: location,
        payload: Schema.Struct({
          content: Memory.Content.pipe(Schema.optional),
          type: Memory.Type.pipe(Schema.optional),
          tags: Memory.Tags.pipe(Schema.optional),
          source: Memory.Source.pipe(Schema.optional),
          importance: Memory.Importance.pipe(Schema.optional),
          strength: Memory.Strength.pipe(Schema.optional),
          reviewLevel: Memory.ReviewLevel.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Memory.Info }),
        error: [...mutationErrors, MemoryNotFoundError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.correct", `${item}/correct`, {
        params: { memoryID: Memory.ID },
        query: location,
        payload: Schema.Struct({
          content: Memory.Content,
          reason: Memory.CorrectionReason,
          expectedUpdatedAt: NonNegativeInt,
        }),
        success: Schema.Struct({ data: Memory.CorrectionResult }),
        error: [...mutationErrors, MemoryNotFoundError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.correctionHistory", `${item}/corrections`, {
        params: { memoryID: Memory.ID },
        query: location,
        success: Schema.Struct({ data: Memory.CorrectionHistory }),
        error: MemoryNotFoundError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.undoCorrection", `${root}/corrections/:correctionID/undo`, {
        params: { correctionID: Memory.CorrectionID },
        query: location,
        payload: Schema.Struct({ expectedSuccessorUpdatedAt: NonNegativeInt }),
        success: Schema.Struct({ data: Memory.CorrectionResult }),
        error: ConflictError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.conflictList", `${root}/conflicts`, {
        query: {
          ...location,
          includeClosed: Schema.Literals(["true", "false"]).pipe(Schema.optional),
          limit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Memory.ConflictPage }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.conflictScan", `${root}/conflicts/scan`, {
        query: location,
        payload: Schema.Struct({
          scanLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000)).pipe(Schema.optional),
          resultLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Memory.ConflictPage }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.resolveConflict", `${root}/conflicts/:conflictID/resolve`, {
        params: { conflictID: Memory.ConflictID },
        query: location,
        payload: Schema.Struct({
          chosenMemoryID: Memory.ID,
          reason: Memory.ConflictReason,
          expectedLeftUpdatedAt: NonNegativeInt,
          expectedRightUpdatedAt: NonNegativeInt,
        }),
        success: Schema.Struct({ data: Memory.ConflictDecisionResult }),
        error: ConflictError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.dismissConflict", `${root}/conflicts/:conflictID/dismiss`, {
        params: { conflictID: Memory.ConflictID },
        query: location,
        payload: Schema.Struct({
          reason: Memory.ConflictReason,
          expectedLeftUpdatedAt: NonNegativeInt,
          expectedRightUpdatedAt: NonNegativeInt,
        }),
        success: Schema.Struct({ data: Memory.ConflictDecisionResult }),
        error: ConflictError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.undoConflict", `${root}/conflicts/:conflictID/undo`, {
        params: { conflictID: Memory.ConflictID },
        query: location,
        payload: Schema.Struct({
          expectedLeftUpdatedAt: NonNegativeInt,
          expectedRightUpdatedAt: NonNegativeInt,
        }),
        success: Schema.Struct({ data: Memory.ConflictDecisionResult }),
        error: ConflictError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.delete("memory.delete", item, {
        params: { memoryID: Memory.ID },
        query: location,
        success: HttpApiSchema.NoContent,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.deleteMany", `${root}/delete`, {
        payload: Schema.Struct({ ids: Schema.Array(Memory.ID).check(Schema.isMaxLength(50)) }),
        query: location,
        success: Schema.Struct({ data: Memory.DeleteResult }),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.semantic", `${root}/semantic`, {
        query: {
          ...location,
          query: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_000)),
          topK: PositiveInt.check(Schema.isLessThanOrEqualTo(20)).pipe(Schema.optional),
          includeGlobal: Schema.Literals(["true", "false"]).pipe(Schema.optional),
          indexLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000)).pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Memory.SemanticResults }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.facets", `${root}/facets`, {
        query: { ...location, includeGlobal: Schema.Literals(["true", "false"]).pipe(Schema.optional) },
        success: Schema.Struct({ data: Memory.Facets }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.status", `${root}/status`, {
        query: location,
        success: Schema.Struct({ data: Memory.Status }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.recallQuality", `${root}/recall-quality`, {
        query: location,
        success: Schema.Struct({ data: Memory.RecallQuality }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("memory.governancePreview", `${root}/governance/preview`, {
        query: {
          ...location,
          scanLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(10_000)).pipe(Schema.optional),
          sampleLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Memory.GovernancePreview }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("memory.governanceApply", `${root}/governance/apply`, {
        query: location,
        payload: Schema.Struct({
          scanLimit: PositiveInt.check(Schema.isLessThanOrEqualTo(10_000)).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Memory.GovernanceApplied }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "memory",
        description:
          "Workspace-isolated durable memory with governed global scope, local hybrid retrieval, facets, and operational recall checks.",
      }),
    )
