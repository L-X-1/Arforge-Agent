// Vite resolves these relative to this module in both web and desktop builds.
// Only application-owned, version-matched assets can be requested by a PDF.
const assets = import.meta.glob<string>([
  "../../../node_modules/pdfjs-dist/cmaps/*.bcmap",
  "../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
  "../../../node_modules/pdfjs-dist/wasm/*.wasm",
  "!../../../node_modules/pdfjs-dist/wasm/quickjs*",
], { eager: true, query: "?url", import: "default" })

const folders: Readonly<Record<string, string>> = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
}

export function pdfAssetFactory(signal: AbortSignal) {
  return class LocalPdfAssets {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      const folder = folders[kind]
      const url = folder && assets["../../../node_modules/pdfjs-dist/" + folder + "/" + filename]
      if (!url) throw new Error("PDF resource is not included in the local renderer.")
      const response = await fetch(url, { signal, credentials: "omit" })
      if (!response.ok) throw new Error("A local PDF resource could not be loaded.")
      return new Uint8Array(await response.arrayBuffer())
    }
  }
}
