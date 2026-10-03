import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes, randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"

type Asset = { readonly bytes: Uint8Array; readonly mime: string }
type ReadAsset = (path: string) => Promise<Asset>
type Lease = { owner: string; grant: PreviewResource.Grant; read: ReadAsset; requests: number; active: number }

export function createPreviewResourceHost(options: { now?: () => number; ttlMs?: number; maxGrants?: number } = {}) {
  const now = options.now ?? Date.now
  const ttl = Math.min(options.ttlMs ?? PreviewResource.TTL_MS, PreviewResource.TTL_MS)
  const leases = new Map<string, Lease>()
  let server: Server | undefined
  let starting: Promise<string> | undefined
  let origin = ""
  let closed = false
  let active = 0
  let sweep: ReturnType<typeof setInterval> | undefined

  const prune = () => {
    for (const [token, lease] of leases) if (lease.grant.expiresAt <= now()) leases.delete(token)
  }
  const respond = (response: ServerResponse, status: number, body: string) => {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Connection": "close" })
    response.end(body)
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(origin).host) return respond(response, 403, "Forbidden")
    if (request.method !== "GET" && request.method !== "HEAD") return respond(response, 405, "Read-only resource service")
    const match = /^\/resources\/([a-f0-9]{64})\/([^?#]+)(?:\?[^#]*)?$/.exec(request.url ?? "")
    if (!match) return respond(response, 404, "Not found")
    const lease = leases.get(match[1])
    if (!lease) return respond(response, 404, "Not found")
    if (lease.grant.expiresAt <= now()) { leases.delete(match[1]); return respond(response, 410, "Expired") }
    let path: string
    try { path = decodeURIComponent(match[2]) } catch { return respond(response, 404, "Not found") }
    if (!PreviewResource.resourcePath(path) || !PreviewResource.mimeType(path)) return respond(response, 404, "Not found")
    if (lease.active >= 4 || active >= 16 || lease.requests >= 256) return respond(response, 429, "Resource limit reached")
    lease.requests++
    lease.active++
    active++
    try {
      const asset = await lease.read(path)
      if (closed || leases.get(match[1]) !== lease || lease.grant.expiresAt <= now()) return respond(response, 410, "Expired")
      if (asset.mime !== PreviewResource.mimeType(path) || asset.bytes.byteLength > PreviewResource.MAX_ASSET_BYTES)
        return respond(response, 404, "Not found")
      response.writeHead(200, {
        "Content-Type": asset.mime === "text/css" ? "text/css; charset=utf-8" : asset.mime,
        "Content-Length": asset.bytes.byteLength,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      })
      response.end(request.method === "HEAD" ? undefined : asset.bytes)
    } catch {
      if (!response.headersSent && !response.destroyed) respond(response, 404, "Not found")
    } finally {
      lease.active--
      active--
    }
  }

  const start = () => {
    if (closed) return Promise.reject(new Error("Preview resource host is closed"))
    if (starting) return starting
    starting = new Promise<string>((resolve, reject) => {
      const listener = createServer((request, response) => {
        void handle(request, response).catch(() => { if (!response.headersSent && !response.destroyed) respond(response, 500, "Resource unavailable") })
      })
      server = listener
      listener.requestTimeout = 10_000
      listener.headersTimeout = 5_000
      listener.keepAliveTimeout = 1_000
      listener.maxHeadersCount = 32
      listener.maxConnections = 32
      listener.on("error", () => reject(new Error("The local preview resource listener could not start")))
      listener.listen({ host: PreviewResource.HOST, port: 0, exclusive: true }, () => {
        const address = listener.address()
        if (!address || typeof address === "string") return reject(new Error("Invalid preview listener address"))
        origin = `http://${PreviewResource.HOST}:${address.port}`
        listener.unref()
        sweep = setInterval(prune, 30_000)
        sweep.unref()
        resolve(origin)
      })
    }).catch((error) => { starting = undefined; throw error })
    return starting
  }

  return {
    async open(owner: string, documentPath: string, read: ReadAsset): Promise<PreviewResource.Grant> {
      const base = await start()
      if (closed) throw new Error("Preview resource host is closed")
      prune()
      if (leases.size >= (options.maxGrants ?? 32)) throw new Error("Too many open preview grants")
      const token = randomBytes(32).toString("hex")
      const grant = { id: randomUUID(), documentPath, baseURL: `${base}/resources/${token}/`, expiresAt: now() + ttl }
      leases.set(token, { owner, grant, read, requests: 0, active: 0 })
      return grant
    },
    revoke(owner: string, id: string) {
      for (const [token, lease] of leases) {
        if (lease.grant.id !== id || lease.owner !== owner) continue
        leases.delete(token)
        return true
      }
      return false
    },
    async close() {
      closed = true
      leases.clear()
      await starting?.catch(() => undefined)
      if (sweep) clearInterval(sweep)
      if (!server?.listening) return
      const listener = server
      await new Promise<void>((resolve) => {
        listener.close(() => resolve())
        listener.closeAllConnections()
      })
    },
  }
}

export class PreviewResourceHost extends Context.Service<PreviewResourceHost, ReturnType<typeof createPreviewResourceHost>>()("@arforge/server/PreviewResourceHost") {}
export const previewResourceHostLayer = Layer.effect(PreviewResourceHost, Effect.acquireRelease(
  Effect.sync(() => createPreviewResourceHost()),
  (host) => Effect.promise(() => host.close()),
))
