import { Cause, Effect, Exit, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@arforge-ai/core/filesystem"
import { Watcher } from "@arforge-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import * as CoreFileMutation from "./file-mutation"
import {
  encodeDocx,
  encodePptxJson,
  encodeXlsxJson,
  OfficeDocumentWriteError,
} from "@arforge-ai/core/office-document-writer"
import { encodePdf } from "@arforge-ai/core/pdf-document-writer"
import type { Diagnostic } from "@/lsp/client"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

type OfficeFormat = ".docx" | ".xlsx" | ".pptx" | ".pdf"

const officeFormat = (filePath: string): OfficeFormat | undefined => {
  const extension = path.extname(filePath).toLowerCase()
  return extension === ".docx" || extension === ".xlsx" || extension === ".pptx" || extension === ".pdf"
    ? extension
    : undefined
}

const officeFormatLabel = (format: OfficeFormat) => format.slice(1).toUpperCase()

const encodeOffice = (format: OfficeFormat, content: string): Uint8Array => {
  switch (format) {
    case ".docx":
      return encodeDocx(content)
    case ".xlsx":
      return encodeXlsxJson(content)
    case ".pptx":
      return encodePptxJson(content)
    case ".pdf":
      return encodePdf(content)
  }
}

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          const files = yield* CoreFileMutation.service()
          const mutationTarget = CoreFileMutation.target(instance.worktree, filepath)
          const journal = CoreFileMutation.makeJournal(files)
          let intentRecorder: CoreFileMutation.MutationIntentRecorder | undefined
          const formatKind = officeFormat(filepath)

          const exists = yield* fs.existsSafe(filepath)
          const rawSource = exists ? yield* fs.readFile(filepath) : undefined
          const source =
            rawSource && formatKind === undefined
              ? Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawSource))
              : { bom: false, text: "" }
          const next = formatKind === undefined ? Bom.split(params.content) : { bom: false, text: "" }
          const desiredBom = formatKind === undefined && (source.bom || next.bom)
          const contentOld =
            formatKind === undefined
              ? source.text
              : rawSource
                ? `[existing ${officeFormatLabel(formatKind)} artifact: ${rawSource.byteLength} bytes]`
                : ""
          const contentNew =
            formatKind === undefined
              ? next.text
              : `[generated ${officeFormatLabel(formatKind)} artifact by the canonical writer]`

          const diff =
            formatKind === undefined
              ? trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
              : `--- ${filepath}\n+++ ${filepath}\n@@ canonical ${officeFormatLabel(formatKind)} writer @@\n- ${contentOld || "(new file)"}\n+ ${contentNew}`
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          const failureAfterRollback = (cause: Cause.Cause<unknown>, prefix = "Write failed after a partial commit.") =>
            Effect.gen(function* () {
              const original = Cause.squash(cause)
              const originalError = original instanceof Error ? original : new Error(String(original))
              yield* CoreFileMutation.recordBestEffort(
                intentRecorder,
                "rollback_required",
                "Write transaction requires compensation.",
              )
              const rollbackErrors = yield* journal.rollback()
              yield* CoreFileMutation.recordBestEffort(
                intentRecorder,
                rollbackErrors.length > 0 ? "rollback_blocked" : "rolled_back",
                "Write transaction recovery",
              )
              if (rollbackErrors.length > 0)
                return yield* Effect.fail(
                  new Error(
                    `${prefix} ${originalError.message} Rollback: ${rollbackErrors.map((error) => error.message).join("; ")}`,
                  ),
                )
              return yield* Effect.fail(new Error(`${prefix} ${originalError.message}`))
            })

          const written =
            formatKind === undefined
              ? new TextEncoder().encode(Bom.join(contentNew, desiredBom))
              : yield* Effect.try({
                  try: () => encodeOffice(formatKind, params.content),
                  catch: (error) =>
                    error instanceof OfficeDocumentWriteError
                      ? error
                      : new OfficeDocumentWriteError(error instanceof Error ? error.message : String(error)),
                })
          const intentEntries = yield* CoreFileMutation.stageIntentEntries([
            {
              target: mutationTarget,
              operation: exists ? "write" : "create",
              ...(exists ? { before: rawSource! } : {}),
              after: written,
              recovery: exists ? "restore-from-volatile-journal" : "remove-if-matching",
            },
          ])
          intentRecorder = CoreFileMutation.makeIntentRecorder({
            gateway: ctx.gateway,
            actionID: ctx.parentAction?.actionID,
            entries: intentEntries,
          })
          if (intentRecorder) yield* intentRecorder.record("prepared", "Write transaction prepared")
          if (exists) {
            yield* files
              .writeIfUnchanged({
                target: mutationTarget,
                expected: rawSource!,
                content: written,
              })
              .pipe(
                Effect.catch((error) =>
                  CoreFileMutation.reportFailure({ error, operation: "writing", metadata: ctx.metadata }),
                ),
              )
            journal.add({ kind: "restore", target: mutationTarget, expected: written, content: rawSource! })
          } else {
            yield* files
              .create({ target: mutationTarget, content: written })
              .pipe(
                Effect.catch((error) =>
                  CoreFileMutation.reportFailure({ error, operation: "writing", metadata: ctx.metadata }),
                ),
              )
            journal.add({ kind: "remove-created", target: mutationTarget, expected: written })
          }
          if (intentRecorder) {
            const committed = yield* intentRecorder.record("committed", "Write transaction committed").pipe(Effect.exit)
            if (Exit.isFailure(committed)) return yield* failureAfterRollback(committed.cause)
          }

          // Formatter, LSP, event publication and durable settlement share the
          // canonical post-processing transaction.
          const postCommit = Effect.gen(function* () {
            const checkpointTarget = mutationTarget.resource
            if (formatKind === undefined) {
              yield* CoreFileMutation.runPostProcessingStage({
                recorder: intentRecorder,
                stage: "formatter",
                target: checkpointTarget,
                effect: format.file(filepath),
              })
              yield* CoreFileMutation.runPostProcessingStage({
                recorder: intentRecorder,
                stage: "bom",
                target: checkpointTarget,
                effect: Bom.syncFile(fs, filepath, desiredBom),
              })
            }
            const current = yield* fs
              .readFile(filepath)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
            if (current) journal.refresh(mutationTarget, current)

            let diagnostics: Record<string, Diagnostic[]> = {}
            if (formatKind === undefined) {
              yield* CoreFileMutation.runPostProcessingStage({
                recorder: intentRecorder,
                stage: "lsp_touch",
                target: checkpointTarget,
                effect: lsp.touchFile(filepath, "document"),
              })
              diagnostics = yield* CoreFileMutation.runPostProcessingStage({
                recorder: intentRecorder,
                stage: "diagnostics",
                effect: lsp.diagnostics(),
              })
            }
            yield* CoreFileMutation.runPostProcessingStage({
              recorder: intentRecorder,
              stage: "event_v2",
              target: checkpointTarget,
              effect: events.publish(FileSystem.Event.Edited, { file: filepath }),
            })
            yield* CoreFileMutation.runPostProcessingStage({
              recorder: intentRecorder,
              stage: "watcher",
              target: checkpointTarget,
              effect: events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              }),
            })
            return diagnostics
          })
          const diagnostics = yield* CoreFileMutation.runPostProcessingTransaction({
            recorder: intentRecorder,
            journal,
            operation: "Write",
            effect: postCommit,
          })

          let output = "Wrote file successfully."
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
