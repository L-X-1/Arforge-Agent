import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Location } from "@arforge-ai/core/location"
import { extractOfficeText, MultimodalDiagnosisV2 } from "@arforge-ai/core/multimodal-diagnosis"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { MultimodalDiagnoseTool } from "@arforge-ai/core/tool/multimodal-diagnose"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const traceback = `Traceback (most recent call last):
  File "app.py", line 3, in <module>
    result = process_order(payload)
NameError: name 'process_order' is not defined
`

const zipFixture = (entries: ReadonlyArray<readonly [string, string]>, method: "store" | "deflate" = "deflate") => {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name, "utf8")
    const uncompressed = Buffer.from(text, "utf8")
    const compressed = method === "deflate" ? deflateRawSync(uncompressed) : uncompressed
    const local = Buffer.alloc(30 + nameBytes.byteLength)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method === "deflate" ? 8 : 0, 8)
    local.writeUInt32LE(crc32(uncompressed), 14)
    local.writeUInt32LE(compressed.byteLength, 18)
    local.writeUInt32LE(uncompressed.byteLength, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    nameBytes.copy(local, 30)
    localParts.push(local, compressed)

    const central = Buffer.alloc(46 + nameBytes.byteLength)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method === "deflate" ? 8 : 0, 10)
    central.writeUInt32LE(crc32(uncompressed), 16)
    central.writeUInt32LE(compressed.byteLength, 20)
    central.writeUInt32LE(uncompressed.byteLength, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    centralParts.push(central)
    offset += local.byteLength + compressed.byteLength
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, eocd])
}

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

