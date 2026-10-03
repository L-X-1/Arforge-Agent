import { describe, expect, test } from "bun:test"
import { resolvePreview } from "./registry"

describe("preview registry", () => {
  test.each([
    ["E:\\project\\notes.MD", "markdown"],
    ["/workspace/a b/page.HTML", "html"],
    ["/workspace/image.png", "image"],
    ["/workspace/voice.mp3", "audio"],
    ["/workspace/report.PDF", "pdf"],
    ["/workspace/report.docx", "office"],
    ["/workspace/table.xlsx", "office"],
    ["/workspace/slides.pptx", "office"],
    ["/workspace/src/app.ts", "text"],
    ["/workspace/LICENSE", "text"],
  ] as const)("routes %s to %s", (path, kind) => {
    expect(resolvePreview(path, { type: "text" }).kind).toBe(kind)
  })

  test("uses explicit MIME metadata before an ambiguous extension", () => {
    expect(resolvePreview("download", { mimeType: "APPLICATION/PDF; charset=binary", type: "binary" }).kind).toBe("pdf")
    expect(resolvePreview("fake.png", { mimeType: "text/html", type: "text" }).mode).toBe("source")
  })

  test("MDX remains source-only instead of executing components", () => {
    expect(resolvePreview("component.mdx", { type: "text" })).toMatchObject({
      renderer: "existing", mode: "source", capabilities: { source: true, preview: false, edit: false },
    })
  })

  test("HTML offers an opt-in safe preview while defaulting to source", () => {
    expect(resolvePreview("index.html", { type: "text" })).toMatchObject({
      renderer: "existing", mode: "source", capabilities: { source: true, preview: true, edit: false },
    })
    expect(resolvePreview("index.html", { type: "text", encoding: "base64" }).capabilities.preview).toBe(false)
  })

  test("plain Markdown offers source and read-only preview, but not editing", () => {
    expect(resolvePreview("README.md", { type: "text" })).toMatchObject({
      renderer: "existing", mode: "source", capabilities: { source: true, preview: true, edit: false },
    })
  })

  test("keeps existing image and audio rendering for encoded media", () => {
    for (const path of ["photo.png", "drawing.svg", "recording.wav"]) {
      expect(resolvePreview(path, { type: "binary", encoding: "base64" }).renderer).toBe("existing")
    }
  })

  test("does not send unknown or encoded binary content to the text renderer", () => {
    expect(resolvePreview("unknown.dat", { type: "binary" }).kind).toBe("binary")
    expect(resolvePreview("notes.md", { type: "text", encoding: "base64" }).renderer).toBe("unavailable")
    expect(resolvePreview("unknown", { type: "binary" }).capabilities.source).toBe(false)
  })

  test("routes PDF to its local read-only adapter without exposing binary source", () => {
    expect(resolvePreview("report.pdf", { type: "binary", encoding: "base64" })).toMatchObject({
      renderer: "existing", mode: "preview", capabilities: { source: false, preview: true, edit: false },
    })
  })

  test("routes modern Office documents to local read-only content previews", () => {
    for (const path of ["report.docx", "data.xlsx", "slides.pptx"]) {
      expect(resolvePreview(path, { type: "binary" })).toMatchObject({
        renderer: "existing", mode: "preview", capabilities: { source: false, preview: true, edit: false },
      })
    }
  })

  test("keeps legacy and macro-enabled Office formats unavailable", () => {
    for (const path of ["report.doc", "data.xls", "slides.ppt", "report.docm", "data.xlsm", "slides.pptm"]) {
      expect(resolvePreview(path, { type: "binary" })).toMatchObject({
        renderer: "unavailable", mode: "unavailable", capabilities: { source: false, preview: false, edit: false },
      })
    }
  })

  test("only uses the filename extension, without rewriting the document identity", () => {
    expect(resolvePreview("/folder.pdf/source", { type: "text" }).kind).toBe("text")
    expect(resolvePreview("/a/image.png.ts", { type: "text" }).kind).toBe("text")
    expect(resolvePreview("/a/\u4e2d\u6587\u6587\u4ef6.md", { type: "text" }).kind).toBe("markdown")
  })
})
