import { Effect, Layer, Stream } from "effect"
import { EventV2 } from "@arforge-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"

/**
 * Failure-injection layers for the user-visible mutation transaction tests.
 *
 * These deliberately fail at the boundary after the file has been committed:
 * the tool must compensate through Core FileMutation before returning the
 * post-processing error. Keeping the injections as service replacements makes
 * the tests exercise the real edit/write/apply_patch pipelines instead of a
 * unit-only rollback helper.
 */

export const failingLsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.die(new Error("LSP post-process failed")),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const failingEventService: EventV2.Interface = {
  publish: <D extends EventV2.Definition>(_definition: D, _data: EventV2.Data<D>) =>
    Effect.die(new Error("watcher event publish failed")),
  subscribe: <D extends EventV2.Definition>(_definition: D) => Stream.empty as Stream.Stream<EventV2.Payload<D>>,
  all: () => Stream.empty as Stream.Stream<EventV2.Payload>,
  durable: (_input) => Stream.empty as Stream.Stream<EventV2.Payload>,
  latest: (_aggregateID) => Effect.succeed(undefined),
  listen: (_listener) => Effect.succeed(Effect.void),
  project: <D extends EventV2.Definition>(_definition: D, _projector: EventV2.Subscriber<D>) => Effect.void,
  replay: (_event, _options) => Effect.void,
  replayAll: (_events, _options) => Effect.succeed(undefined),
  remove: (_aggregateID) => Effect.void,
  claim: (_aggregateID, _ownerID) => Effect.void,
}

export const failingEventPublish = Layer.succeed(EventV2Bridge.Service, EventV2Bridge.Service.of(failingEventService))
