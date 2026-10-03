import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { chromeTraceChunkBytes, prepareChromeTrace } from "../chrome-trace"

test("creates the configured trace directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-trace-"))
  try {
    const file = await prepareChromeTrace(path.join(root, "nested", "traces"), "session/tab", false, "test")
    expect(file).toEndWith("-session-tab-458ed9e3-test.json")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("encodes text chunks as UTF-8, including empty and multibyte text", () => {
  for (const data of ["", '{"name":"\u4f1a\u8bdd \u{1f680}"}\r\n']) {
    for (const base64Encoded of [undefined, false]) {
      const bytes = chromeTraceChunkBytes({ data, base64Encoded })
      expect(Buffer.isBuffer(bytes)).toBe(true)
      expect(bytes).toEqual(Buffer.from(data, "utf8"))
    }
  }
})

test("decodes base64 chunks without losing arbitrary bytes", () => {
  const bytes = Buffer.from([0, 1, 127, 128, 254, 255])
  expect(chromeTraceChunkBytes({ data: bytes.toString("base64"), base64Encoded: true })).toEqual(bytes)
  expect(chromeTraceChunkBytes({ data: "", base64Encoded: true })).toEqual(Buffer.alloc(0))
})

test("preserves multibyte characters split across base64 stream chunks", () => {
  const bytes = Buffer.from('{"name":"\u4f1a\u8bdd"}', "utf8")
  const split = bytes.indexOf(Buffer.from("\u4f1a", "utf8")) + 1
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)].map((part) =>
    chromeTraceChunkBytes({ data: part.toString("base64"), base64Encoded: true }))
  expect(Buffer.concat(chunks)).toEqual(bytes)
})
