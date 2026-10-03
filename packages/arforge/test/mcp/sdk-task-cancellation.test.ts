import { expect, spyOn, test } from "bun:test"
import { createRequire } from "node:module"
import { getEventListeners } from "node:events"
import * as ESMClient from "@modelcontextprotocol/sdk/client/index.js"
import * as ESMServer from "@modelcontextprotocol/sdk/server/index.js"
import * as ESMTransport from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CallToolRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const require = createRequire(import.meta.url)

for (const format of ["esm", "cjs"] as const) {
  test(`SDK ${format} normal polling removes abort listeners and rejects invalid waits without timers`, async () => {
    const { Server } =
      format === "esm" ? ESMServer : (require("@modelcontextprotocol/sdk/server/index.js") as typeof ESMServer)
    const make = (interval: number) =>
      new Server(
        { name: "poll-cleanup", version: "1" },
        {
          defaultTaskPollInterval: interval,
        },
      ) as unknown as { _waitForTaskUpdate(taskID: string, signal: AbortSignal): Promise<void> }
    const abort = new AbortController()
    const server = make(2)
    for (let index = 0; index < 20; index++) {
      await server._waitForTaskUpdate("fixture-task", abort.signal)
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0)
    }
    const timer = spyOn(globalThis, "setTimeout")
    try {
      for (const interval of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        await expect(make(interval)._waitForTaskUpdate("fixture-task", abort.signal)).rejects.toThrow(
          "Invalid task polling interval",
        )
      }
      abort.abort()
      await expect(server._waitForTaskUpdate("fixture-task", abort.signal)).rejects.toThrow("Request cancelled")
      expect(timer).not.toHaveBeenCalled()
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0)
    } finally {
      timer.mockRestore()
    }
  })

  test(`SDK ${format} cancellation clears the actual polling timer and finishes the iterator`, async () => {
    const { Client } =
      format === "esm" ? ESMClient : (require("@modelcontextprotocol/sdk/client/index.js") as typeof ESMClient)
    const { Server } =
      format === "esm" ? ESMServer : (require("@modelcontextprotocol/sdk/server/index.js") as typeof ESMServer)
    const { InMemoryTransport } =
      format === "esm" ? ESMTransport : (require("@modelcontextprotocol/sdk/inMemory.js") as typeof ESMTransport)
    const server = new Server(
      { name: "poll-cancel", version: "1" },
      {
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
      },
    )
    let calls = 0
    let polls = 0
    let results = 0
    const task = {
      taskId: "cancel-poll-task",
      status: "working" as const,
      ttl: null,
      pollInterval: 1500,
      createdAt: "2026-09-13T00:00:00Z",
      lastUpdatedAt: "2026-09-13T00:00:00Z",
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "slow", inputSchema: { type: "object" }, execution: { taskSupport: "required" } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++
      return { task }
    })
    server.setRequestHandler(GetTaskRequestSchema, async () => {
      polls++
      return task
    })
    server.setRequestHandler(GetTaskPayloadRequestSchema, async () => {
      results++
      return { content: [] }
    })
    const client = new Client({ name: "poll-cancel-client", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    await client.listTools()
    const abort = new AbortController()
    const stream = client.experimental.tasks.callToolStream({ name: "slow" }, undefined, {
      timeout: 500,
      signal: abort.signal,
    })
    const setTimer = globalThis.setTimeout
    const clearTimer = globalThis.clearTimeout
    const active = new Set<unknown>()
    let enteredSleep!: () => void
    const sleeping = new Promise<void>((resolve) => {
      enteredSleep = resolve
    })
    // Observe native timer ownership without replacing the clock or durations.
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign((...args: Parameters<typeof setTimer>) => {
        const handle = Reflect.apply(setTimer, globalThis, args) as ReturnType<typeof setTimer>
        if (args[1] === 1500) {
          active.add(handle)
          enteredSleep()
        }
        return handle
      }, setTimer),
    )
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      active.delete(timer)
      Reflect.apply(clearTimer, globalThis, [timer])
    })
    let pending: ReturnType<typeof stream.next> | undefined
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      expect((await stream.next()).value?.type).toBe("taskCreated")
      expect((await stream.next()).value?.type).toBe("taskStatus")
      pending = stream.next()
      await Promise.race([
        sleeping,
        new Promise<never>((_resolve, reject) => {
          guard = setTimer(() => reject(new Error("SDK never entered its polling sleep")), 1000)
        }),
      ])
      expect(active.size).toBe(1)
      abort.abort(new Error("fixture cancellation"))
      expect(active.size).toBe(0)
      const message = await pending
      expect(message.value?.type).toBe("error")
      expect((await stream.return(undefined)).done).toBe(true)
      expect({ calls, polls, results }).toEqual({ calls: 1, polls: 1, results: 0 })
      // A cancelled task request must not close the reusable client.
      expect((await client.listTools()).tools[0]?.name).toBe("slow")
    } finally {
      abort.abort()
      clearTimer(guard)
      // On RED, allow the original 1500 ms sleep to unwind before restoring
      // instrumentation. Do not leave a live SDK timer behind in the runner.
      await pending
      await stream.return(undefined)
      setSpy.mockRestore()
      clearSpy.mockRestore()
      await Promise.all([client.close(), server.close()])
    }
  })
}
