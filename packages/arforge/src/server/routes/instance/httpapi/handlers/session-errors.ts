import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, StorageNotFoundError> | ApiError.ApiNotFoundError, R> {
  return self.pipe(
    Effect.catchIf(StorageNotFoundError.isInstance, (error) =>
      Effect.fail(ApiError.notFound((error as StorageNotFoundError).message)),
    ),
  ) as Effect.Effect<A, Exclude<E, StorageNotFoundError> | ApiError.ApiNotFoundError, R>
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}
