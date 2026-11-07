import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { OperationsApi } from "@/utils/server"

export type ArtifactReference = Parameters<OperationsApi["artifacts"]["read"]>[0]["reference"]
export type ArtifactOwner = ArtifactReference["owner"]
export type ArtifactReaders = Pick<OperationsApi["artifacts"], "read" | "readScoped" | "readRange" | "readScopedRange">
const SINGLE_READ_BYTES = 10 * 1024 * 1024
const RANGE_BYTES = 1024 * 1024
export const ARTIFACT_TEXT_PREVIEW_BYTES = 256 * 1024

/** Reads the immutable receipt through its existing authenticated owner route. */
export async function readArtifactContent(input: {
  readers: ArtifactReaders
  reference: ArtifactReference
  owner: ArtifactOwner
  signal: AbortSignal
}) {
  const { readers, reference, owner, signal } = input
  const cancelled = () => { if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError") }
  cancelled()
  if (reference.owner.scope !== owner.scope || reference.owner.id !== owner.id)
    throw new Error("The artifact does not belong to the selected source.")
  if (!Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 0 || reference.sizeBytes > AgentRuntime.ManagedArtifactMaxBytes)
    throw new Error("The artifact exceeds the managed content limit.")
  let bytes: Uint8Array
  if (reference.sizeBytes <= SINGLE_READ_BYTES) {
    bytes = owner.scope === "session"
      ? await readers.read({ sessionID: owner.id, reference, maxBytes: SINGLE_READ_BYTES }, { signal })
      : await readers.readScoped({ reference, maxBytes: SINGLE_READ_BYTES }, { signal })
  } else {
    bytes = new Uint8Array(reference.sizeBytes)
    for (let offset = 0; offset < reference.sizeBytes; offset += RANGE_BYTES) {
      cancelled()
      const length = Math.min(RANGE_BYTES, reference.sizeBytes - offset)
      const range = { reference, offset, length, ifMatch: reference.digest }
      const chunk = owner.scope === "session"
        ? await readers.readRange({ ...range, sessionID: owner.id }, { signal })
        : await readers.readScopedRange(range, { signal })
      cancelled()
      if (chunk.byteLength !== length) throw new Error("The artifact range was incomplete.")
      bytes.set(chunk, offset)
    }
  }
  cancelled()
  if (bytes.byteLength !== reference.sizeBytes) throw new Error("The artifact size does not match its receipt.")
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  cancelled()
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
  if (actual !== reference.digest) throw new Error("The artifact digest does not match its receipt.")
  return new Uint8Array(bytes)
}

export function artifactContentMime(reference: ArtifactReference) {
  const mime = reference.mime.split(";", 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream"
}

export function artifactTextPreview(bytes: Uint8Array, mime: string) {
  if (!mime.startsWith("text/") && !["application/json", "application/xml", "image/svg+xml"].includes(mime)) return
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, ARTIFACT_TEXT_PREVIEW_BYTES), {
      stream: bytes.byteLength > ARTIFACT_TEXT_PREVIEW_BYTES,
    })
  } catch { return }
}

export function artifactDownloadName(reference: ArtifactReference) {
  const label = reference.label?.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 160)
  if (label) return label
  const mime = artifactContentMime(reference)
  const extension = mime === "application/json" ? ".json" : mime.startsWith("text/") ? ".txt" : ".bin"
  return reference.artifactID + extension
}
