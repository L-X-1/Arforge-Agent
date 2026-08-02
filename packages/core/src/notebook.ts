export * as NotebookV2 from "./notebook"

import { createHash, randomUUID } from "crypto"
import { EOL } from "os"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { LocationMutation } from "./location-mutation"
import { EffectFlock } from "./util/effect-flock"

export const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024
export const MAX_CELLS = 10_000
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_OUTPUTS_PER_CELL = 10_000
export const CELL_TYPES = ["code", "markdown", "raw"] as const
export const EDIT_MODES = ["replace", "insert", "delete"] as const

export type CellType = (typeof CELL_TYPES)[number]
export type EditMode = (typeof EDIT_MODES)[number]
type JsonObject = Record<string, unknown>
type Cell = JsonObject & {
  cell_type: CellType
  metadata: JsonObject
  source: string | string[]
  id?: string
  outputs?: unknown[]
  execution_count?: unknown
}
type Notebook = JsonObject & {
  cells: Cell[]
  metadata: JsonObject
  nbformat: 4
  nbformat_minor: number
}

export class NotebookError extends Schema.TaggedErrorClass<NotebookError>()("Notebook.Error", {
  message: Schema.String,
}) {}

export const CellSummary = Schema.Struct({
  index: Schema.Int,
  cell_id: Schema.String,
  cell_type: Schema.Literals(CELL_TYPES),
  source: Schema.String,
  source_truncated: Schema.Boolean,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  execution_count: Schema.optional(Schema.Unknown),
  output_count: Schema.optional(Schema.Int),
  outputs: Schema.optional(Schema.Array(Schema.Unknown)),
})

export const ReadResult = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  nbformat: Schema.Literal(4),
  nbformat_minor: Schema.Int,
  language: Schema.String,
  cell_count: Schema.Int,
  range: Schema.Struct({ start: Schema.Int, count: Schema.Int }),
  cells: Schema.Array(CellSummary),
})
export type ReadResult = typeof ReadResult.Type

export const EditResult = Schema.Struct({
  path: Schema.String,
  edit_mode: Schema.Literals(EDIT_MODES),
  cell_id: Schema.NullOr(Schema.String),
  cell_index: Schema.Int,
  cell_type: Schema.NullOr(Schema.Literals(CELL_TYPES)),
  language: Schema.String,
  before_sha256: Schema.String,
  after_sha256: Schema.String,
  cell_count_before: Schema.Int,
  cell_count_after: Schema.Int,
  dry_run: Schema.Boolean,
  preview: Schema.Struct({ before: Schema.String, after: Schema.String }),
  backup_path: Schema.optional(Schema.String),
})
export type EditResult = typeof EditResult.Type

export interface ReadInput {
  readonly target: LocationMutation.Target
  readonly start?: number
  readonly limit?: number
  readonly includeOutputs?: boolean
  readonly sourceLimit?: number
}

