export * as MultimodalDiagnosisV2 from "./multimodal-diagnosis"

import { MultimodalDiagnosis } from "@arforge-ai/schema/multimodal-diagnosis"
import { Context, Effect, Layer, Schema } from "effect"
import { spawn } from "node:child_process"
import path from "node:path"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { Ripgrep } from "./ripgrep"

const MAX_TEXT_CHARS = 250_000
const MAX_COMMAND_BYTES = 2 * 1024 * 1024
const CODE_GLOB = "*.{py,js,jsx,ts,tsx,go,rs}"
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"])
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".rst", ".log", ".json", ".yaml", ".yml"])

export const Input = Schema.Struct({
  filename: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  extractedText: Schema.String.check(Schema.isMaxLength(500_000)).pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).pipe(Schema.optional),
})
export type Input = typeof Input.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("MultimodalDiagnosis.PathError", {
  filename: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Invalid diagnostic path ${this.filename}: ${this.reason}`
  }
}

export interface Interface {
  readonly diagnose: (input: Input) => Effect.Effect<MultimodalDiagnosis.Result, PathError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/MultimodalDiagnosis") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const ripgrep = yield* Ripgrep.Service

    const extract = Effect.fn("MultimodalDiagnosis.extract")(function* (
      canonical: string,
      resource: string,
      extractedText?: string,
    ) {
      if (extractedText !== undefined) return sourceText("provided_text", resource, extractedText)
      if (!(yield* fs.existsSafe(canonical))) {
        return MultimodalDiagnosis.Source.make({
          success: false,
          type: "missing",
          path: resource,
          text: "",
          truncated: false,
          error: "File not found",
        })
      }

      const extension = path.extname(canonical).toLowerCase()
      if (TEXT_EXTENSIONS.has(extension)) {
        const text = yield* fs.readFileStringSafe(canonical).pipe(Effect.orElseSucceed(() => undefined))
        if (text === undefined)
          return MultimodalDiagnosis.Source.make({
            success: false,
            type: "document",
            path: resource,
            text: "",
            truncated: false,
            error: "The document could not be read as UTF-8 text",
          })
        return sourceText("document", resource, text)
      }

      if (extension === ".pdf") {
        const extracted = yield* Effect.promise(() => runLocalCommand("pdftotext", [canonical, "-"]))
        if (extracted.ok) return sourceText("document", resource, extracted.stdout)
        return MultimodalDiagnosis.Source.make({
          success: false,
          type: "document",
          path: resource,
          text: "",
          truncated: false,
          error: `Local PDF extraction unavailable: ${extracted.error}. Provide extractedText to diagnose without it.`,
        })
      }

      if (extension === ".docx") {
        return MultimodalDiagnosis.Source.make({
          success: false,
          type: "document",
          path: resource,
          text: "",
          truncated: false,
          error: "Local DOCX extraction is unavailable. Export as text/Markdown or provide extractedText.",
        })
      }

      if (IMAGE_EXTENSIONS.has(extension)) {
        const bytes = yield* fs.readFile(canonical).pipe(Effect.orElseSucceed(() => new Uint8Array()))
        const image = yield* inspectImage(bytes, extension)
        const bilingual = yield* Effect.promise(() =>
          runLocalCommand("tesseract", [canonical, "stdout", "-l", "chi_sim+eng"]),
        )
        const extracted = bilingual.ok
          ? bilingual
          : yield* Effect.promise(() => runLocalCommand("tesseract", [canonical, "stdout", "-l", "eng"]))
        if (extracted.ok) {
          const source = sourceText("image_ocr", resource, extracted.stdout)
          return MultimodalDiagnosis.Source.make({ ...source, engine: "tesseract", image })
        }
        return MultimodalDiagnosis.Source.make({
          success: false,
          type: "image_ocr",
          path: resource,
          text: "",
          truncated: false,
          engine: "tesseract",
          image,
          error: `Local OCR unavailable: ${extracted.error}. Install Tesseract or provide extractedText.`,
        })
      }

      return MultimodalDiagnosis.Source.make({
        success: false,
        type: "unsupported",
        path: resource,
        text: "",
        truncated: false,
        error: `Unsupported diagnostic file type: ${extension || "(none)"}`,
      })
    })

    const diagnose = Effect.fn("MultimodalDiagnosis.diagnose")(function* (input: Input) {
      const target = yield* mutation.resolve({ path: input.filename, kind: "file" }).pipe(
        Effect.mapError(
          (error) =>
            new PathError({
              filename: input.filename,
              reason: error instanceof LocationMutation.PathError ? error.reason : "unable to resolve path",
            }),
        ),
      )
      if (target.externalDirectory)
        return yield* new PathError({ filename: input.filename, reason: "path escapes the active location" })

      const source = yield* extract(target.canonical, target.resource, input.extractedText)
      const signals = extractErrorSignals(source.text)
      const searchTerms = searchTermsFor(signals, source.text)
      const limit = input.limit ?? 8
      const searched =
        searchTerms.length === 0
          ? { matches: [] as MultimodalDiagnosis.Match[], warning: undefined }
          : yield* ripgrep
              .grep({
                cwd: location.directory,
                pattern: `(?i)(?:${searchTerms.map(escapeRegex).join("|")})`,
                include: CODE_GLOB,
                limit,
              })
              .pipe(
                Effect.map((matches) => ({
                  matches: matches.map((match) => {
                    const preview = match.text.trim().slice(0, 240)
                    const lower = preview.toLowerCase()
                    return MultimodalDiagnosis.Match.make({
                      file: match.entry.path.replaceAll("\\", "/"),
                      line: match.line,
                      terms: searchTerms.filter((term) => lower.includes(term.toLowerCase())).toSorted(),
                      preview,
                    })
                  }),
                  warning: undefined,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    matches: [] as MultimodalDiagnosis.Match[],
                    warning: `Workspace code search was unavailable: ${error.message}`,
                  }),
                ),
              )
      const suggestions = buildRepairSuggestions(signals, searched.matches, source)
      return MultimodalDiagnosis.Result.make({
        schemaVersion: 1,
        localOnly: true,
        modelCalls: 0,
        success: source.success && source.text.trim().length > 0,
        path: target.resource,
        source,
        signals,
        searchTerms,
        matches: searched.matches,
        suggestions,
        warnings: searched.warning ? [searched.warning] : [],
        summary: {
          textChars: source.text.length,
          signals: signals.length,
          searchTerms: searchTerms.length,
          matches: searched.matches.length,
        },
      })
    })

    return Service.of({ diagnose })
  }),
)

export const extractErrorSignals = (text: string): MultimodalDiagnosis.Signal[] => {
  const signals: MultimodalDiagnosis.Signal[] = []
  const seen = new Set<string>()
  const add = (signal: MultimodalDiagnosis.Signal) => {
    const key = `${signal.kind}\u0000${signal.value}\u0000${signal.line ?? 0}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push(signal)
  }

  for (const match of text.matchAll(/File "([^"]+)", line (\d+)/g)) {
    add({
      kind: "file_line",
      value: match[1],
      line: Number(match[2]),
      raw: match[0],
    })
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b(?::\s*([^\n]+))?/g)) {
    add({
      kind: "exception",
      value: match[1],
      ...(match[2]?.trim() ? { detail: match[2].trim() } : {}),
      raw: match[0].trim(),
    })
  }
  const missing: ReadonlyArray<readonly [RegExp, MultimodalDiagnosis.SignalKind]> = [
    [/name ['"]([^'"]+)['"] is not defined/gi, "missing_name"],
    [/No module named ['"]([^'"]+)['"]/gi, "missing_module"],
    [/cannot import name ['"]([^'"]+)['"]/gi, "missing_import"],
    [/Module not found: Can't resolve ['"]([^'"]+)['"]/gi, "missing_module"],
  ]
  for (const [pattern, kind] of missing) {
    for (const match of text.matchAll(pattern)) {
      add({ kind, value: match[1], raw: match[0] })
    }
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_./\\-]+\.(?:py|js|jsx|ts|tsx|go|rs))\b/g)) {
    add({ kind: "file_reference", value: match[1].replaceAll("\\", "/"), raw: match[0] })
  }
  return signals
}

