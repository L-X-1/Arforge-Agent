import { MemoryV2 } from "@arforge-ai/core/memory"
import { ConflictError, InvalidRequestError, MemoryNotFoundError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

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
      "memory.delete",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        yield* memory.delete(ctx.params.memoryID)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "memory.deleteMany",
      Effect.fn(function* (ctx) {
        const memory = yield* MemoryV2.Service
        return {
          data: yield* memory
            .deleteMany(ctx.payload.ids)
            .pipe(
              Effect.catchTag(
                "Memory.DeleteLimitError",
                (error) =>
                  new InvalidRequestError({ field: "ids", message: `At most ${error.limit} IDs are allowed.` }),
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
