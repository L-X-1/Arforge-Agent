import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { EventManifest } from "@arforge-ai/schema/event-manifest"
import { Project } from "@arforge-ai/schema/project"
import { ArforgeEvent } from "@arforge-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import type * as Sse from "effect/unstable/encoding/Sse"

const nativeTypes = new Set<string>(EventManifest.ServerDefinitions.map((definition) => definition.type))

/** Compatibility-only events must not terminate or consume the native subscriber queue. */
export function nativeEventStream(
  events: Pick<EventV2.Interface, "listen">,
  principal?: Database.Principal,
  capacity = 256,
) {
  return Stream.unwrap(Effect.gen(function* () {
    const live = yield* EventV2.allBounded({
      listen: (listener) => events.listen((event) => {
        if (!nativeTypes.has(event.type)) return Effect.void
        if (event.type !== Project.Event.Updated.type) return listener(event)
        return Effect.gen(function* () {
          // The callback runs in the publishing fiber. The subscriber's
          // principal was captured before opening the response stream.
          const owner = yield* Database.CurrentPrincipal
          if (owner && principal?.tenantID === owner.tenantID && principal.userID === owner.userID)
            yield* listener(event)
        })
      }),
    }, capacity)
    return Stream.make({ id: EventV2.ID.create(), type: "server.connected", data: {} }).pipe(Stream.concat(live))
  })).pipe(Stream.map((data): Sse.Event => ({
    _tag: "Event", event: "message", id: undefined,
    // Declared native events still undergo the complete canonical wire validation.
    data: JSON.stringify(Schema.encodeUnknownSync(ArforgeEvent)(data)),
  })))
}
