import path from "node:path"
import fs from "node:fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { location } from "./location"

type Input = {
  readonly directory: string
  readonly target?: string
  readonly expected?: string
  readonly content: string
  readonly operation?: "write" | "fingerprint" | "move"
  readonly source?: string
  readonly destination?: string
  readonly expectedSource?: string
  readonly expectedDestination?: string
  readonly pauseAfterReadMs?: number
  readonly readMarker?: string
}

const input = JSON.parse(process.argv[2] ?? "") as Input
const activeLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(path.resolve(input.directory)) })),
)
const filesystemLayer =
  input.pauseAfterReadMs === undefined
    ? LayerNode.compile(FSUtil.node)
    : Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const filesystem = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...filesystem,
            readFile: (file: string) =>
              filesystem.readFile(file).pipe(
                Effect.tap(() =>
                  input.readMarker === undefined
                    ? Effect.void
                    : Effect.promise(() =>
                        fs.writeFile(input.readMarker!, "read", { flag: "wx" }).catch(() => undefined),
                      ),
                ),
                Effect.tap(() => Effect.sleep(input.pauseAfterReadMs ?? 0)),
              ),
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const layer = AppNodeBuilder.build(LayerNode.group([LocationMutation.node, FileMutation.node]), [
  [Location.node, activeLocation],
  [FSUtil.node, filesystemLayer],
])

const program = Effect.gen(function* () {
  const mutation = yield* LocationMutation.Service
  const files = yield* FileMutation.Service
  if (input.operation === "move") {
    if (input.source === undefined || input.destination === undefined || input.expectedSource === undefined)
      return yield* Effect.die(new Error("move worker input is incomplete"))
    const source = yield* mutation.resolve({ path: input.source })
    const destination = yield* mutation.resolve({ path: input.destination })
    return yield* files.moveIfUnchanged({
      source,
      destination,
      expectedSource: new TextEncoder().encode(input.expectedSource),
      ...(input.expectedDestination === undefined
        ? {}
        : { expectedDestination: new TextEncoder().encode(input.expectedDestination) }),
      content: input.content,
    })
  }
  if (input.target === undefined || input.expected === undefined)
    return yield* Effect.die(new Error("mutation worker input is incomplete"))
  const target = yield* mutation.resolve({ path: input.target })
  if (input.operation === "fingerprint") return yield* files.fingerprint({ target })
  return yield* files.writeIfUnchanged({
    target,
    expected: new TextEncoder().encode(input.expected),
    content: input.content,
  })
})

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))
if (Exit.isSuccess(exit)) {
  process.stdout.write(JSON.stringify({ kind: "success", result: exit.value }))
} else {
  const error = Cause.squash(exit.cause)
  process.stdout.write(
    JSON.stringify({
      kind: "error",
      tag: error && typeof error === "object" && "_tag" in error ? error._tag : undefined,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}
