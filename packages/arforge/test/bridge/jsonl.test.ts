import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "bun:test"
import { JsonlBridgeServer, BRIDGE_MAX_REQUEST_BYTES } from "../../src/bridge/jsonl"

type EventValue = { id: string; type: string; properties: Record<string, unknown> }

function fakeClient(options: { readonly emitPrompt?: boolean } = {}) {
  const emitPrompt = options.emitPrompt ?? true
  let notify: (() => void) | undefined
  let stopped = false
  const queue: EventValue[] = []
  const push = (event: EventValue) => {
    queue.push(event)
    notify?.()
    notify = undefined
  }
  const stream = (async function* () {
    yield { directory: "C:/workspace", payload: { id: "evt_connected", type: "server.connected", properties: {} } }
    while (!stopped) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
      while (queue.length > 0) yield { directory: "C:/workspace", payload: queue.shift()! }
    }
  })()
  const client = {
    global: {
      event: async (options?: { signal?: AbortSignal }) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            stopped = true
            notify?.()
            notify = undefined
          },
          { once: true },
        )
        return { stream }
      },
    },
    vcs: {
      diff: async () => ({
        data: [
          { file: "a.ts", patch: "a".repeat(200), additions: 2, deletions: 0, status: "modified" },
          { file: "b.ts", patch: "b".repeat(200), additions: 2, deletions: 0, status: "modified" },
        ],
      }),
    },
    session: {
      update: async () => ({ data: {} }),
    },
    v2: {
      health: { get: async () => ({ data: { healthy: true } }) },
      session: {
        get: async () => ({
          data: { data: { id: "ses_test", title: "Test", location: { directory: "C:/workspace" } } },
        }),
        create: async () => ({
          data: { data: { id: "ses_test", title: "Test", location: { directory: "C:/workspace" } } },
        }),
        prompt: async () => {
          if (!emitPrompt) return { data: { data: { id: "input_1" } } }
          queueMicrotask(() => {
            push({
              id: "evt_step",
              type: "session.next.step.started",
              properties: { sessionID: "ses_test", assistantMessageID: "msg_1" },
            })
            push({
              id: "evt_delta",
              type: "session.next.text.delta",
              properties: { sessionID: "ses_test", textID: "text_1", delta: "hello" },
            })
            push({
              id: "evt_end",
              type: "session.next.step.ended",
              properties: { sessionID: "ses_test", finish: "stop" },
            })
          })
          return { data: { data: { id: "input_1" } } }
        },
        switchModel: async () => ({ data: {} }),
        interrupt: async () => ({ data: undefined }),
      },
    },
  } as any
  return { client, push }
}

function outputLines(output: PassThrough) {
  return (
    output
      .read()
      ?.toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as Record<string, unknown>) ?? []
  )
}

