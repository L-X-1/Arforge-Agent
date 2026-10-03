import { describe, expect, test } from "bun:test"
import { request, type IncomingMessage } from "node:http"
import { createTimelineStreamTransport } from "../timeline/session-timeline-stream-transport"

function requestStream(url: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, { ...options, agent: false }, resolve)
    req.on("error", reject)
    req.setTimeout(3000, () => req.destroy(new Error("SSE test request timed out")))
    req.end()
  })
}

function readFrames(response: IncomingMessage) {
  const reader = response[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buffer = ""
  let cancelled = false
  return {
    async next(): Promise<Record<string, unknown>> {
      for (;;) {
        const end = buffer.indexOf("\n\n")
        if (end !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = frame.split("\n").find((line) => line.startsWith("data: "))
          if (data) return JSON.parse(data.slice(6))
          continue
        }
        const chunk = await reader.next()
        if (chunk.done) throw new Error("SSE connection ended before the next event")
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    },
    async cancel() {
      if (cancelled) return
      cancelled = true
      response.destroy()
      try {
        await reader.return?.()
      } catch {
        // Cancelling an open HTTP response intentionally aborts its iterator.
      }
    },
  }
}

const event = (index: number) => ({ directory: "C:/test", payload: { type: "message.part.delta", properties: { sessionID: "ses_stream_transport", messageID: "msg_stream_transport", partID: "prt_stream_transport", field: "text", delta: `stream-${index}` } } })

describe("persistent timeline SSE transport", () => {
  test("delivers later batches through the same open response in FIFO order", async () => {
    const transport = await createTimelineStreamTransport({ eventBatch: 1, intervalMs: 4 })
    let frames: ReturnType<typeof readFrames> | undefined
    try {
      const response = await requestStream(`${transport.url}/global/event`)
      expect(response.headers["content-type"]).toBe("text/event-stream")
      frames = readFrames(response)
      expect(await frames.next()).toEqual({ payload: { id: "evt_mock_connected", type: "server.connected", properties: {} } })
      transport.enqueue(event(1))
      expect(await frames.next()).toEqual(event(1))
      transport.enqueue([event(2), event(3)])
      expect(await frames.next()).toEqual(event(2))
      expect(await frames.next()).toEqual(event(3))
      expect(transport.pendingCount()).toBe(0)
      expect(transport.stats()).toMatchObject({ connections: 1, activeConnections: 1, sentEvents: 3, batches: 3 })
    } finally {
      await frames?.cancel()
      await transport.close()
    }
  })

  test("keeps queued events until a reader connects and closes idempotently", async () => {
    const transport = await createTimelineStreamTransport({ eventBatch: 1, intervalMs: 4 })
    let frames: ReturnType<typeof readFrames> | undefined
    try {
      transport.enqueue(event(4))
      expect(transport.pendingCount()).toBe(1)
      frames = readFrames(await requestStream(`${transport.url}/event`))
      expect(await frames.next()).toEqual(event(4))
      await frames.cancel()
      await transport.close()
      await transport.close()
      expect(transport.stats()).toMatchObject({ activeConnections: 0, closed: true })
      expect(() => transport.enqueue(event(5))).toThrow("Timeline stream is closed")
    } finally {
      await frames?.cancel()
      await transport.close()
    }
  })

  test("preserves modern connection framing, CORS and paused batch release", async () => {
    const transport = await createTimelineStreamTransport({ eventBatch: 0, intervalMs: 4 })
    let frames: ReturnType<typeof readFrames> | undefined
    try {
      transport.enqueue(event(6))
      const preflight = await requestStream(`${transport.url}/api/event`, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:4444" } })
      preflight.resume()
      expect(preflight.statusCode).toBe(204)
      expect(preflight.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4444")
      expect(transport.stats().connections).toBe(0)
      frames = readFrames(await requestStream(`${transport.url}/api/event`))
      expect(await frames.next()).toEqual({ id: "evt_mock_connected", type: "server.connected", data: {} })
      expect(transport.pendingCount()).toBe(1)
      transport.releaseAll()
      const delta = await frames.next()
      expect(delta.type).toBe("message.part.delta")
      expect(delta).toHaveProperty("data")
      expect(transport.pendingCount()).toBe(0)
      expect(transport.stats()).toMatchObject({ connections: 1, sentEvents: 1 })
    } finally {
      await frames?.cancel()
      await transport.close()
    }
  })
})
