import { A2A } from "@arforge-ai/schema/a2a"
import { NonNegativeInt, PositiveInt } from "@arforge-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError, UnauthorizedError } from "../errors"

const root = "/api/a2a/v1/tasks"
const taskParams = { taskID: A2A.TaskID }
const protocolErrors = [UnauthorizedError, InvalidRequestError, ConflictError, ServiceUnavailableError]

/**
 * Private A2A V1 protocol surface.  The group is intentionally not mounted by
 * the public API assembly until a transport adapter supplies authenticated
 * peer request-context binding and an explicitly configured private transport.
 */
export const A2AGroup = HttpApiGroup.make("server.a2a")
  .add(
    HttpApiEndpoint.post("a2a.taskSubmit", root, {
      payload: A2A.TaskEnvelope,
      success: A2A.Accepted,
      error: protocolErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.a2a.taskSubmit",
        summary: "Submit a private A2A task",
        description:
          "Submit a signed task envelope containing only a delegated capability reference. No local filesystem or tool token crosses the channel.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("a2a.status", `${root}/:taskID/status`, {
      params: taskParams,
      query: {
        afterSequence: NonNegativeInt.pipe(Schema.optional),
        limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
      },
      success: A2A.StatusStream,
      error: [UnauthorizedError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.a2a.status",
        summary: "Read a private A2A status stream",
        description: "Read bounded, signed task status events using a monotonic sequence cursor.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("a2a.result", `${root}/:taskID/result`, {
      params: taskParams,
      payload: A2A.ResultReceipt,
      success: A2A.ResultReceipt,
      error: protocolErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.a2a.result",
        summary: "Submit a verified A2A result receipt",
        description:
          "Accept only a signed result receipt with bounded usage that names a local verifier or an allowlisted trusted receipt verifier.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("a2a.cancel", `${root}/:taskID/cancel`, {
      params: taskParams,
      payload: A2A.CancelRequest,
      success: A2A.Accepted,
      error: protocolErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.a2a.cancel",
        summary: "Cancel a private A2A task",
        description: "Cancel only the task bound to the signed request and nonce; cancellation is idempotent by request identity.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("a2a.revoke", `${root}/:taskID/revoke`, {
      params: taskParams,
      payload: A2A.RevokeRequest,
      success: A2A.Accepted,
      error: protocolErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.a2a.revoke",
        summary: "Revoke a delegated A2A capability",
        description: "Revoke only the grant digest bound to the signed task envelope; revocation cannot expand authority.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "private A2A v1",
      description:
        "Private signed task envelopes, bounded status streams, verifier-bound result receipts, cancellation, and capability revocation.",
    }),
  )
