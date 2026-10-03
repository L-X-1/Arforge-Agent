import { TextDocument } from "@arforge-ai/schema/text-document"

export class TextDocumentRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "TextDocumentRequestError"
  }
}

export function createTextDocumentApi(input: {
  baseUrl: string
  fetch: typeof globalThis.fetch
  headers?: Readonly<Record<string, string>>
}) {
  const request = async (
    location: { directory: string; workspace?: string },
    filePath: string,
    save?: TextDocument.SaveInput,
  ): Promise<TextDocument.Info> => {
    const url = new URL("/api/fs/text", input.baseUrl)
    url.searchParams.set("location[directory]", location.directory)
    if (location.workspace) url.searchParams.set("location[workspace]", location.workspace)
    if (!save) url.searchParams.set("path", filePath)
    const response = await input.fetch(url, {
      method: save ? "PUT" : "GET",
      headers: { ...input.headers, ...(save ? { "Content-Type": "application/json" } : {}) },
      body: save ? JSON.stringify(save) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const data = body && typeof body === "object" && "data" in body ? body.data : undefined
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.status === 404
          ? "This server does not support safe text editing yet. The file remains read-only."
          : `Text document request failed (${response.status})`
      throw new TextDocumentRequestError(message, response.status)
    }
    const value = body && typeof body === "object" && "data" in body ? body.data : undefined
    if (
      !TextDocument.isInfo(value) ||
      value.path !== filePath ||
      !/^[a-f0-9]{64}$/.test(value.version) ||
      value.text.length > TextDocument.MAX_TEXT_LENGTH
    ) throw new TextDocumentRequestError("The server returned an invalid text snapshot; nothing was overwritten.", 502)
    return value
  }
  return {
    read: (value: { directory: string; workspace?: string; path: string }) => request(value, value.path),
    save: (value: TextDocument.SaveInput & { directory: string; workspace?: string }) =>
      request(value, value.path, { path: value.path, baseVersion: value.baseVersion, text: value.text }),
  }
}

export type TextDocumentApi = ReturnType<typeof createTextDocumentApi>