export interface EditInput {
  readonly target: LocationMutation.Target
  readonly expectedSha256: string
  readonly editMode?: EditMode
  readonly cellID?: string
  readonly newSource?: string
  readonly cellType?: CellType
  readonly dryRun?: boolean
}

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, NotebookError | FSUtil.Error>
  readonly edit: (input: EditInput) => Effect.Effect<EditResult, NotebookError | FSUtil.Error | EffectFlock.LockError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Notebook") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const locks = yield* EffectFlock.Service

    const load = Effect.fn("Notebook.load")(function* (target: LocationMutation.Target) {
      if (path.extname(target.canonical).toLowerCase() !== ".ipynb")
        return yield* fail("notebook path must end with .ipynb")
      const info = yield* fs.stat(target.canonical).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => fail("notebook file does not exist")),
      )
      if (info.type !== "File") return yield* fail("notebook file does not exist")
      if (Number(info.size) > MAX_NOTEBOOK_BYTES) return yield* fail("notebook exceeds the 10 MB file limit")
      const raw = yield* fs.readFile(target.canonical)
      if (raw.byteLength > MAX_NOTEBOOK_BYTES) return yield* fail("notebook exceeds the 10 MB file limit")
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/, ""),
        catch: () => new NotebookError({ message: "notebook must use UTF-8 encoding" }),
      })
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          new NotebookError({
            message:
              cause instanceof SyntaxError
                ? `notebook is not valid JSON${jsonErrorLocation(cause)}`
                : "notebook is not valid JSON",
          }),
      })
      return { raw, notebook: yield* attempt(() => validateNotebook(parsed)) }
    })

    const read = Effect.fn("Notebook.read")(function* (input: ReadInput) {
      const start = input.start ?? 0
      const limit = input.limit ?? 20
      const sourceLimit = input.sourceLimit ?? 4_000
      if (!Number.isInteger(start) || start < 0) return yield* fail("start must be non-negative")
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return yield* fail("limit must be between 1 and 100")
      if (!Number.isInteger(sourceLimit) || sourceLimit < 100 || sourceLimit > 20_000)
        return yield* fail("source_limit must be between 100 and 20000")

      const { raw, notebook } = yield* load(input.target)
      const summaries = notebook.cells.slice(start, start + limit).map((cell, offset) => {
        const index = start + offset
        const source = sourceText(cell.source)
        const shortened = shortSource(source, sourceLimit)
        const base = {
          index,
          cell_id: cellLocator(cell, index),
          cell_type: cell.cell_type,
          source: shortened.value,
          source_truncated: shortened.truncated,
          metadata: structuredClone(cell.metadata),
        }
        return cell.cell_type === "code"
          ? {
              ...base,
              execution_count: cell.execution_count,
              output_count: cell.outputs!.length,
              ...(input.includeOutputs === true ? { outputs: structuredClone(cell.outputs!) } : {}),
            }
          : base
      })
      return {
        path: input.target.canonical,
        sha256: sha256(raw),
        nbformat: 4 as const,
        nbformat_minor: notebook.nbformat_minor,
        language: language(notebook),
        cell_count: notebook.cells.length,
        range: { start, count: summaries.length },
        cells: summaries,
      }
    })

    const edit = Effect.fn("Notebook.edit")(function* (input: EditInput) {
      const editMode = input.editMode ?? "replace"
      const newSource = input.newSource ?? ""
      if (!EDIT_MODES.includes(editMode)) return yield* fail("edit_mode must be replace, insert, or delete")
      if (input.cellType !== undefined && !CELL_TYPES.includes(input.cellType))
        return yield* fail("cell_type must be code, markdown, or raw")
      if (editMode === "insert" && input.cellType === undefined)
        return yield* fail("cell_type is required for insert operations")
      if (editMode !== "insert" && !input.cellID)
        return yield* fail("cell_id is required for replace and delete operations")
      if (editMode !== "delete") yield* attempt(() => sourceValue(newSource))
      const expected = input.expectedSha256.trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expected))
        return yield* fail("expected_sha256 must be a 64-character hexadecimal digest")

      return yield* locks.withLock(
        Effect.gen(function* () {
          const { raw, notebook } = yield* load(input.target)
          const currentSha = sha256(raw)
          if (currentSha !== expected)
            return yield* fail("notebook changed since it was read; read it again before editing")

          const beforeCount = notebook.cells.length
          let beforeSource = ""
          let afterSource = ""
          let targetIndex = 0
          let resultCellID: string | null = input.cellID ?? null

          if (editMode === "insert") {
            if (input.cellID) targetIndex = (yield* attempt(() => findCell(notebook.cells, input.cellID))) + 1
            const cell = makeCell(notebook, input.cellType!, newSource)
            notebook.cells.splice(targetIndex, 0, cell)
            resultCellID = cellLocator(cell, targetIndex)
            afterSource = newSource
          } else {
            targetIndex = yield* attempt(() => findCell(notebook.cells, input.cellID))
            const target = notebook.cells[targetIndex]!
            resultCellID = cellLocator(target, targetIndex)
            beforeSource = sourceText(target.source)
            if (editMode === "delete") {
              notebook.cells.splice(targetIndex, 1)
            } else {
              target.source = sourceValue(newSource, target.source)
              if (input.cellType !== undefined) convertCell(target, input.cellType)
              if (target.cell_type === "code") {
                target.execution_count = null
                target.outputs = []
              }
              afterSource = newSource
            }
          }

          yield* attempt(() => validateNotebook(notebook))
          const updatedText = (JSON.stringify(notebook, null, 1) + "\n").replaceAll("\n", EOL)
          const updatedBytes = new TextEncoder().encode(updatedText)
          if (updatedBytes.byteLength > MAX_NOTEBOOK_BYTES)
            return yield* fail("edited notebook would exceed the 10 MB file limit")
          const updatedSha = sha256(updatedBytes)
          const result: EditResult = {
            path: input.target.canonical,
            edit_mode: editMode,
            cell_id: resultCellID,
            cell_index: targetIndex,
            cell_type: input.cellType ?? null,
            language: language(notebook),
            before_sha256: currentSha,
            after_sha256: updatedSha,
            cell_count_before: beforeCount,
            cell_count_after: notebook.cells.length,
            dry_run: input.dryRun === true,
            preview: {
              before: shortSource(beforeSource, 2_000).value,
              after: shortSource(afterSource, 2_000).value,
            },
          }
          if (input.dryRun === true) return result

          const token = randomUUID()
          const temporary = `${input.target.canonical}.${token}.tmp`
          const backup = `${input.target.canonical}.${new Date().toISOString().replaceAll(":", "-")}.${token}.bak`
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* fs.writeFile(temporary, updatedBytes, { flag: "wx" })
              yield* fs.copyFile(input.target.canonical, backup)
              yield* fs.rename(temporary, input.target.canonical).pipe(
                Effect.catch((error) =>
                  fs
                    .copyFile(backup, input.target.canonical)
                    .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
                ),
              )
              const actual = yield* fs.readFile(input.target.canonical)
              if (sha256(actual) !== updatedSha) {
                yield* fs.copyFile(backup, input.target.canonical).pipe(Effect.ignore)
                return yield* fail("notebook write verification failed")
              }
            }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore))),
          )
          return { ...result, backup_path: backup }
        }),
        `notebook:${input.target.canonical}`,
      )
    })

    return Service.of({ read, edit })
  }),
)

