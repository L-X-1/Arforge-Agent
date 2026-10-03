/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@arforge-ai/llm"
import { FileDiff } from "@arforge-ai/schema/file-diff"
import { HtmlSelectionEdit } from "@arforge-ai/schema/html-selection-edit"
import { FileSystemWatcher } from "@arforge-ai/schema/filesystem-watcher"
import { optional } from "@arforge-ai/schema/schema"
import path from "node:path"
import { createTwoFilesPatch, diffLines } from "diff"
import { Cause, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { EventV2 } from "../event"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { majorImpact, scopedChange } from "./effect-semantics"
import { HtmlSelectionEditError, prepareHtmlSelectionEdit } from "./html-selection-edit"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
  htmlSelection: optional(HtmlSelectionEdit.Guard).annotate({
    description: "For an HTML selection reference, preserve its exact guard here. Requires explicit approval, a saved source snapshot, and oldString equal to the entire captured element. Never drop the guard to bypass a conflict.",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.
// TODO: Add formatter integration after V2 formatter runtime exists.
// Successful settlements publish the existing file watcher event without requiring a native watcher.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval. For a captured HTML selection, include htmlSelection and replace the complete exact selected source; this path requires human approval and rejects stale or unsaved snapshots.",
            effects: (input) =>
              input.htmlSelection ? majorImpact({
                filesystemScope: [input.path],
                expectedArtifacts: [input.path],
                successCriteria: ["the approved HTML selection matches its saved source version and only that range is replaced"],
              }) : scopedChange({
                filesystemScope: [input.path],
                idempotency: "conditional",
                retryability: "guarded",
                reversibility: "irreversible",
                expectedArtifacts: [input.path],
                successCriteria: ["the exact requested replacement is present"],
              }),
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
            ],
            postprocess: ({ input, output }) =>
              events.publish(FileSystemWatcher.Event.Updated, {
                file: path.resolve(location.directory, input.path),
                event: "change",
              }, { location: { directory: location.directory, workspaceID: location.workspaceID } }).pipe(
                Effect.as(output),
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  () => Effect.logWarning("File edit succeeded, but preview invalidation notification failed").pipe(
                    Effect.as({
                      ...output,
                      content: [...output.content, { type: "text" as const, text: "The file was edited successfully, but the preview notification failed. Use Refresh preview; do not repeat the edit." }],
                    }),
                  ),
                ),
              ),
            execute: (input, context) => {
              const staleConflict = (error: FileMutation.StaleContentError) => {
                const metadata: Record<string, unknown> = {
                  kind: "file_conflict",
                  code: "observed_version_mismatch",
                  path: error.path,
                }
                if (error.observedVersion) metadata.observedVersion = error.observedVersion
                if (error.currentVersion) metadata.currentVersion = error.currentVersion
                return new ToolFailure({
                  message: "File changed after permission approval. Read it again before editing.",
                  metadata,
                })
              }
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError(
                    (error) =>
                      error instanceof FileMutation.StaleContentError
                        ? staleConflict(error)
                        : (Tool.toToolFailure(error) ?? new ToolFailure({ message: `Unable to edit ${input.path}` })),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    context.permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  context.permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const guarded = input.htmlSelection ? yield* Effect.try({
                  try: () => prepareHtmlSelectionEdit({
                    directory: location.directory,
                    path: input.path,
                    content: source.content,
                    guard: input.htmlSelection!,
                    oldString: input.oldString,
                    newString: input.newString,
                    replaceAll: input.replaceAll,
                  }),
                  catch: (error) => new ToolFailure({
                    message: error instanceof Error ? error.message : "Unable to validate the HTML selection.",
                    metadata: {
                      kind: "file_conflict",
                      code: error instanceof HtmlSelectionEditError ? error.code : "html_snapshot_invalid",
                      path: input.path,
                    },
                  }),
                }) : undefined
                const ending = detectLineEnding(source.text)
                const oldString = convertToLineEnding(input.oldString, ending)
                const newString = convertToLineEnding(input.newString, ending)
                const replacements = guarded ? 1 : countOccurrences(source.text, oldString)
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                  })
                }

                const replaced =
                  guarded ? guarded.after : input.replaceAll === true
                    ? source.text.replaceAll(oldString, newString)
                    : source.text.replace(oldString, newString)
                const counts = diffLines(source.text, replaced).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                return {
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                      status: "modified" as const,
                      ...counts,
                    },
                  ],
                  replacements,
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, LocationMutation.node, FileMutation.node, FSUtil.node, EventV2.node, Location.node],
})
