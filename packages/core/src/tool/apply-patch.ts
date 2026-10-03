export * as ApplyPatchTool from "./apply-patch"

import { ToolFailure } from "@arforge-ai/llm"
import { FileDiff } from "@arforge-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Patch } from "../patch"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { scopedChange } from "./effect-semantics"

export const name = "apply_patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    "Applied patch sequentially:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "delete" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly content: string
      readonly before: string
      readonly after: string
    })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Apply one patch containing add, update, and delete file operations. All targets are resolved and approved before target contents are read. If a later operation fails, earlier operations are compensated in reverse order with conditional writes; a patch is never reported as completed after a partial application. Moves are not supported yet.",
            effects: scopedChange({
              filesystemScope: ["targets declared by patchText"],
              idempotency: "conditional",
              retryability: "guarded",
              reversibility: "compensatable",
              compensation: "restore the pre-action file snapshots with conditional writes",
              expectedArtifacts: ["applied file patch"],
              successCriteria: ["all patch hunks apply and the post-action file state is diffable"],
            }),
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const applied: Array<typeof Applied.Type> = []
              const appliedChanges: Prepared[] = []
              const fail = (path: string, error?: unknown) => {
                if (error instanceof FileMutation.StaleContentError) {
                  const metadata: Record<string, unknown> = {
                    kind: "file_conflict",
                    code: "observed_version_mismatch",
                    path: error.path,
                  }
                  if (error.observedVersion) metadata.observedVersion = error.observedVersion
                  if (error.currentVersion) metadata.currentVersion = error.currentVersion
                  return new ToolFailure({
                    message: `File changed after permission approval. Read it again before applying the patch at ${path}.`,
                    metadata,
                  })
                }
                return new ToolFailure({ message: `Unable to apply patch at ${path}` })
              }
              const compensate = Effect.gen(function* () {
                const failures: string[] = []
                for (const change of [...appliedChanges].reverse()) {
                  const result = yield* Effect.exit(
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        yield* files.removeIfUnchanged({ target: change.target, expected: change.source })
                        return
                      }

                      if (change.type === "update") {
                        const current = yield* fs.readFile(change.target.canonical)
                        yield* files.writeIfUnchanged({
                          target: change.target,
                          expected: current,
                          content: change.source,
                        })
                        return
                      }

                      if (yield* fs.exists(change.target.canonical)) {
                        const current = yield* fs.readFile(change.target.canonical)
                        yield* files.writeIfUnchanged({
                          target: change.target,
                          expected: current,
                          content: change.source,
                        })
                      } else {
                        yield* files.create({ target: change.target, content: change.source })
                      }
                    }),
                  )
                  if (result._tag === "Failure") failures.push(change.path)
                }
                return failures
              })
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!input.patchText.trim()) return yield* new ToolFailure({ message: "patchText is required" })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) => new ToolFailure({ message: `apply_patch verification failed: ${String(cause)}` }),
                })
                if (hunks.length === 0) return yield* new ToolFailure({ message: "patch rejected: empty patch" })
                const move = hunks.find((hunk) => hunk.type === "update" && hunk.movePath !== undefined)
                if (move) return yield* new ToolFailure({ message: "apply_patch moves are not supported yet" })

                const targets: Array<{ readonly hunk: Patch.Hunk; readonly target: LocationMutation.Target }> = []
                for (const hunk of hunks)
                  targets.push({ hunk, target: yield* mutation.resolve({ path: hunk.path, kind: "file" }) })
                const externalDirectories = new Map<string, LocationMutation.ExternalDirectoryAuthorization>()
                for (const { target } of targets) {
                  const external = target.externalDirectory
                  if (external) externalDirectories.set(external.resource, external)
                }
                for (const external of externalDirectories.values()) {
                  yield* context.permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                yield* context.permission.assert({
                  action: "edit",
                  resources: [...new Set(targets.map(({ target }) => target.resource))],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                const prepared: Prepared[] = []
                for (const { hunk, target } of targets) {
                  yield* Effect.gen(function* () {
                    if (hunk.type === "add") {
                      prepared.push({
                        ...hunk,
                        target,
                        source: new TextEncoder().encode(
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                        ),
                        before: "",
                        after:
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                      })
                      return
                    }
                    if ((yield* fs.stat(target.canonical)).type !== "File") yield* fail(hunk.path)
                    const source = yield* fs.readFile(target.canonical)
                    const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(source)
                    const before = original.replace(/^\uFEFF/, "")
                    if (hunk.type === "delete") {
                      prepared.push({ ...hunk, target, source, before, after: "" })
                      return
                    }
                    const update = Patch.derive(hunk.path, hunk.chunks, original)
                    prepared.push({
                      ...hunk,
                      target,
                      source,
                      content: Patch.joinBom(update.content, update.bom),
                      before,
                      after: update.content,
                    })
                  }).pipe(Effect.mapError(() => fail(hunk.path)))
                }

                const patchFiles = prepared.map(patchFile)
                yield* Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        const result = yield* files.create({
                          target: change.target,
                          content:
                            change.contents.endsWith("\n") || change.contents === ""
                              ? change.contents
                              : `${change.contents}\n`,
                        })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        appliedChanges.push(change)
                        return
                      }
                      if (change.type === "delete") {
                        const result = yield* files.removeIfUnchanged({
                          target: change.target,
                          expected: change.source,
                        })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        appliedChanges.push(change)
                        return
                      }
                      const result = yield* files.writeIfUnchanged({
                        target: change.target,
                        expected: change.source,
                        content: change.content,
                      })
                      applied.push({ type: change.type, resource: result.resource, target: result.target })
                      appliedChanges.push(change)
                    }).pipe(Effect.mapError((error) => fail(change.path, error))),
                  { discard: true },
                ).pipe(
                  Effect.catch((error) =>
                    compensate.pipe(
                      Effect.flatMap((rollbackFailures) => {
                        const original = error instanceof ToolFailure ? error.message : String(error)
                        const suffix =
                          appliedChanges.length === 0
                            ? ""
                            : rollbackFailures.length === 0
                            ? " Batch compensation completed."
                            : ` Batch compensation failed for: ${rollbackFailures.join(", ")}.`
                        return Effect.fail(new ToolFailure({ message: `${original}${suffix}` }))
                      }),
                    ),
                  ),
                )
                return { applied, files: patchFiles }
              }).pipe(
                Effect.mapError(
                  (error) => Tool.toToolFailure(error) ?? (error instanceof ToolFailure ? error : fail("patch")),
                ),
              )
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apply-patch",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, LocationMutation.node, FileMutation.node, FSUtil.node],
})

function patchFile(change: Prepared): typeof FileDiff.Info.Type {
  const counts = diffLines(change.before, change.after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file: change.target.resource,
    patch: createTwoFilesPatch(change.target.resource, change.target.resource, change.before, change.after),
    status: change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
    ...counts,
  }
}