const fail = (message: string) => Effect.fail(new NotebookError({ message }))
const attempt = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof NotebookError
        ? cause
        : new NotebookError({ message: cause instanceof Error ? cause.message : "invalid notebook" }),
  })
const sha256 = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")

function jsonErrorLocation(error: SyntaxError) {
  const match = error.message.match(/position\s+(\d+)/i)
  return match ? ` near byte ${match[1]}` : ""
}

function sourceText(source: unknown): string {
  if (typeof source === "string") return source
  if (Array.isArray(source) && source.every((item) => typeof item === "string")) return source.join("")
  throw new NotebookError({ message: "cell source must be a string or a list of strings" })
}

function sourceValue(source: string, previous?: unknown): string | string[] {
  if (typeof source !== "string") throw new NotebookError({ message: "new_source must be a string" })
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES)
    throw new NotebookError({ message: "cell source exceeds the 2 MB limit" })
  if (typeof previous === "string") return source
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function validateNotebook(value: unknown): Notebook {
  if (!isObject(value)) throw new NotebookError({ message: "notebook root must be a JSON object" })
  if (value.nbformat !== 4) throw new NotebookError({ message: "only nbformat 4 notebooks are supported" })
  if (!Number.isInteger(value.nbformat_minor) || (value.nbformat_minor as number) < 0)
    throw new NotebookError({ message: "nbformat_minor must be a non-negative integer" })
  if (!isObject(value.metadata)) throw new NotebookError({ message: "notebook metadata must be an object" })
  if (!Array.isArray(value.cells)) throw new NotebookError({ message: "notebook cells must be an array" })
  if (value.cells.length > MAX_CELLS)
    throw new NotebookError({ message: `notebook exceeds the ${MAX_CELLS} cell limit` })

  const ids = new Set<string>()
  value.cells.forEach((candidate, index) => {
    if (!isObject(candidate)) throw new NotebookError({ message: `cell ${index} must be an object` })
    if (!CELL_TYPES.includes(candidate.cell_type as CellType))
      throw new NotebookError({ message: `cell ${index} has unsupported type: ${String(candidate.cell_type)}` })
    if (!isObject(candidate.metadata))
      throw new NotebookError({ message: `cell ${index} metadata must be an object` })
    const source = sourceText(candidate.source)
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES)
      throw new NotebookError({ message: `cell ${index} source exceeds the 2 MB limit` })
    if (candidate.id !== undefined) {
      if (typeof candidate.id !== "string" || candidate.id.length === 0)
        throw new NotebookError({ message: `cell ${index} id must be a non-empty string` })
      if (ids.has(candidate.id)) throw new NotebookError({ message: `duplicate cell id: ${candidate.id}` })
      ids.add(candidate.id)
    }
    if (candidate.cell_type === "code") {
      if (!Array.isArray(candidate.outputs))
        throw new NotebookError({ message: `code cell ${index} outputs must be an array` })
      if (candidate.outputs.length > MAX_OUTPUTS_PER_CELL)
        throw new NotebookError({
          message: `code cell ${index} exceeds the ${MAX_OUTPUTS_PER_CELL} output limit`,
        })
    }
  })
  return value as Notebook
}

