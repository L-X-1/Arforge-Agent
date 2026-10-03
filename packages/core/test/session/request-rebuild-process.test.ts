import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

for (const change of ["unchanged", "replace", "remove", "new-id"] as const)
  test(`fresh process rebuild binds committed request and credential: ${change}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "arforge-request-rebuild-"))
    const hits: { url: string; body: unknown; authorized: boolean }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        hits.push({
          url: request.url,
          body: await request.json(),
          authorized: request.headers.get("authorization") === "Bearer fixture-original-key",
        })
        const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "cold-reply", object: "chat.completion.chunk", model: "cold-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        return new Response(
          chunk({ role: "assistant", content: "Cold request accepted" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      },
    })
    const workerPath = fileURLToPath(new URL("../fixture/request-rebuild-worker.ts", import.meta.url))
    const run = async (mode: string) => {
      const worker = Bun.spawn([process.execPath, workerPath, directory, `${server.url.href}v1`, mode], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => worker.kill(), 20_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          worker.exited,
          new Response(worker.stdout).text(),
          new Response(worker.stderr).text(),
        ])
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).not.toContain("fixture-original-key")
        expect(stdout).not.toContain("fixture-new-key")
        return JSON.parse(stdout)
      } finally {
        clearTimeout(timer)
        worker.kill()
      }
    }
    try {
      const seed = await run("seed")
      expect(seed.seeded).toBe(true)
      expect(seed.pid).not.toBe(process.pid)
      expect(hits).toHaveLength(0)
      const restored = await run(change)
      expect(restored.pid).not.toBe(seed.pid)
      expect(restored.pid).not.toBe(process.pid)
      expect(restored.eventID).toBe(seed.eventID)
      expect(restored.eventUnchanged).toBe(true)
      expect(restored.envelope).toBe(seed.envelope)
      expect(restored.success).toBe(change === "unchanged")
      expect(hits).toHaveLength(change === "unchanged" ? 1 : 0)
      const envelope = JSON.parse(seed.envelope)
      if (change === "unchanged") {
        expect(restored.resolvedIdentity).toEqual(envelope.execution.credential_identity)
        expect(restored.answer).toBe("Cold request accepted")
        expect(hits[0]).toEqual({
          url: envelope.request.transmission.endpoint.url,
          body: envelope.request.transmission.body,
          authorized: true,
        })
      } else if (change === "remove") {
        expect(restored.error).toContain("Model unavailable")
        expect(restored.resolvedIdentity).toBeUndefined()
      } else {
        expect(restored.error).toContain("credential identity")
        expect(restored.resolvedIdentity).toBeDefined()
        expect(restored.resolvedIdentity.version).not.toBe(envelope.execution.credential_identity.version)
        expect(restored.resolvedIdentity.id === envelope.execution.credential_identity.id).toBe(change === "replace")
      }
    } finally {
      await server.stop(true)
      // Only this test's unique mkdtemp directory is owned by the fixture.
      await rm(directory, { recursive: true, force: true })
    }
  }, 50_000)
