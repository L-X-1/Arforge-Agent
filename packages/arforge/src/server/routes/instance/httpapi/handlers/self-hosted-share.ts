import { SessionShareProvider } from "@/share/provider"
import { SELF_HOSTED_PROVIDER_INTERNAL_TOKEN } from "@/share/self-hosted"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

function mapProviderError(
  error: SessionShareProvider.Error,
): HttpApiError.BadRequest | HttpApiError.Conflict | HttpApiError.ServiceUnavailable {
  if (error instanceof SessionShareProvider.ProviderConflictError)
    return new HttpApiError.Conflict({})
  if (error instanceof SessionShareProvider.ProviderUnavailableError)
    return new HttpApiError.ServiceUnavailable({})
  return new HttpApiError.BadRequest({})
}

const requireInternalCapability = Effect.fnUntraced(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.headers["x-arforge-provider-internal"] !== SELF_HOSTED_PROVIDER_INTERNAL_TOKEN)
    return yield* new HttpApiError.Forbidden({})
})

export const selfHostedShareHandlers = HttpApiBuilder.group(InstanceHttpApi, "selfHostedShare", (handlers) =>
  Effect.gen(function* () {
    const provider = yield* SessionShareProvider.Service

    const publish = Effect.fn("SelfHostedShareHttpApi.publish")(function* (ctx: {
      payload: SessionShareProvider.PublishInputPayload
    }) {
      yield* requireInternalCapability()
      return yield* provider
        .publish(ctx.payload)
        .pipe(Effect.mapError(mapProviderError))
    })

    const lookup = Effect.fn("SelfHostedShareHttpApi.lookup")(function* (ctx: { params: { operationID: string } }) {
      yield* requireInternalCapability()
      return yield* provider.lookup(ctx.params.operationID).pipe(Effect.mapError(mapProviderError))
    })

    const revoke = Effect.fn("SelfHostedShareHttpApi.revoke")(function* (ctx: {
      payload: SessionShareProvider.RevokeInputPayload
    }) {
      yield* requireInternalCapability()
      return yield* provider.revoke(ctx.payload).pipe(Effect.mapError(mapProviderError))
    })

    const lookupRevoke = Effect.fn("SelfHostedShareHttpApi.lookupRevoke")(function* (ctx: {
      params: { operationID: string }
    }) {
      yield* requireInternalCapability()
      return yield* provider.lookupRevoke(ctx.params.operationID).pipe(Effect.mapError(mapProviderError))
    })

    return handlers
      .handle("publish", publish)
      .handle("lookup", lookup)
      .handle("revoke", revoke)
      .handle("lookupRevoke", lookupRevoke)
  }),
)
