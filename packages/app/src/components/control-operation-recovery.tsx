import { createEffect } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { authTokenFromCredentials } from "@/utils/server"
import { showControlOperationStatusNotice } from "@/utils/control-operation-notice"
import {
  startControlOperationRecovery,
  type ControlOperationRecoveryTarget,
  type ControlOperationStatusLookup,
} from "@/utils/control-operation-recovery"

function statusLookup(input: {
  readonly baseUrl: string
  readonly username?: string
  readonly password?: string
}): ControlOperationStatusLookup {
  return async (request) => {
    const url = new URL(`/experimental/control-operation/${encodeURIComponent(request.requestID)}`, input.baseUrl)
    url.searchParams.set("directory", request.location)
    url.searchParams.set("operation", request.operation)
    const response = await fetch(url, {
      credentials: "include",
      headers: input.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: input.username, password: input.password })}` }
        : undefined,
    })
    if (!response.ok) throw new Error("Control operation status is unavailable")
    return response.json()
  }
}

/**
 * App-root recovery host. It intentionally lives outside either layout and
 * reports server-backed phase for every configured server, not just the
 * selected one. It never resumes or mutates from a browser intent.
 */
export function ControlOperationRecovery() {
  const global = useGlobal()
  const language = useLanguage()
  const announced = new Set<string>()

  createEffect(() => {
    const targets = global.servers.list().map((connection) => {
      const sdk = global.ensureServerCtx(connection).sdk
      return {
        scope: sdk.scope,
        lookup: statusLookup({ baseUrl: connection.http.url, ...connection.http }),
      } satisfies ControlOperationRecoveryTarget
    })

    void startControlOperationRecovery(targets)
      .then(({ corruptKeys, unavailableServerScopes, blockedServerScopes, statuses }) => {
        if (corruptKeys.length > 0) {
          console.warn("Corrupt control-operation intents require user cleanup", { keys: corruptKeys })
        }
        if (unavailableServerScopes.length > 0) {
          console.warn("Control-operation intents are waiting for unavailable configured servers", {
            scopes: unavailableServerScopes,
          })
        }
        if (blockedServerScopes.length > 0) {
          console.warn("Control-operation recovery is blocked until an authoritative run status is available", {
            scopes: blockedServerScopes,
          })
        }
        if (statuses.length > 0) {
          for (const { status } of statuses) {
            const key = `${status.requestID}:${status.phase}`
            if (announced.has(key)) continue
            announced.add(key)
            showControlOperationStatusNotice(status, (message) => language.t(message))
          }
          console.info("Control-operation recovery loaded server-backed phases", {
            statuses: statuses.map(({ scope, status }) => ({
              scope,
              requestID: status.requestID,
              operation: status.operation,
              phase: status.phase,
            })),
          })
        }
      })
      .catch((error) => console.warn("Control-operation recovery could not start", error))
  })

  return null
}