describe("MultimodalDiagnosis", () => {
  test("extracts DOCX, XLSX, and PPTX text through the bounded OOXML reader", () => {
    const docx = extractOfficeText(
      zipFixture([
        [
          "word/document.xml",
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>错误 &amp; 处理</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t><w:tab/><w:t>值</w:t></w:r></w:p></w:body></w:document>',
        ],
      ]),
      ".docx",
    )
    expect(docx).toEqual({ ok: true, engine: "ooxml", text: "错误 & 处理\n第二段\t值" })

    const xlsx = extractOfficeText(
      zipFixture(
        [
          [
            "xl/sharedStrings.xml",
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>共享</t></si><si><r><t>多</t></r><r><t>段</t></r></si></sst>',
          ],
          [
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>内联</t></is></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
          ],
        ],
        "store",
      ),
      ".xlsx",
    )
    expect(xlsx).toEqual({ ok: true, engine: "ooxml", text: "共享\t内联\nTRUE\t42" })

    const pptx = extractOfficeText(
      zipFixture([
        [
          "ppt/slides/slide10.xml",
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:cSld></p:sld>',
        ],
        [
          "ppt/slides/slide2.xml",
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:cSld></p:sld>',
        ],
      ]),
      ".pptx",
    )
    expect(pptx).toEqual({ ok: true, engine: "ooxml", text: "第二页\n\n第十页" })

    const alternatePrefix = extractOfficeText(
      zipFixture([
        [
          "word/document.xml",
          '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>可变前缀</x:t></x:r></x:p></x:body></x:document>',
        ],
      ]),
      ".docx",
    )
    expect(alternatePrefix).toEqual({ ok: true, engine: "ooxml", text: "可变前缀" })
  })

  test("fails closed on malformed Office containers and unsafe ZIP paths", () => {
    expect(extractOfficeText(Buffer.from("not a zip"), ".docx")).toMatchObject({
      ok: false,
      error: "Office document is not a valid ZIP container",
    })
    expect(
      extractOfficeText(
        zipFixture([
          ["word/../evil.xml", "nope"],
          ["word/document.xml", "<w:document />"],
        ]),
        ".docx",
      ),
    ).toMatchObject({ ok: false, error: "Office archive contains an unsafe entry path" })

    const corrupt = Buffer.from(
      zipFixture([
        ["word/document.xml", '<w:document xmlns:w="urn:w"><w:body><w:p><w:t>完整性</w:t></w:p></w:body></w:document>'],
      ]),
    )
    const centralOffset = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    corrupt.writeUInt32LE(0, centralOffset + 16)
    expect(extractOfficeText(corrupt, ".docx")).toMatchObject({
      ok: false,
      error: "Office entry integrity check failed: word/document.xml",
    })
  })

  test("treats CSV and TSV as bounded local document sources", async () => {
    await using workspace = await tmpdir()
    await fs.writeFile(path.join(workspace.path, "metrics.csv"), "name,total\nJune,128\n", "utf8")
    await fs.writeFile(path.join(workspace.path, "metrics.tsv"), "name\ttotal\nJuly\t144\n", "utf8")
    const active = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(workspace.path) })),
    )
    const program = Effect.gen(function* () {
      const diagnosis = yield* MultimodalDiagnosisV2.Service
      const csv = yield* diagnosis.diagnose({ filename: "metrics.csv" })
      const tsv = yield* diagnosis.diagnose({ filename: "metrics.tsv" })
      expect(csv).toMatchObject({ success: true, source: { type: "document", text: "name,total\nJune,128\n" } })
      expect(tsv).toMatchObject({ success: true, source: { type: "document", text: "name\ttotal\nJuly\t144\n" } })
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(AppNodeBuilder.build(MultimodalDiagnosisV2.node, [[Location.node, active]])),
        Effect.scoped,
      ),
    )
  })

  test("extracts stable traceback, exception, and missing-name signals", () => {
    expect(MultimodalDiagnosisV2.extractErrorSignals(traceback)).toEqual(
      expect.arrayContaining([
        {
          kind: "file_line",
          value: "app.py",
          line: 3,
          raw: 'File "app.py", line 3',
        },
        expect.objectContaining({ kind: "exception", value: "NameError" }),
        {
          kind: "missing_name",
          value: "process_order",
          raw: "name 'process_order' is not defined",
        },
      ]),
    )
  })

  test("runs a zero-model local document-to-code diagnosis and rejects path escape", async () => {
    await using workspace = await tmpdir()
    await fs.writeFile(path.join(workspace.path, "error.md"), traceback)
    await fs.writeFile(
      path.join(workspace.path, "report.docx"),
      zipFixture([
        [
          "word/document.xml",
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>AttributeError: missing report renderer</w:t></w:r></w:p></w:body></w:document>',
        ],
      ]),
    )
    await fs.writeFile(path.join(workspace.path, "app.py"), "def run(payload):\n    return process_order(payload)\n")
    await fs.writeFile(path.join(workspace.path, "orders.py"), "def process_order(payload):\n    return payload\n")
    const active = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(workspace.path) })),
    )
    const program = Effect.gen(function* () {
      const diagnosis = yield* MultimodalDiagnosisV2.Service
      const result = yield* diagnosis.diagnose({ filename: "error.md", limit: 8 })

      expect(result).toMatchObject({
        localOnly: true,
        modelCalls: 0,
        success: true,
        source: { type: "document", success: true },
      })
      expect(result.searchTerms).toContain("process_order")
      expect(result.matches.map((match) => match.file)).toEqual(expect.arrayContaining(["app.py", "orders.py"]))
      expect(result.suggestions.some((suggestion) => suggestion.includes("missing symbol"))).toBe(true)
      const office = yield* diagnosis.diagnose({ filename: "report.docx" })
      expect(office).toMatchObject({
        success: true,
        source: { type: "document", engine: "ooxml", text: "AttributeError: missing report renderer" },
      })
      expect(yield* Effect.flip(diagnosis.diagnose({ filename: "../outside.txt" }))).toBeInstanceOf(
        MultimodalDiagnosisV2.PathError,
      )
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(AppNodeBuilder.build(MultimodalDiagnosisV2.node, [[Location.node, active]])),
        Effect.scoped,
      ),
    )
  })

  test("fuses frontend and JavaScript validation into the same local diagnosis service", async () => {
    await using workspace = await tmpdir()
    await fs.writeFile(
      path.join(workspace.path, "index.html"),
      '<html><body><div id="app"></div><script defer>const app = createApp({}); app.mount("#app")</script></body></html>',
      "utf8",
    )
    await fs.writeFile(path.join(workspace.path, "broken.js"), "function boot( { return 1;", "utf8")
    const active = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(workspace.path) })),
    )
    const program = Effect.gen(function* () {
      const diagnosis = yield* MultimodalDiagnosisV2.Service
      const page = yield* diagnosis.diagnose({ filename: "index.html", mode: "frontend" })
      expect(page).toMatchObject({
        mode: "frontend",
        success: true,
        frontend: { mode: "frontend", framework: "vue3", success: true },
      })
      const javascript = yield* diagnosis.diagnose({ filename: "broken.js", mode: "javascript" })
      expect(javascript).toMatchObject({
        mode: "javascript",
        success: false,
        frontend: {
          mode: "javascript",
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "unbalanced_parentheses" }),
            expect.objectContaining({ code: "unbalanced_braces" }),
          ]),
        },
      })
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(AppNodeBuilder.build(MultimodalDiagnosisV2.node, [[Location.node, active]])),
        Effect.scoped,
      ),
    )
  })

  test("registers a read-only structured tool and honors explicit text override", async () => {
    await using workspace = await tmpdir()
    assertions.length = 0
    await fs.writeFile(path.join(workspace.path, "error.png"), "not an image")
    await fs.writeFile(path.join(workspace.path, "profiles.ts"), "export const load_profile = (id: string) => id\n")
    const active = Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(workspace.path) })),
    )
    const program = Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(registry)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "multimodal_diagnose" })]),
      )
      const settled = yield* settleTool(registry, {
        sessionID: SessionV2.ID.make("ses_multimodal_tool"),
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-multimodal",
          name: "multimodal_diagnose",
          input: {
            filename: "error.png",
            extractedText: "AttributeError: object has no attribute 'load_profile'",
            limit: 4,
          },
        },
      })
      expect(settled.result.type).toBe("text")
      expect(settled.output?.structured).toMatchObject({
        localOnly: true,
        modelCalls: 0,
        source: { type: "provided_text" },
        matches: [expect.objectContaining({ file: "profiles.ts" })],
      })
      expect(assertions).toMatchObject([
        {
          action: "multimodal_diagnose",
          resources: ["error.png"],
          sessionID: "ses_multimodal_tool",
          agent: "build",
          forceAsk: true,
          metadata: {
            riskTier: "L3",
            authority: "human",
            filesystemScope: [],
            networkScope: [],
            secretScope: [],
            externalServices: [],
          },
        },
      ])
    })
    const layer = AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node,
        ToolRegistry.toolsNode,
        MultimodalDiagnosisV2.node,
        MultimodalDiagnoseTool.node,
      ]),
      [
        [Location.node, active],
        [PermissionV2.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
  })
})
