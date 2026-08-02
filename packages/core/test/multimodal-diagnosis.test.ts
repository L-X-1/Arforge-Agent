import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Location } from "@arforge-ai/core/location"
import { MultimodalDiagnosisV2 } from "@arforge-ai/core/multimodal-diagnosis"
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
          metadata: { limit: 4, hasExtractedText: true },
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