function findCell(cells: Cell[], locator?: string) {
  if (!locator) throw new NotebookError({ message: "cell_id is required for replace and delete operations" })
  const byID = cells.findIndex((cell) => cell.id === locator)
  if (byID >= 0) return byID
  const match = locator.match(/^cell-(\d+)$/)
  if (match) {
    const index = Number(match[1])
    if (index < cells.length) return index
    throw new NotebookError({ message: `cell index ${index} does not exist` })
  }
  throw new NotebookError({ message: `cell id not found: ${locator}` })
}

function newCellID(notebook: Notebook) {
  if (notebook.nbformat_minor < 5) return
  const existing = new Set(notebook.cells.flatMap((cell) => (cell.id ? [cell.id] : [])))
  while (true) {
    const candidate = randomUUID().replaceAll("-", "").slice(0, 12)
    if (!existing.has(candidate)) return candidate
  }
}

function makeCell(notebook: Notebook, cellType: CellType, source: string): Cell {
  const cell: Cell = { cell_type: cellType, metadata: {}, source: sourceValue(source) }
  const id = newCellID(notebook)
  if (id) cell.id = id
  if (cellType === "code") {
    cell.execution_count = null
    cell.outputs = []
  }
  return cell
}

function convertCell(cell: Cell, cellType: CellType) {
  if (cell.cell_type === cellType) return
  cell.cell_type = cellType
  if (cellType === "code") {
    cell.execution_count = null
    cell.outputs = []
  } else {
    delete cell.execution_count
    delete cell.outputs
  }
}

function cellLocator(cell: Cell, index: number) {
  return cell.id || `cell-${index}`
}

function shortSource(source: string, limit: number) {
  return source.length <= limit
    ? { value: source, truncated: false }
    : { value: `${source.slice(0, limit)}\n...[truncated]`, truncated: true }
}

function language(notebook: Notebook) {
  const languageInfo = isObject(notebook.metadata.language_info) ? notebook.metadata.language_info : undefined
  if (typeof languageInfo?.name === "string" && languageInfo.name) return languageInfo.name
  const kernelspec = isObject(notebook.metadata.kernelspec) ? notebook.metadata.kernelspec : undefined
  if (typeof kernelspec?.language === "string" && kernelspec.language) return kernelspec.language
  return "unknown"
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, EffectFlock.node],
})
