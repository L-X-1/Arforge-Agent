import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { tmpdir } from "../fixture/tmpdir"

const start = (databasePath: string, mode: string, runID?: string) => {
  const values = new Map<string, unknown>()
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()
  const worker = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../fixture/lease-transaction-worker.ts", import.meta.url)),
      databasePath,
      mode,
      ...(runID ? [runID] : []),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: unknown) {
        if (
          !message ||
          typeof message !== "object" ||
          !("event" in message) ||
          typeof message.event !== "string" ||
          !("value" in message)
        )
          return
        const listener = waiting.get(message.event)
        if (listener) {
          waiting.delete(message.event)
          listener.resolve(message.value)
        } else values.set(message.event, message.value)
      },
    },
  )
  const stdout = new Response(worker.stdout).text()
  const stderr = new Response(worker.stderr).text()
  const timer = setTimeout(() => worker.kill(), 25_000)
  const completed = worker.exited.then(async (code) => {
    clearTimeout(timer)
    const error = await stderr
    for (const listener of waiting.values())
      listener.reject(new Error(`Worker exited (${code}) before signal: ${error}`))
    waiting.clear()
    return { code, error, output: await stdout }
  })
  return {
    send: (message: string) => worker.send(message),
    wait: (event: string) =>
      values.has(event)
        ? Promise.resolve(values.get(event))
        : new Promise<unknown>((resolve, reject) => {
            if (worker.exitCode !== null) {
              reject(new Error(`Worker already exited before ${event}`))
              return
            }
            waiting.set(event, { resolve, reject })
          }),
    completed,
    async stop() {
      worker.kill()
      await completed
    },
  }
}

for (const finish of ["commit", "rollback"]) {
  test(`lease transaction excludes another process until ${finish}`, async () => {
    await using temporary = await tmpdir()
    const holder = start(join(temporary.path, "lease.sqlite"), "holder")
    let contender: ReturnType<typeof start> | undefined
    try {
      const runID = await holder.wait("ready")
      if (typeof runID !== "string") throw new Error("Missing run ID")
      contender = start(join(temporary.path, "lease.sqlite"), "contender", runID)
      await contender.wait("ready")
      holder.send("hold")
      expect(await holder.wait("locked")).toBe(true)
      contender.send("contend")
      expect(await contender.wait("blocked")).toEqual({ unchanged: true, probe: [] })
      holder.send(finish)
      const rows = finish === "commit" ? [{ value: 1 }] : []
      expect(await holder.wait("result")).toEqual({ committed: finish === "commit", rows })
      expect(await holder.completed).toEqual({ code: 0, error: "", output: "" })
      contender.send("retry")
      expect(await contender.wait("result")).toEqual({ ownerID: "replacement-owner", rows })
      const completed = await contender.completed
      expect(completed).toMatchObject({ code: 0, error: "" })
      expect(completed.output).toContain("Event commit conflict exhausted retries")
    } finally {
      await Promise.all([holder.stop(), contender?.stop()])
    }
  }, 30_000)
}
