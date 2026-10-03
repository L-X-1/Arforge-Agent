import { unpackOffice } from "./office-archive"

self.onmessage = (event: MessageEvent<Uint8Array>) => {
  try {
    const files = unpackOffice(event.data)
    self.postMessage({ files }, { transfer: Object.values(files).map((bytes) => bytes.buffer as ArrayBuffer) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "office-invalid-archive" })
  }
}
