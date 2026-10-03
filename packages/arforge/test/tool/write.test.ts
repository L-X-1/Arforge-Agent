import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import * as CoreFileMutation from "../../src/tool/file-mutation"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@arforge-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { failingEventPublish, failingLsp } from "./post-process-failure"
import { extractOfficeText } from "@arforge-ai/core/office-document"
import { encodeXlsxJson } from "@arforge-ai/core/office-document-writer"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import type * as ActionGateway from "@arforge-ai/core/action-gateway"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { LocationServiceMap, buildLocationServiceMap } from "@arforge-ai/core/location-services"

const ctx = {
  sessionID: SessionID.make("ses_test-write-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const rollbackArtifactRoot = path.join(
  os.tmpdir(),
  `arforge-write-test-artifacts-${Math.random().toString(36).slice(2)}`,
)

afterEach(async () => {
  await disposeAllInstances()
  await fs.rm(rollbackArtifactRoot, { recursive: true, force: true })
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const failingFormat = Layer.succeed(
  Format.Service,
  Format.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    file: () => Effect.die(new Error("formatter post-process failed")),
  }),
)

const failingPostProcessIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
    [[Format.node, failingFormat]],
  ),
)

const failingLspIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
    [[LSP.node, failingLsp]],
  ),
)

const failingEventIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
    [[EventV2Bridge.node, failingEventPublish]],
  ),
)

const rollbackArtifactIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      LocationServiceMap.node,
      RollbackArtifact.node,
    ]),
    [
      [RollbackArtifact.node, RollbackArtifact.layerWith(rollbackArtifactRoot)],
      [
        LocationServiceMap.node,
        buildLocationServiceMap([[RollbackArtifact.node, RollbackArtifact.layerWith(rollbackArtifactRoot)]]),
      ],
    ],
  ),
)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.write", () => {
  failingPostProcessIt.instance("rolls back when post-processing fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "post-process-failure.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "before\n", "utf-8"))

      const exit = yield* run({ filePath: filepath, content: "after\n" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Write post-processing failed")
      expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("before\n")
    }),
  )

  failingLspIt.instance("rolls back when LSP refresh fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "lsp-post-process-failure.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "before\n", "utf-8"))

      const exit = yield* run({ filePath: filepath, content: "after\n" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Write post-processing failed")
      expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("before\n")
    }),
  )

  failingEventIt.instance("rolls back when watcher publication fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "event-post-process-failure.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "before\n", "utf-8"))

      const exit = yield* run({ filePath: filepath, content: "after\n" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Write post-processing failed")
      expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("before\n")
    }),
  )

  describe("new file creation", () => {
    it.instance("writes content to new file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, content: "Hello, World!" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(false)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("Hello, World!")
      }),
    )

    it.instance("creates parent directories if needed", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "deep", "file.txt")
        yield* run({ filePath: filepath, content: "nested content" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("nested content")
      }),
    )

    it.instance("handles relative paths by resolving to instance directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* run({ filePath: "relative.txt", content: "relative content" })

        const content = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "relative.txt"), "utf-8"))
        expect(content).toBe("relative content")
      }),
    )
  })

  describe("canonical Office outputs", () => {
    it.instance("writes XLSX, DOCX, PPTX, and PDF through the same write tool", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const cases = [
          {
            filename: "canonical-report.xlsx",
            content: JSON.stringify([
              { 月份: "六月", 收入: 96.5 },
              { 月份: "七月", 收入: 128 },
            ]),
            needle: "收入",
          },
          {
            filename: "canonical-report.docx",
            content: "# 会议纪要\n\n负责人：小林\n\n- 决策：按期交付",
            needle: "负责人：小林",
          },
          {
            filename: "canonical-report.pptx",
            content: JSON.stringify([
              { title: "季度复盘", body: "收入增长 18%" },
              { title: "下一步", body: "完善风险台账" },
            ]),
            needle: "风险台账",
          },
        ] as const

        for (const item of cases) {
          const filepath = path.join(test.directory, item.filename)
          const result = yield* run({ filePath: filepath, content: item.content })
          expect(result.output).toContain("Wrote file successfully")
          const extraction = extractOfficeText(
            yield* Effect.promise(() => fs.readFile(filepath)),
            path.extname(item.filename),
          )
          expect(extraction.ok).toBe(true)
          if (extraction.ok) expect(extraction.text).toContain(item.needle)
        }

        const pdfPath = path.join(test.directory, "canonical-report.pdf")
        const pdfResult = yield* run({
          filePath: pdfPath,
          content: "# 经营简报\n\n收入：128 万元\n\n结论：保持增长",
        })
        expect(pdfResult.output).toContain("Wrote file successfully")
        const pdf = yield* Effect.promise(() => fs.readFile(pdfPath))
        expect(pdf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4")
        expect(pdf.toString("ascii")).toContain("/Type /Pages /Count 1")
        expect(pdf.toString("ascii")).toContain("xref\n")
      }),
    )

    it.instance("rejects malformed Office content before creating or replacing a target", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "invalid.xlsx")
        const exit = yield* run({ filePath: filepath, content: "not-json" }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("valid JSON")
        expect(
          yield* Effect.promise(() =>
            fs.stat(filepath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    )

    rollbackArtifactIt.instance("stages an inverse artifact and can restore a durable Office write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "durable-report.xlsx")
        const before = encodeXlsxJson(JSON.stringify([{ 状态: "旧版本" }]))
        yield* Effect.promise(() => fs.writeFile(filepath, before))

        type MutationRecord = Parameters<NonNullable<ActionGateway.Interface["recordMutationIntent"]>>[0]
        const records: MutationRecord[] = []
        const recordMutationIntent: NonNullable<ActionGateway.Interface["recordMutationIntent"]> = (input) =>
          Effect.sync(() => {
            records.push(input)
            return undefined as never
          })
        const durableContext = {
          ...ctx,
          gateway: { recordMutationIntent } as Tool.Context["gateway"],
          parentAction: { actionID: AgentRuntime.ActionID.create() },
        }

        const result = yield* run(
          {
            filePath: filepath,
            content: JSON.stringify([{ 状态: "新版本", 收入: 128 }]),
          },
          durableContext,
        )
        expect(result.output).toContain("Wrote file successfully")

        const prepared = records.find((record) => record.phase === "prepared")
        const artifact = prepared?.entries[0]?.rollbackArtifact
        expect(artifact).toBeDefined()
        if (!artifact) return

        const artifacts = yield* RollbackArtifact.Service
        const stored = yield* Effect.promise(() => artifacts.store.read(artifact))
        expect(stored.content).toEqual(before)

        const settled = records.findLast((record) => record.phase === "settled")
        expect(settled).toBeDefined()
        if (!settled) return
        const now = DateTime.makeUnsafe(Date.now())
        const intent = AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: settled.transactionID,
          actionID: settled.actionID,
          intentDigest: "a".repeat(64),
          idempotencyKey: "durable-office-write",
          phase: "rollback_required",
          entries: settled.entries,
          manifestDigest: settled.manifestDigest,
          automaticRetryAllowed: false,
          createdAt: settled.createdAt,
          updatedAt: DateTime.makeUnsafe(
            Math.max(DateTime.toEpochMillis(settled.updatedAt), DateTime.toEpochMillis(now)),
          ),
          ...(settled.postProcessing === undefined ? {} : { postProcessing: settled.postProcessing }),
        })
        const files = yield* CoreFileMutation.service()
        const inspection = yield* CoreFileMutation.inspectMutationIntent({
          files,
          worktree: test.directory,
          intent,
        })
        expect(inspection.decision).toBe("postimage_matches")
        const receipt = yield* files.rollbackIntent({
          worktree: test.directory,
          intent,
          observationDigest: inspection.observationDigest,
        })
        expect(receipt.inspection.decision).toBe("preimage_matches")
        expect(yield* Effect.promise(() => fs.readFile(filepath))).toEqual(Buffer.from(before))
        expect(MutationIntent.postProcessingRecoveryOf(intent).status).toBe("completed_unsettled")
      }),
    )
  })

  describe("existing file overwrite", () => {
    it.instance("overwrites existing file content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(true)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("new content")
      }),
    )

    it.instance("preserves BOM when overwriting existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

        yield* run({ filePath: filepath, content: "using Up;\n" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance(
      "restores BOM after formatter strips it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.cs")
          const bom = String.fromCharCode(0xfeff)
          yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

          yield* run({ filePath: filepath, content: "using Up;\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.charCodeAt(0)).toBe(0xfeff)
          expect(content.slice(1)).toBe("using Up;\n")
        }),
      {
        config: {
          formatter: {
            stripbom: {
              extensions: [".cs"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("returns diff in metadata for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new" })

        expect(result.metadata).toHaveProperty("filepath", filepath)
        expect(result.metadata).toHaveProperty("exists", true)
      }),
    )
  })

  describe("file permissions", () => {
    it.instance("sets file permissions when writing sensitive data", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sensitive.json")
        yield* run({ filePath: filepath, content: JSON.stringify({ secret: "data" }) })

        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => fs.stat(filepath))
          expect(stats.mode & 0o777).toBe(0o644)
        }
      }),
    )
  })

  describe("content types", () => {
    it.instance("writes JSON content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "data.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* run({ filePath: filepath, content: JSON.stringify(data, null, 2) })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(JSON.parse(content)).toEqual(data)
      }),
    )

    it.instance("writes binary-safe content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "binary.bin")
        const content = "Hello\x00World\x01\x02\x03"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )

    it.instance("writes empty content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty.txt")
        yield* run({ filePath: filepath, content: "" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("")

        const stats = yield* Effect.promise(() => fs.stat(filepath))
        expect(stats.size).toBe(0)
      }),
    )

    it.instance("writes multi-line content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multiline.txt")
        const lines = ["Line 1", "Line 2", "Line 3", ""].join("\n")
        yield* run({ filePath: filepath, content: lines })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe(lines)
      }),
    )

    it.instance("handles different line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        const content = "Line 1\r\nLine 2\r\nLine 3"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )
  })

  describe("error handling", () => {
    it.instance("throws error when OS denies write access", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const readonlyPath = path.join(test.directory, "readonly.txt")
        yield* Effect.promise(() => fs.writeFile(readonlyPath, "test", "utf-8"))
        yield* Effect.promise(() => fs.chmod(readonlyPath, 0o444))
        const exit = yield* run({ filePath: readonlyPath, content: "new content" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )

    it.instance("rejects an external change made after permission approval", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "raced.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "before\n", "utf-8"))
        const metadata: Record<string, unknown>[] = []
        const racedCtx = {
          ...ctx,
          ask: () => Effect.promise(() => fs.writeFile(filepath, "external\n", "utf-8")),
          metadata: (input: { metadata?: Record<string, unknown> }) =>
            Effect.sync(() => {
              if (input.metadata) metadata.push(input.metadata)
            }),
        }

        const exit = yield* run({ filePath: filepath, content: "after\n" }, racedCtx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(String(Cause.squash(exit.cause))).toContain("File changed after permission approval")
        expect(metadata.at(-1)).toMatchObject({
          kind: "file_conflict",
          code: "observed_version_mismatch",
          path: filepath,
        })
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("external\n")
      }),
    )
  })

  describe("title generation", () => {
    it.instance("returns relative path as title", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "src", "components", "Button.tsx")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filepath), { recursive: true }))

        const result = yield* run({ filePath: filepath, content: "export const Button = () => {}" })
        expect(result.title).toEndWith(path.join("src", "components", "Button.tsx"))
      }),
    )
  })
})