describe("TypeScript JSONL bridge", () => {
  let server: JsonlBridgeServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it("keeps the protocol strict and rejects oversized requests", async () => {
    const output = new PassThrough()
    const { client } = fakeClient()
    server = new JsonlBridgeServer({ client, workspace: "C:/workspace", output })

    const health = await server.dispatchLine(
      JSON.stringify({ protocol: "arforge.bridge", version: "1.2", id: 1, method: "health", params: {} }),
    )
    expect(health.envelope).toMatchObject({ ok: true, data: { runtime: "typescript" } })

    const description = await server.dispatchLine(
      JSON.stringify({ protocol: "arforge.bridge", version: "1.2", id: 9, method: "protocol.describe", params: {} }),
    )
    expect(description.envelope).toMatchObject({
      ok: true,
      data: { runtime: "typescript", transport: "jsonl-stdio", methods: expect.arrayContaining(["chat.start"]) },
    })

    const workspace = await server.dispatchLine(
      JSON.stringify({ protocol: "arforge.bridge", version: "1.2", id: 10, method: "workspace.get", params: {} }),
    )
    expect(workspace.envelope).toMatchObject({ ok: true, data: { root: "C:/workspace" } })

    const unknown = await server.dispatchLine(
      JSON.stringify({ protocol: "arforge.bridge", version: "1.2", id: 2, method: "health", params: { extra: true } }),
    )
    expect(unknown.envelope).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } })

    const protocol = await server.dispatchLine(
      JSON.stringify({ protocol: "python.bridge", version: "1.2", id: 3, method: "health", params: {} }),
    )
    expect(protocol.envelope).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PROTOCOL" } })

    const unknownVersion = await server.dispatchLine(
      JSON.stringify({ protocol: "arforge.bridge", version: "9.9", id: 4, method: "health", params: {} }),
    )
    expect(unknownVersion.envelope).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_VERSION" } })

    const oversized = await server.dispatchLine("x".repeat(BRIDGE_MAX_REQUEST_BYTES + 1))
    expect(oversized.envelope).toMatchObject({ ok: false, error: { code: "REQUEST_TOO_LARGE" } })
  })

  it("bounds VCS payload patches to max_chars", async () => {
    const { client } = fakeClient()
    server = new JsonlBridgeServer({ client, workspace: "C:/workspace" })
    const result = await server.dispatchLine(
      JSON.stringify({
        protocol: "arforge.bridge",
        version: "1.2",
        id: 1,
        method: "git.diff",
        params: { max_chars: 100 },
      }),
    )
    expect(result.envelope).toMatchObject({ ok: true, data: { truncated: true } })
    const data = (result.envelope as { data: { patch: string; files: Array<{ patch?: string }> } }).data
    expect(data.patch.length).toBeLessThanOrEqual(100)
    expect(data.files.reduce((total, file) => total + (file.patch?.length ?? 0), 0)).toBeLessThanOrEqual(100)
  })

  it("writes chat acknowledgement before fast terminal events", async () => {
    const output = new PassThrough()
    const { client } = fakeClient()
    server = new JsonlBridgeServer({ client, workspace: "C:/workspace", output })
    const result = await server.dispatchLine(
      JSON.stringify({
        protocol: "arforge.bridge",
        version: "1.2",
        id: 1,
        method: "chat.start",
        params: {
          session_id: "ses_test",
          input: "say hello",
          timeout_ms: 0,
          reasoning_effort: "medium",
          permission_mode: "autoApprove",
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await server.write(result.envelope)
    await server.acknowledge(result.acknowledge!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const lines = outputLines(output)
    expect(lines[0]).toMatchObject({ id: 1, ok: true, data: { operation_id: expect.any(String) } })
    expect(lines.slice(1).map((line: Record<string, unknown>) => line.type)).toEqual([
      "operation.started",
      "answer.delta",
      "operation.completed",
    ])
    expect(lines.at(-1)).toMatchObject({ type: "operation.completed", data: { answer: "hello" } })
  })

  it("writes the cancellation response before its terminal event", async () => {
    const output = new PassThrough()
    const { client } = fakeClient({ emitPrompt: false })
    server = new JsonlBridgeServer({ client, workspace: "C:/workspace", output })
    const started = await server.dispatchLine(
      JSON.stringify({
        protocol: "arforge.bridge",
        version: "1.2",
        id: 1,
        method: "chat.start",
        params: { session_id: "ses_test", input: "wait", timeout_ms: 0 },
      }),
    )
    await server.write(started.envelope)
    await server.acknowledge(started.acknowledge!)
    const operationID = (started.envelope as { data: { operation_id: string } }).data.operation_id
    const cancelled = await server.dispatchLine(
      JSON.stringify({
        protocol: "arforge.bridge",
        version: "1.2",
        id: 2,
        method: "chat.cancel",
        params: { operation_id: operationID },
      }),
    )
    await server.write(cancelled.envelope)
    await server.acknowledge(cancelled.acknowledge!)
    const lines = outputLines(output)
    expect(lines.map((line: Record<string, unknown>) => line.id ?? line.type)).toEqual([
      1,
      "operation.started",
      2,
      "operation.cancelled",
    ])
  })

  it("emits a timeout terminal event when the provider does not finish", async () => {
    const output = new PassThrough()
    const { client } = fakeClient({ emitPrompt: false })
    server = new JsonlBridgeServer({ client, workspace: "C:/workspace", output })
    const started = await server.dispatchLine(
      JSON.stringify({
        protocol: "arforge.bridge",
        version: "1.2",
        id: 1,
        method: "chat.start",
        params: { session_id: "ses_test", input: "wait", timeout_ms: 1 },
      }),
    )
    await server.write(started.envelope)
    await server.acknowledge(started.acknowledge!)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const lines = outputLines(output)
    expect(lines.at(-1)).toMatchObject({ type: "operation.timed_out", data: { message: "operation timed out" } })
  })
})
