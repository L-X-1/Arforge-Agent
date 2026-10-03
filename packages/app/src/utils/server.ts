import { createArforgeClient } from "@arforge-ai/sdk/v2/client"
import { Arforge, type ArforgeClient } from "@arforge-ai/client/promise"
import { Arforge as CurrentArforge } from "@arforge-ai/sdk-next/remote"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { createMemoryCandidateReviewApi } from "@/utils/memory-candidate-api"
import { createTextDocumentApi } from "@/utils/text-document-api"
import { createPreviewResourceApi } from "@/utils/preview-resource-api"
import { createSessionPromptApi } from "@/utils/session-prompt-api"

const fetchWithSession = Object.assign(
  (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) =>
    globalThis.fetch(input, {
      ...init,
      credentials: "include",
    }),
  { preconnect: globalThis.fetch.preconnect },
)

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "arforge"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "arforge",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createArforgeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createArforgeClient({
    ...config,
    fetch: config.fetch ?? fetchWithSession,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): ArforgeClient {
  const options = {
    baseUrl: input.server.url,
    fetch: input.fetch ?? fetchWithSession,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  }
  const api = Arforge.make(options)
  const current = CurrentArforge.make(options)
  return {
    ...api,
    session: { ...api.session, prompt: createSessionPromptApi(current.sessions.prompt) },
  }
}

export type ServerApi = ArforgeClient

export function createOperationsApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}) {
  const headers = input.server.password
    ? {
        Authorization: `Basic ${authTokenFromCredentials({
          username: input.server.username,
          password: input.server.password,
        })}`,
      }
    : undefined
  const api = CurrentArforge.make({
    baseUrl: input.server.url,
    fetch: input.fetch ?? fetchWithSession,
    headers,
  })
  const controlledSession = async (inputValue: {
    readonly sessionID: string
    readonly directory: string
    readonly workspace?: string
    readonly operation: "revert" | "unrevert"
    readonly body: Readonly<Record<string, string | undefined>>
  }) => {
    const url = new URL(
      `/experimental/session/${encodeURIComponent(inputValue.sessionID)}/${inputValue.operation}`,
      input.server.url,
    )
    url.searchParams.set("directory", inputValue.directory)
    if (inputValue.workspace) url.searchParams.set("workspace", inputValue.workspace)
    const response = await (input.fetch ?? fetchWithSession)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(inputValue.body),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) {
      const directMessage =
        body && typeof body === "object" && "message" in body && typeof body.message === "string"
          ? body.message
          : undefined
      const nestedData = body && typeof body === "object" && "data" in body ? body.data : undefined
      const nestedMessage =
        nestedData &&
        typeof nestedData === "object" &&
        "message" in nestedData &&
        typeof nestedData.message === "string"
          ? nestedData.message
          : undefined
      const message = directMessage ?? nestedMessage ?? `Controlled session request failed (${response.status})`
      throw new Error(message, { cause: { status: response.status, body } })
    }
    return body
  }
  return Object.assign(api, {
    previewResources: createPreviewResourceApi({ baseUrl: input.server.url, fetch: input.fetch ?? fetchWithSession, headers }),
    textDocuments: createTextDocumentApi({
      baseUrl: input.server.url,
      fetch: input.fetch ?? fetchWithSession,
      headers,
    }),
    memoryCandidates: createMemoryCandidateReviewApi({
      baseUrl: input.server.url,
      fetch: input.fetch ?? fetchWithSession,
      headers,
    }),
    controlledSessions: {
      revert: (value: {
        readonly sessionID: string
        readonly directory: string
        readonly workspace?: string
        readonly requestID: string
        readonly messageID: string
        readonly partID?: string
      }) =>
        controlledSession({
          ...value,
          operation: "revert",
          body: { requestID: value.requestID, messageID: value.messageID, partID: value.partID },
        }),
      unrevert: (value: {
        readonly sessionID: string
        readonly directory: string
        readonly workspace?: string
        readonly requestID: string
      }) => controlledSession({ ...value, operation: "unrevert", body: { requestID: value.requestID } }),
    },
  })
}

export type OperationsApi = ReturnType<typeof createOperationsApiForServer>
