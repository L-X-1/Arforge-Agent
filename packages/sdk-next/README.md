# @arforge-ai/sdk-next

Effect-native scoped Arforge host for in-process applications. This transitional package will replace the existing generated `@arforge-ai/sdk` after its consumers migrate.

The SDK executes Server's assembled HTTP router in memory. It opens no listener and performs no network I/O, while preserving the same routing, middleware, handlers, codecs, and errors as the network client.

```ts
import { Arforge } from "@arforge-ai/sdk-next"

const arforge = yield * Arforge.create()
const session = yield * arforge.sessions.get({ sessionID })
```

It also exports `Tool` and exposes local-only `tools.register(...)`, replacing the former `@arforge-ai/core/public` facade. Registration uses Core's host-level `ApplicationTools` service shared by the host's Locations; each Location retains its own `ToolRegistry` for overlay, lookup, and settlement. Closing the owning Effect Scope releases router resources, location services, fibers, and scoped tool registrations.

`sessions.events({ sessionID, after })` replays durable events after the optional aggregate sequence, then emits newly committed durable events. `sessions.interrupt(...)` targets execution owned by this host, and `sessions.message(...)` retrieves one projected Session message.

The same constructor is available as a service Layer:

```ts
const program = Effect.gen(function* () {
  const arforge = yield* Arforge.Service
  return yield* arforge.sessions.get({ sessionID })
})

yield * program.pipe(Effect.provide(Arforge.layer))
```

`Arforge.layer` adapts `Arforge.create()` for dependency injection; it does not define another host implementation.
