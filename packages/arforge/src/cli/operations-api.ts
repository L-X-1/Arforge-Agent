import { Arforge } from "@arforge-ai/sdk-next/remote"
import { Context } from "effect"
import { resolve } from "node:path"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

const localHandler = HttpApiApp.webHandler()

const localFetch = (directory: string): typeof globalThis.fetch =>
  Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      headers.set("x-arforge-directory", resolve(directory))
      return localHandler.handler(
        new Request(request, { headers }),
        Context.empty() as Context.Context<unknown>,
      )
    },
    { preconnect: globalThis.fetch.preconnect },
  )

/**
 * In-process client for the exact operations API used by the desktop app.
 *
 * Keeping CLI operations behind the HTTP contract is intentional: Goal run
 * orchestration, durable prompt admission and optimistic revisions must not be
 * reimplemented by a second command-only service path.
 */
export function createOperationsApi(directory = process.cwd()) {
  return Arforge.make({
    baseUrl: "http://arforge.local",
    fetch: localFetch(directory),
  })
}

export function operationsErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
      return cause.message
    }
    return error.message
  }
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message
    try {
      return JSON.stringify(error)
    } catch {}
  }
  return String(error)
}
