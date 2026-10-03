import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { createHash } from "node:crypto"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-arforge-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  for (const sample of [
    { name: "the final LF in HTML source", source: '<!doctype html>\n<h1 id="title">Before</h1>\n' },
    { name: "leading and trailing whitespace", source: ' \t\n\n<h1 id="title">Before</h1>\n\n \t' },
    { name: "CRLF line endings", source: '\r\n\t<h1 id="title">Before</h1>\r\n\r\n' },
    { name: "whitespace-only text", source: " \t\r\n\n" },
    { name: "Unicode text and its whitespace", source: "\n<h1>\u4e2d\u6587 \u{1F680}</h1>\n" },
    { name: "all text after the UTF-8 BOM", source: '\uFEFF \r\n<h1 id="title">Before</h1>\r\n' },
  ]) {
    test("preserves " + sample.name, async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "preview.html"), sample.source)

      const response = await request(FilePaths.content, tmp.path, { path: "preview.html" })
      expect(response.status).toBe(200)
      const body = await response.json()
      // The preview and guarded edit contracts both hash BOM-free UTF-8 text,
      // but no other leading/trailing characters or line endings may change.
      const expected = sample.source.startsWith("\uFEFF") ? sample.source.slice(1) : sample.source
      expect(body).toMatchObject({ type: "text", content: expected })
      expect(createHash("sha256").update(body.content).digest("hex")).toBe(
        createHash("sha256").update(expected).digest("hex"),
      )
    })
  }

  test("preserves the binary encoding fallback", async () => {
    await using tmp = await tmpdir()
    const bytes = Uint8Array.from([0, 255, 13, 10, 32])
    await Bun.write(path.join(tmp.path, "binary.bin"), bytes)

    const response = await request(FilePaths.content, tmp.path, { path: "binary.bin" })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ type: "binary", encoding: "base64" })
    expect(Buffer.from(body.content, "base64")).toEqual(Buffer.from(bytes))
  })

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
