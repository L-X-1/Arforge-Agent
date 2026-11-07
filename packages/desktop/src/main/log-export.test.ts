import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ZipReader, Uint8ArrayReader, TextWriter, Uint8ArrayWriter } from "@zip.js/zip.js"
import { redactDiagnosticBytes, writeDiagnosticZip } from "./log-export"

const secrets = {
  bearer: "owned-bearer-fixture-123456789",
  password: "owned-password-fixture-123456789",
  apiKey: "owned-api-key-fixture-123456789",
}

test("actual ZIP writer redacts structured synthetic credentials while preserving public context and original logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "arforge-export-redaction-"))
  try {
    const log = join(root, "source.log"),
      zip = join(root, "actual.zip")
    const original = JSON.stringify({
      message: "owned public context",
      authorization: "Bearer " + secrets.bearer,
      password: secrets.password,
      nested: { apiKey: secrets.apiKey },
    })
    await writeFile(log, original)
    const binary = Buffer.from([0, 255, 128, 7])
    await writeDiagnosticZip(zip, [
      { name: "desktop/source.log", path: log },
      { name: "crashpad/owned.dmp", data: binary },
    ])
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(zip))))
    try {
      const entries = await reader.getEntries()
      const text = await entries.find((entry) => entry.filename === "desktop/source.log")!.getData!(new TextWriter())
      expect(text).toContain("owned public context")
      for (const value of Object.values(secrets)) expect(text).not.toContain(value)
      expect(JSON.parse(text).nested.apiKey).toBe("[REDACTED_SECRET]")
      const dump = await entries.find((entry) => entry.filename === "crashpad/owned.dmp")!.getData!(
        new Uint8ArrayWriter(),
      )
      expect(Buffer.from(dump)).toEqual(binary)
    } finally {
      await reader.close()
    }
    expect(await readFile(log, "utf8")).toBe(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("JSONL, quoted text headers and database URLs remove credentials without losing diagnostics", () => {
  const original = [
    JSON.stringify({ message: "public-one", password: secrets.password }),
    `2026 INFO authorization: Bearer ${secrets.bearer}`,
    `2026 INFO apiKey='${secrets.apiKey}' public-two`,
    "database=postgresql://owned-user:owned-db-password@localhost:5432/owned-db",
    "notpassword=public-three",
  ].join("\n")
  const result = redactDiagnosticBytes(Buffer.from(original)).toString("utf8")
  for (const value of [...Object.values(secrets), "owned-db-password"]) expect(result).not.toContain(value)
  expect(result).toContain("public-one")
  expect(result).toContain("public-two")
  expect(result).toContain("localhost:5432/owned-db")
  expect(result).toContain("notpassword=public-three")
})

test("real missing-output error propagates and retry writes a valid archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "arforge-export-retry-"))
  try {
    const directory = join(root, "downloads"),
      output = join(directory, "actual.zip")
    await expect(
      writeDiagnosticZip(output, [{ name: "public.log", data: Buffer.from("public") }]),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await mkdir(directory)
    await writeDiagnosticZip(output, [{ name: "public.log", data: Buffer.from("public") }])
    expect((await readFile(output)).subarray(0, 2).toString()).toBe("PK")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("actual multi-record JSONL ZIP recursively redacts serialized credentials and retains UTF-8 record boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "arforge-export-jsonl-"))
  try {
    const records = [
      JSON.stringify({ message: JSON.stringify({ password: secrets.password, public: "保留公开上下文 🧪" }) }),
      JSON.stringify({
        message: JSON.stringify(
          JSON.stringify({
            apiKey: secrets.apiKey,
            authorization: "Bearer " + secrets.bearer,
            public: "second record",
          }),
        ),
      }),
      "",
      "2026 INFO non-JSON public-tail",
      "",
    ].join("\r\n")
    const original = Buffer.from(records),
      output = join(root, "actual.zip")
    await writeDiagnosticZip(output, [{ name: "desktop/actual.jsonl", data: original }])
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(output))))
    try {
      const entry = (await reader.getEntries())[0]
      const text = await entry.getData!(new TextWriter())
      for (const value of Object.values(secrets)) expect(text).not.toContain(value)
      const lines = text.split("\r\n")
      expect(lines).toHaveLength(5)
      expect(JSON.parse(JSON.parse(lines[0]).message)).toEqual({
        password: "[REDACTED_SECRET]",
        public: "保留公开上下文 🧪",
      })
      expect(JSON.parse(JSON.parse(JSON.parse(lines[1]).message)).apiKey).toBe("[REDACTED_SECRET]")
      expect(lines.slice(2)).toEqual(["", "2026 INFO non-JSON public-tail", ""])
      expect(text.replaceAll("\r\n", "")).not.toContain("\n")
    } finally {
      await reader.close()
    }
    expect(original.toString("utf8")).toBe(records)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
