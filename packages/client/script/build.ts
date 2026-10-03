import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitPromise, write } from "@arforge-ai/httpapi-codegen"
import { ClientApi, endpointNames, groupNames, omitEndpoints } from "../src/contract"
import { Effect, Schedule } from "effect"
import { fileURLToPath } from "url"

const contract = compile(ClientApi, { groupNames, endpointNames, omitEndpoints })

await Effect.runPromise(
  Effect.gen(function* () {
    // Keep the two generated trees independent and deterministic.  In
    // particular, Windows can reject concurrent opens while the formatter is
    // replacing files in both trees even though their paths do not overlap.
    const stableWrite = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        // Bun on Windows can transiently report EUNKNOWN while an editor or
        // antivirus scanner holds a generated file open. A bounded retry keeps
        // contract generation deterministic without hiding persistent errors.
        Effect.retry(Schedule.exponential("50 millis").pipe(Schedule.take(3))),
      )
    yield* stableWrite(
      write(
        emitPromise(contract, {
          outputTypes: {
            "events.subscribe": {
              name: "ArforgeEventEncoded",
              import: 'import type { ArforgeEventEncoded } from "@arforge-ai/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/generated", import.meta.url)),
      ),
    )
    yield* stableWrite(
      write(
        emitEffectImported(contract, { module: "../contract", api: "ClientApi" }),
        fileURLToPath(new URL("../src/generated-effect", import.meta.url)),
      ),
    )
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)