export const buildRepairSuggestions = (
  signals: ReadonlyArray<MultimodalDiagnosis.Signal>,
  matches: ReadonlyArray<MultimodalDiagnosis.Match>,
  source: MultimodalDiagnosis.Source,
) => {
  const suggestions: string[] = []
  const files = signals.filter((signal) => signal.kind === "file_line" || signal.kind === "file_reference")
  const exceptions = signals.filter((signal) => signal.kind === "exception")
  const missing = signals.filter((signal) => signal.kind.startsWith("missing_"))
  const first = files[0]
  if (first) suggestions.push(`Inspect the referenced file first: ${first.value}${first.line ? `:${first.line}` : ""}.`)
  if (missing.length > 0)
    suggestions.push(
      `Search definitions/imports for missing symbol or module: ${[...new Set(missing.map((item) => item.value))]
        .toSorted()
        .join(", ")}.`,
    )
  if (exceptions.length > 0)
    suggestions.push(
      `Reproduce the failing path and add a focused regression for: ${[...new Set(exceptions.map((item) => item.value))]
        .toSorted()
        .join(", ")}.`,
    )
  if (matches.length > 0)
    suggestions.push(
      `Start with matched code locations before editing: ${[...new Set(matches.map((item) => item.file))]
        .toSorted()
        .slice(0, 5)
        .join(", ")}.`,
    )
  if (!source.success)
    suggestions.push("Text extraction did not succeed; install/configure a local extractor or provide extractedText.")
  if (suggestions.length === 0)
    suggestions.push(
      "No strong error signal was found; inspect the extracted text and provide a clearer screenshot or log.",
    )
  return suggestions
}

