/**
 * Model-facing V2 file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { encodeDocx, encodePptxJson, encodeXlsxJson, OfficeDocumentWriteError } from "../office-document-writer"
import { encodePdf } from "../pdf-document-writer"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { scopedChange } from "./effect-semantics"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  content: Schema.String.annotate({
    description:
      "Content to write. Plain text is preserved for ordinary files; .xlsx expects a bounded JSON row array, .docx accepts bounded Markdown-like text, .pptx expects a bounded JSON slide array, and .pdf accepts bounded Markdown-like text.",
  }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Write content to one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval. For .xlsx targets, content must be a bounded JSON array of rows; for .docx and .pdf targets, bounded Markdown-like text; for .pptx targets, a bounded JSON array of slides. Office formats are encoded deterministically without launching Office.",
            effects: (input) =>
              scopedChange({
                filesystemScope: [input.path],
                idempotency: "conditional",
                retryability: "guarded",
                reversibility: "irreversible",
                expectedArtifacts: [input.path],
                successCriteria: ["target contains the requested content"],
              }),
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* context.permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* context.permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const extension = path.extname(target.canonical).toLowerCase()
                if (extension === ".xlsx" || extension === ".docx" || extension === ".pptx" || extension === ".pdf") {
                  const content = yield* Effect.try({
                    try: () =>
                      extension === ".xlsx"
                        ? encodeXlsxJson(input.content)
                        : extension === ".docx"
                          ? encodeDocx(input.content)
                          : extension === ".pptx"
                            ? encodePptxJson(input.content)
                            : encodePdf(input.content),
                    catch: (error) =>
                      error instanceof OfficeDocumentWriteError
                        ? error
                        : new OfficeDocumentWriteError(error instanceof Error ? error.message : String(error)),
                  })
                  return yield* files.write({ target, content })
                }
                return yield* files.writeTextPreservingBom({ target, content: input.content })
              }).pipe(
                Effect.mapError(
                  (error) =>
                    Tool.toToolFailure(error) ??
                    (error instanceof OfficeDocumentWriteError
                      ? new ToolFailure({ message: error.message })
                      : new ToolFailure({ message: `Unable to write ${input.path}` })),
                ),
              ),
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, LocationMutation.node, FileMutation.node],
})
