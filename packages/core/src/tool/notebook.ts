export * as NotebookTools from "./notebook"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { NotebookV2 } from "../notebook"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { majorImpact, scopedChange } from "./effect-semantics"

export const ReadInput = Schema.Struct({
  notebook_path: Schema.String.annotate({ description: "Notebook path inside the active Location" }),
  start: Schema.Int.pipe(Schema.optional).annotate({ description: "Zero-based first cell index (default 0)" }),
  limit: Schema.Int.pipe(Schema.optional).annotate({ description: "Number of cells to return (1-100, default 20)" }),
  include_outputs: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include complete code-cell outputs when true (default false)",
  }),
})

export const EditInput = Schema.Struct({
  notebook_path: Schema.String.annotate({ description: "Notebook path inside the active Location" }),
  expected_sha256: Schema.String.annotate({
    description: "SHA-256 returned by notebook_read; prevents overwriting external changes",
  }),
  edit_mode: Schema.Literals(NotebookV2.EDIT_MODES).pipe(Schema.optional).annotate({
    description: "Replace, insert, or delete (default replace)",
  }),
  cell_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Stable native cell ID or cell-N locator; omit to insert at the beginning",
  }),
  new_source: Schema.String.pipe(Schema.optional).annotate({
    description: "Complete source for replace or insert",
  }),
  cell_type: Schema.Literals(NotebookV2.CELL_TYPES).pipe(Schema.optional).annotate({
    description: "Code, markdown, or raw; required for insert",
  }),
  dry_run: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Return the bounded structured preview without writing",
  }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const notebooks = yield* NotebookV2.Service
    const mutation = yield* LocationMutation.Service

    const resolve = (notebookPath: string, context: Tool.Context, action: "notebook_read" | "edit") =>
      Effect.gen(function* () {
        const source = {
          type: "tool" as const,
          messageID: context.assistantMessageID,
          callID: context.toolCallID,
        }
        const target = yield* mutation.resolve({ path: notebookPath, kind: "file" })
        if (target.externalDirectory)
          yield* context.permission.assert({
            ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
            sessionID: context.sessionID,
            agent: context.agent,
            source,
          })
        yield* context.permission.assert({
          action,
          resources: [target.resource],
          save: ["*"],
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
        return target
      })

    const read = Tool.make({
      description:
        "Read a Jupyter nbformat 4 .ipynb file as bounded structured cells. Outputs are omitted by default. Returns the exact file SHA-256 required by notebook_edit.",
      input: ReadInput,
      output: NotebookV2.ReadResult,
      effects: (input) =>
        majorImpact({
          filesystemScope: [input.notebook_path],
          expectedArtifacts: ["bounded notebook cells", "notebook SHA-256"],
          successCriteria: ["notebook is decoded and bounded without a write"],
        }),
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
      execute: (input, context) =>
        Effect.gen(function* () {
          const target = yield* resolve(input.notebook_path, context, "notebook_read")
          return yield* notebooks.read({
            target,
            start: input.start,
            limit: input.limit,
            includeOutputs: input.include_outputs,
          })
        }).pipe(Effect.mapError(toFailure)),
    })

    const edit = Tool.withPermission(
      Tool.make({
        description:
          "Structurally replace, insert, or delete one Jupyter notebook cell. Requires the SHA-256 from notebook_read, preserves metadata, clears stale code outputs, and supports a no-write dry run.",
        input: EditInput,
        output: NotebookV2.EditResult,
        effects: (input) =>
          scopedChange({
            filesystemScope: [input.notebook_path],
            idempotency: "conditional",
            retryability: "guarded",
            reversibility: "reversible",
            compensation: "restore the notebook snapshot identified by expected_sha256",
            expectedArtifacts: input.dry_run ? ["bounded notebook edit preview"] : [input.notebook_path],
            successCriteria: [
              input.dry_run ? "preview validates against expected_sha256 without writing" : "notebook edit is persisted",
            ],
          }),
        toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
        execute: (input, context) =>
          Effect.gen(function* () {
            const target = yield* resolve(input.notebook_path, context, "edit")
            return yield* notebooks.edit({
              target,
              expectedSha256: input.expected_sha256,
              editMode: input.edit_mode,
              cellID: input.cell_id,
              newSource: input.new_source,
              cellType: input.cell_type,
              dryRun: input.dry_run,
            })
          }).pipe(Effect.mapError(toFailure)),
      }),
      "edit",
    )

    yield* tools.register({ notebook_read: read, notebook_edit: edit }).pipe(Effect.orDie)
  }),
)

function toFailure(error: unknown) {
  return (
    Tool.toToolFailure(error) ??
    new ToolFailure({
      message: error instanceof NotebookV2.NotebookError ? error.message : "Notebook operation failed",
    })
  )
}

export const node = makeLocationNode({
  name: "tool/notebook",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, NotebookV2.node, LocationMutation.node],
})
