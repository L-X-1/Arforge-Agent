import { createArforgeClient } from "@arforge-ai/sdk/v2/client"
import { Arforge, type ArforgeClient } from "@arforge-ai/client/promise"
import { Arforge as CurrentArforge } from "@arforge-ai/sdk-next/remote"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

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
  return Arforge.make({
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
  })
}

export type ServerApi = ArforgeClient

export function createOperationsApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}) {
  return CurrentArforge.make({
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
  })
}

export type OperationsApi = ReturnType<typeof createOperationsApiForServer>