export const format = (result: MultimodalDiagnosis.Result) => {
  const lines = [
    "Multimodal diagnosis",
    `- local_only: ${result.localOnly}`,
    `- model_calls: ${result.modelCalls}`,
    `- source_type: ${result.source.type}`,
    `- extraction_success: ${result.source.success}`,
    `- text_chars: ${result.summary.textChars}`,
    `- signals: ${result.summary.signals}`,
    `- matches: ${result.summary.matches}`,
  ]
  if (result.source.error) lines.push(`- extraction_error: ${result.source.error}`)
  if (result.signals.length > 0) {
    lines.push("", "Signals:")
    for (const signal of result.signals.slice(0, 12))
      lines.push(`- ${signal.kind} ${signal.value}${signal.line ? `:${signal.line}` : ""}`)
  }
  if (result.matches.length > 0) {
    lines.push("", "Code matches:")
    for (const match of result.matches.slice(0, 12))
      lines.push(`- ${match.file}:${match.line} [${match.terms.join(", ")}] ${match.preview}`)
  }
  if (result.warnings.length > 0) lines.push("", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`))
  lines.push("", "Suggestions:", ...result.suggestions.map((suggestion) => `- ${suggestion}`))
  return lines.join("\n")
}

const sourceText = (
  type: "provided_text" | "document" | "image_ocr",
  resource: string,
  input: string,
): MultimodalDiagnosis.Source => {
  const normalized = input.replaceAll("\u0000", "")
  const truncated = normalized.length > MAX_TEXT_CHARS
  const text = normalized.slice(0, MAX_TEXT_CHARS)
  return MultimodalDiagnosis.Source.make({
    success: text.trim().length > 0,
    type,
    path: resource,
    text,
    truncated,
    ...(!text.trim() ? { error: "No text was extracted" } : {}),
  })
}

const searchTermsFor = (signals: ReadonlyArray<MultimodalDiagnosis.Signal>, text: string) => {
  const terms: string[] = []
  for (const signal of signals) {
    const value = signal.value.trim()
    if (value) terms.push(/[./\\]/.test(value) ? path.parse(value).name : value)
    const detail = signal.detail?.trim() ?? ""
    for (const match of detail.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]{2,})['"]/g)) terms.push(match[1])
    terms.push(...(detail.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).slice(0, 6))
  }
  if (terms.length === 0) terms.push(...(text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).slice(0, 6))
  return [...new Set(terms.filter((term) => term.length > 1))].slice(0, 12)
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const inspectImage = (bytes: Uint8Array, extension: string) => {
  const base = { bytes: bytes.byteLength, format: extension.slice(1) }
  return Effect.tryPromise({
    try: async () => {
      const photon = await import("@silvia-odwyer/photon-node")
      const image = photon.PhotonImage.new_from_byteslice(bytes)
      try {
        return MultimodalDiagnosis.ImageMetadata.make({
          ...base,
          width: image.get_width(),
          height: image.get_height(),
        })
      } finally {
        image.free()
      }
    },
    catch: (error) =>
      MultimodalDiagnosis.ImageMetadata.make({
        ...base,
        error: error instanceof Error ? error.message : "Image metadata could not be decoded",
      }),
  }).pipe(Effect.catch((metadata) => Effect.succeed(metadata)))
}

type CommandResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string }

const runLocalCommand = (command: string, args: ReadonlyArray<string>): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: `${command} timed out after 20 seconds` })
    }, 20_000)
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_COMMAND_BYTES) {
        child.kill()
        finish({ ok: false, error: `${command} output exceeded ${MAX_COMMAND_BYTES} bytes` })
      } else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => finish({ ok: false, error: error.message }))
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout: Buffer.concat(stdout).toString("utf8") })
      else finish({ ok: false, error: Buffer.concat(stderr).toString("utf8").trim() || `${command} exited ${code}` })
    })
  })

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, LocationMutation.node, Ripgrep.node],
})
