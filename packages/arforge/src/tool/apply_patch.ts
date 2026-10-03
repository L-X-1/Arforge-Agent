import * as path from "path"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@arforge-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@arforge-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@arforge-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import * as CoreFileMutation from "./file-mutation"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context
      const fileMutation = yield* CoreFileMutation.service()
      const reportMutationFailure = (error: unknown) =>
        CoreFileMutation.reportFailure({ error, operation: "applying the patch", metadata: ctx.metadata })

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        source?: Uint8Array
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const rawSource = yield* afs.readFile(filePath)
            const source = Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawSource))
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
              source: rawSource,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const rawSource = yield* afs
              .readFile(filePath)
              .pipe(
                Effect.catch((error) =>
                  Effect.fail(
                    new Error(
                      `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  ),
                ),
              )
            const source = Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(rawSource))
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
              source: rawSource,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const fileMetadata = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files: fileMetadata,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      type MutationTarget = ReturnType<typeof CoreFileMutation.target>
      const journal = CoreFileMutation.makeJournal(fileMutation)
      const encoder = new TextEncoder()
      let intentRecorder: CoreFileMutation.MutationIntentRecorder | undefined

      // Formatting can legitimately change the postimage (for example by
      // normalizing whitespace or line endings). Refresh the CAS expected
      // bytes before any later event/LSP stage so a rollback restores the
      // original content without overwriting a change made after that stage.
      const refreshUndo = Effect.fn("ApplyPatchTool.refreshUndo")(function* (target: MutationTarget) {
        const current = yield* afs
          .readFile(target.canonical)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        if (!current) return
        journal.refresh(target, current)
      })

      const failureAfterRollback = (cause: Cause.Cause<unknown>, prefix: string) =>
        Effect.gen(function* () {
          const original = Cause.squash(cause)
          const originalError = original instanceof Error ? original : new Error(String(original))
          yield* CoreFileMutation.recordBestEffort(
            intentRecorder,
            "rollback_required",
            "Patch transaction requires compensation",
          )
          const rollbackErrors = yield* journal.rollback()
          yield* CoreFileMutation.recordBestEffort(
            intentRecorder,
            rollbackErrors.length > 0 ? "rollback_blocked" : "rolled_back",
            "Patch transaction recovery",
          )
          if (rollbackErrors.length > 0)
            return yield* Effect.fail(
              new Error(
                `${prefix} ${originalError.message} Rollback: ${rollbackErrors.map((error) => error.message).join("; ")}`,
              ),
            )
          return yield* Effect.fail(new Error(`${prefix} ${originalError.message}`))
        })

      const intentInputs: CoreFileMutation.IntentEntryInput[] = []
      for (const change of fileChanges) {
        const target = CoreFileMutation.target(instance.worktree, change.filePath)
        if (change.type === "add") {
          intentInputs.push({
            target,
            operation: "create",
            after: encoder.encode(Bom.join(change.newContent, change.bom)),
            recovery: "remove-if-matching",
          })
          continue
        }
        if (change.type === "update") {
          intentInputs.push({
            target,
            operation: "write",
            before: change.source!,
            after: encoder.encode(Bom.join(change.newContent, change.bom)),
            recovery: "restore-from-volatile-journal",
          })
          continue
        }
        if (change.type === "delete") {
          intentInputs.push({
            target,
            operation: "remove",
            before: change.source!,
            recovery: "manual-review",
          })
          continue
        }
        if (!change.movePath) continue
        const destination = CoreFileMutation.target(instance.worktree, change.movePath)
        const destinationSource = yield* afs
          .readFile(change.movePath)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        intentInputs.push(
          {
            target: destination,
            operation: destinationSource ? "write" : "create",
            ...(destinationSource ? { before: destinationSource } : {}),
            after: encoder.encode(Bom.join(change.newContent, change.bom)),
            recovery: destinationSource ? "restore-from-volatile-journal" : "remove-if-matching",
          },
          {
            target,
            operation: "remove",
            before: change.source!,
            recovery: "manual-review",
          },
        )
      }
      const intentEntries = yield* CoreFileMutation.stageIntentEntries(intentInputs)
      intentRecorder = CoreFileMutation.makeIntentRecorder({
        gateway: ctx.gateway,
        actionID: ctx.parentAction?.actionID,
        entries: intentEntries,
      })
      if (intentRecorder) yield* intentRecorder.record("prepared", "Patch transaction prepared")

      const commit = Effect.gen(function* () {
        for (const change of fileChanges) {
          switch (change.type) {
            case "add": {
              const target = CoreFileMutation.target(instance.worktree, change.filePath)
              const written = encoder.encode(Bom.join(change.newContent, change.bom))
              yield* fileMutation.create({ target, content: written }).pipe(Effect.catch(reportMutationFailure))
              journal.add({ kind: "remove-created", target, expected: written })
              updates.push({ file: change.filePath, event: "add" })
              break
            }

            case "update": {
              const target = CoreFileMutation.target(instance.worktree, change.filePath)
              const written = encoder.encode(Bom.join(change.newContent, change.bom))
              yield* fileMutation
                .writeIfUnchanged({ target, expected: change.source!, content: written })
                .pipe(Effect.catch(reportMutationFailure))
              journal.add({ kind: "restore", target, expected: written, content: change.source! })
              updates.push({ file: change.filePath, event: "change" })
              break
            }

            case "move": {
              if (!change.movePath) break
              const destination = CoreFileMutation.target(instance.worktree, change.movePath)
              const destinationSource = yield* afs
                .readFile(change.movePath)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
              const written = encoder.encode(Bom.join(change.newContent, change.bom))
              const source = CoreFileMutation.target(instance.worktree, change.filePath)
              yield* fileMutation
                .moveIfUnchanged({
                  source,
                  destination,
                  expectedSource: change.source!,
                  ...(destinationSource ? { expectedDestination: destinationSource } : {}),
                  content: written,
                })
                .pipe(Effect.catch(reportMutationFailure))
              if (destinationSource) {
                journal.add({ kind: "restore", target: destination, expected: written, content: destinationSource })
              } else {
                journal.add({ kind: "remove-created", target: destination, expected: written })
              }
              journal.add({ kind: "recreate", target: source, content: change.source! })
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
              break
            }

            case "delete": {
              const target = CoreFileMutation.target(instance.worktree, change.filePath)
              yield* fileMutation
                .removeIfUnchanged({ target, expected: change.source! })
                .pipe(Effect.catch(reportMutationFailure))
              journal.add({ kind: "recreate", target, content: change.source! })
              updates.push({ file: change.filePath, event: "unlink" })
              break
            }
          }
        }
      })

      // Keep the mutation batch and its undo journal together: cancellation
      // may interrupt the surrounding session, but never between a successful
      // FileMutation commit and recording the corresponding rollback entry.
      const commitExit = yield* commit.pipe(Effect.uninterruptible, Effect.exit)
      if (Exit.isFailure(commitExit)) {
        return yield* failureAfterRollback(commitExit.cause, "Patch failed after a partial commit.")
      }
      if (intentRecorder) {
        const committed = yield* intentRecorder.record("committed", "Patch transaction committed").pipe(Effect.exit)
        if (Exit.isFailure(committed))
          return yield* failureAfterRollback(committed.cause, "Patch commit settlement failed.")
      }

      // Post-processing is part of the same transaction boundary. Formatting,
      // LSP refresh and event publication are deliberately ordered so no
      // success event is emitted before validation has completed. If a stage
      // fails, the committed files are compensated through the same Core
      // FileMutation owner and the caller receives a non-success result.
      const postCommit = Effect.gen(function* () {
        for (const change of fileChanges) {
          const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
          if (!edited) continue
          const checkpointTarget = CoreFileMutation.target(instance.worktree, edited).resource
          if (
            yield* CoreFileMutation.runPostProcessingStage({
              recorder: intentRecorder,
              stage: "formatter",
              target: checkpointTarget,
              effect: format.file(edited),
            })
          ) {
            yield* CoreFileMutation.runPostProcessingStage({
              recorder: intentRecorder,
              stage: "bom",
              target: checkpointTarget,
              effect: Bom.syncFile(afs, edited, change.bom),
            })
          }
          yield* refreshUndo(CoreFileMutation.target(instance.worktree, edited))
        }

        for (const change of fileChanges) {
          if (change.type === "delete") continue
          const target = change.movePath ?? change.filePath
          yield* CoreFileMutation.runPostProcessingStage({
            recorder: intentRecorder,
            stage: "lsp_touch",
            target: CoreFileMutation.target(instance.worktree, target).resource,
            effect: lsp.touchFile(target, "document"),
          })
        }
        const diagnostics = yield* CoreFileMutation.runPostProcessingStage({
          recorder: intentRecorder,
          stage: "diagnostics",
          effect: lsp.diagnostics(),
        })

        for (const change of fileChanges) {
          const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
          if (edited) {
            yield* CoreFileMutation.runPostProcessingStage({
              recorder: intentRecorder,
              stage: "event_v2",
              target: CoreFileMutation.target(instance.worktree, edited).resource,
              effect: events.publish(FileSystem.Event.Edited, { file: edited }),
            })
          }
        }
        for (const update of updates) {
          yield* CoreFileMutation.runPostProcessingStage({
            recorder: intentRecorder,
            stage: "watcher",
            target: CoreFileMutation.target(instance.worktree, update.file).resource,
            effect: events.publish(Watcher.Event.Updated, update),
          })
        }
        return diagnostics
      })
      const diagnostics = yield* CoreFileMutation.runPostProcessingTransaction({
        recorder: intentRecorder,
        journal,
        operation: "Patch",
        effect: postCommit,
      })

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files: fileMetadata,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
