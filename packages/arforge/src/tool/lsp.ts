import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@arforge-ai/core/fs-util"
import * as LSPFallback from "../lsp/fallback"

export const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
  "status",
] as const

export type Operation = (typeof operations)[number]

const POSITION_OPERATIONS = new Set<Operation>([
  "goToDefinition",
  "findReferences",
  "hover",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
])

const FILE_OPERATIONS = new Set<Operation>([...POSITION_OPERATIONS, "documentSymbol", "workspaceSymbol", "diagnostics"])

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "The absolute or relative path to the file (required except for status)",
  }),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "The line number (1-based, required for position-based operations)",
  }),
  character: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "The character offset (1-based, required for position-based operations)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const needsFile = FILE_OPERATIONS.has(args.operation)
          const needsPosition = POSITION_OPERATIONS.has(args.operation)
          if (needsFile && !args.filePath) {
            throw new Error(`filePath is required for the ${args.operation} operation.`)
          }
          if (needsPosition && (args.line === undefined || args.character === undefined)) {
            throw new Error(`line and character are required for the ${args.operation} operation.`)
          }

          const file = args.filePath
            ? path.isAbsolute(args.filePath)
              ? args.filePath
              : path.join(instance.directory, args.filePath)
            : undefined
          if (file) yield* assertExternalDirectoryEffect(ctx, file)
          const meta =
            args.operation === "workspaceSymbol" || args.operation === "status"
              ? { operation: args.operation }
              : args.operation === "documentSymbol" || args.operation === "diagnostics"
                ? { operation: args.operation, filePath: file! }
                : { operation: args.operation, filePath: file, line: args.line, character: args.character }
          yield* ctx.ask({
            permission: "lsp",
            patterns: ["*"],
            always: ["*"],
            metadata: meta,
          })

          if (args.operation === "status") {
            const result = yield* lsp.status()
            return {
              title: "status",
              metadata: { result },
              output: JSON.stringify(result, null, 2),
            }
          }

          if (!file) throw new Error(`filePath is required for the ${args.operation} operation.`)

          const uri = pathToFileURL(file).href
          const position = {
            file,
            line: (args.line ?? 1) - 1,
            character: (args.character ?? 1) - 1,
          }
          const relPath = path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol" || args.operation === "diagnostics"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)
          const withinLimit = yield* Effect.promise(() => LSPFallback.isWithinFileLimit(file))
          if (!withinLimit) throw new Error(`LSP target must be a readable file no larger than 10 MB: ${file}`)

          const available = yield* lsp.hasClients(file)
          if (!available && !LSPFallback.isSupported(file)) {
            throw new Error("No LSP server or supported index fallback available for this file type.")
          }

          yield* lsp.touchFile(file, args.operation === "diagnostics" ? "full" : "document")

          const result: unknown = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
              case "diagnostics":
                return Effect.flatMap(lsp.diagnostics(), (all) => {
                  const normalized = FSUtil.normalizePath(file)
                  if (Object.prototype.hasOwnProperty.call(all, normalized))
                    return Effect.succeed(all[normalized] ?? [])
                  return Effect.map(
                    Effect.promise(() =>
                      LSPFallback.query("diagnostics", { file, line: 0, character: 0 }, instance.directory),
                    ),
                    (fallback) => (Array.isArray(fallback) ? fallback : []),
                  )
                })
            }
          })()

          return {
            title,
            metadata: { result },
            output:
              Array.isArray(result) && result.length === 0
                ? args.operation === "diagnostics"
                  ? `No diagnostics found for ${relPath}`
                  : `No results found for ${args.operation}`
                : JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
