import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { runWindowsSandboxCleanup } from "../../src/sandbox/windows-launcher"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")("native cleanup accepts S_OK for its already-absent profile", async () => {
  await using tmp = await tmpdir()
  const directory = await mkdtemp(path.join(tmp.path, ".arforge-sandbox-temp-"))
  const retained = path.join(tmp.path, "retained.txt")
  await writeFile(retained, "unrelated fixture data")
  // The cleanup worker only proceeds after its own parent has exited. Use a
  // real, completed fixture process, not an arbitrary live user's process.
  const parent = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "pipe" })
  expect(await parent.exited).toBe(0)
  const payload = Buffer.from(
    JSON.stringify({
      directory,
      parentPid: parent.pid,
      profileName: `ArforgeSandbox-${parent.pid}-${randomUUID()}`,
    }),
  ).toString("base64url")
  expect(runWindowsSandboxCleanup(payload)).toBe(0)
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(retained, "utf8")).toBe("unrelated fixture data")
})
