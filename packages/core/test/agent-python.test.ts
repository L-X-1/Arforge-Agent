import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { AgentPython } from "../src/agent-python"

const root = resolve(import.meta.dir, "../../..")
const python = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("AgentPython Core service", () => {
  test("reads Python capability metadata through a scoped Core layer", async () => {
    await access(python)
    const home = await mkdtemp(join(tmpdir(), "arforge-core-agent-python-"))
    homes.push(home)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bridge = yield* AgentPython.Service
        const health = yield* bridge.call<{ status: string; brand: string }>("health")
        const capabilities = yield* bridge.call<{ count: number; items: unknown[] }>("capabilities.list")
        return { health, capabilities }
      }).pipe(
        Effect.provide(
          AgentPython.layer({
            workspace: root,
            pythonExecutable: python,
            home,
            requestTimeoutMs: 20_000,
          }),
        ),
        Effect.scoped,
      ),
    )

    expect(result.health).toMatchObject({ status: "ok", brand: "Arforge Agent" })
    expect(result.capabilities.count).toBe(result.capabilities.items.length)
    expect(result.capabilities.count).toBeGreaterThan(0)
  }, 30_000)
})
