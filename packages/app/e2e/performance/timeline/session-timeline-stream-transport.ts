import { createServer, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { currentEvent } from "../../utils/mock-server"

// A real, long-lived response is required here: route.fulfill() ends the body
// and turns one-event batches into repeated client reconnects.
export async function createTimelineStreamTransport(options: { eventBatch: number; intervalMs?: number }) {
  let batchSize = options.eventBatch
  const intervalMs = options.intervalMs ?? 16
  if (!Number.isInteger(batchSize) || batchSize < 0 || !Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Invalid timeline stream cadence")
  }
  const events: unknown[] = []
  const clients = new Map<ServerResponse, string>()
  const sockets = new Set<Socket>()
  let connections = 0
  let sentEvents = 0
  let batches = 0
  let heartbeats = 0
  let lastWrite = Date.now()
  let closing: Promise<void> | undefined
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*")
    response.setHeader("access-control-allow-credentials", "true")
    response.setHeader("access-control-allow-methods", "GET,OPTIONS")
    response.setHeader("access-control-allow-headers", request.headers["access-control-request-headers"] ?? "authorization,content-type,x-arforge-directory")
    response.setHeader("vary", "Origin")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== "GET" || !["/global/event", "/event", "/api/event"].includes(path)) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    response.flushHeaders()
    connections++
    clients.set(response, path)
    response.on("close", () => clients.delete(response))
    response.on("error", () => clients.delete(response))
    const connected = path === "/api/event"
      ? { id: "evt_mock_connected", type: "server.connected", data: {} }
      : path === "/global/event"
        ? { payload: { id: "evt_mock_connected", type: "server.connected", properties: {} } }
        : undefined
    response.write(`retry: 16\n\n${connected ? `data: ${JSON.stringify(connected)}\n\n` : ": connected\n\n"}`)
  })
  server.on("connection", (socket) => {
    socket.setNoDelay(true)
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Timeline stream did not bind a TCP port")
  }
  const timer = setInterval(() => {
    for (const response of clients.keys()) {
      if (response.destroyed || response.writableEnded) clients.delete(response)
    }
    if (!clients.size || [...clients.keys()].some((response) => response.writableNeedDrain)) return
    const batch = events.splice(0, batchSize)
    if (batch.length) {
      for (const [response, path] of clients) {
        const payloads = path === "/api/event" ? batch.map(currentEvent) : batch
        response.write(payloads.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
      }
      sentEvents += batch.length
      batches++
      lastWrite = Date.now()
    } else if (Date.now() - lastWrite >= 15_000) {
      for (const response of clients.keys()) response.write(": keepalive\n\n")
      heartbeats++
      lastWrite = Date.now()
    }
  }, intervalMs)
  timer.unref()

  return {
    url: `http://127.0.0.1:${address.port}`,
    enqueue(payload: unknown | unknown[]) {
      if (closing) throw new Error("Timeline stream is closed")
      events.push(...(Array.isArray(payload) ? payload : [payload]))
    },
    pendingCount() {
      return events.length
    },
    releaseAll() {
      batchSize = Math.max(1, events.length)
    },
    stats() {
      return { kind: "persistent-sse", connections, activeConnections: clients.size, sentEvents, batches, heartbeats, intervalMs, closed: !!closing }
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        clearInterval(timer)
        server.close((error) => error ? reject(error) : resolve())
        for (const response of clients.keys()) response.end()
        clients.clear()
        for (const socket of sockets) socket.destroy()
      })
      return closing
    },
  }
}
