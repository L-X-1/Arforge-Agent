import { readFileSync, writeFileSync } from "node:fs"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { redact } from "@arforge-ai/core/redact"

export type LogExportEntry = { name: string; path?: string; data?: Buffer }

export function redactDiagnosticBytes(data: Buffer): Buffer {
  // Crash dump bytes retain their existing format. Never decode/rewrite binary.
  if (data.includes(0)) return data
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    return data
  }
  try {
    return Buffer.from(JSON.stringify(redactValue(JSON.parse(text)), null, 2))
  } catch {
    // Each JSONL record owns its embedded JSON strings. Running a regex over
    // the escaped whole file cannot see those structured credential fields.
    return Buffer.from(
      text
        .split(/(\r\n|\n|\r)/)
        .map((part, index) => {
          if (index % 2 || !part.trim()) return part
          try {
            const leading = part.match(/^[\t ]*/)?.[0] ?? ""
            const trailing = part.match(/[\t ]*$/)?.[0] ?? ""
            return leading + JSON.stringify(redactValue(JSON.parse(part))) + trailing
          } catch {
            return redactText(part)
          }
        })
        .join(""),
    )
  }
}

const marker = "[REDACTED_SECRET]"
const secretKey =
  /^(?:authorization|proxy-authorization|api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd)$/i

function redactText(text: string) {
  // Preserve key names and quoted value syntax in JSONL/electron-log text.
  const fields = text.replace(
    /((?<![\w-])(?:["']?)(?:authorization|proxy-authorization|api[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;\r\n}]+)/gi,
    (_whole, prefix: string, value: string) =>
      prefix + (value[0] === '"' || value[0] === "'" ? value[0] + marker + value[0] : marker),
  )
  return redact(fields)
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^\s*[\[{"]/.test(value)) {
      try {
        return JSON.stringify(redactValue(JSON.parse(value)))
      } catch {}
    }
    return redactText(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && secretKey.test(value[0])) return [value[0], marker]
    return value.map(redactValue)
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? marker : redactValue(item)]),
    )
  return value
}

export async function writeDiagnosticZip(output: string, entries: LogExportEntry[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  try {
    for (const entry of entries) {
      const data = redactDiagnosticBytes(entry.data ?? readFileSync(entry.path!))
      await writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(data)])))
    }
    const zip = await writer.close()
    writeFileSync(output, Buffer.from(await zip.arrayBuffer()))
  } catch (error) {
    await writer.close().catch(() => {})
    throw error
  }
}
