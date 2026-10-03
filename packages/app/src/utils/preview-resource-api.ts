import { PreviewResource } from "@arforge-ai/schema/preview-resource"

export function createPreviewResourceApi(input: { baseUrl: string; fetch: typeof globalThis.fetch; headers?: Readonly<Record<string, string>> }) {
  const server = new URL(input.baseUrl)
  const available = server.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)
  const request = async (operation: "open" | "close", directory: string, payload: object) => {
    if (!available) throw new Error("Local preview resources require a local HTTP server connection.")
    const url = new URL(`/api/fs/preview/${operation}`, input.baseUrl)
    url.searchParams.set("location[directory]", directory)
    const response = await input.fetch(url, {
      method: "POST", headers: { ...input.headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Local preview resources are unavailable (${response.status}). The safe preview is unchanged.`)
    const body: unknown = await response.json()
    return body && typeof body === "object" && "data" in body ? body.data : undefined
  }
  return {
    available,
    async open(value: { directory: string; path: string }): Promise<PreviewResource.Grant> {
      const grant = await request("open", value.directory, { path: value.path })
      if (
        !PreviewResource.isGrant(grant) || grant.documentPath !== value.path || !PreviewResource.safeBaseURL(grant.baseURL) ||
        !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + PreviewResource.TTL_MS + 5_000
      ) throw new Error("The server returned an invalid preview grant.")
      return grant
    },
    async close(value: { directory: string; id: string }) {
      await request("close", value.directory, { id: value.id })
    },
  }
}

export type PreviewResourceApi = ReturnType<typeof createPreviewResourceApi>
