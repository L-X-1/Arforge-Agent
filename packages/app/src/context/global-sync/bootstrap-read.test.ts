import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { Arforge, ClientError } from "@arforge-ai/client"
import { createRequestLifetime } from "../request-lifetime"
import { loadRootSessions } from "./session-load"
import { ClientError as CurrentClientError } from "@arforge-ai/sdk-next/remote"
import { isTransientBootstrapReadError, retryBootstrapRead } from "./bootstrap-read"

const clients: QueryClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test("real generated session GET and Query recover inside the read before an outer catch can swallow failure", async () => {
  const requests: { method: string; directory: string | null }[] = []
  const api = Arforge.make({
    baseUrl: "http://owned.invalid",
    fetch: Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ method: init?.method ?? "GET", directory: new URL(String(url)).searchParams.get("directory") })
        if (requests.length === 1) throw new TypeError("Failed to fetch")
        return Response.json({ location: { directory: "/owned" }, data: [] })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  let caught = 0
  const queryKey = ["owned-sdk", "/owned", "loadSessions"]
  await client.fetchQuery({
    queryKey,
    queryFn: () =>
      retryBootstrapRead(
        () => loadRootSessions({ api: api.session, directory: "/owned", limit: 10 }),
        () => true,
      ).catch(() => {
        caught++
        return undefined
      }),
  })
  expect(requests).toEqual([
    { method: "GET", directory: "/owned" },
    { method: "GET", directory: "/owned" },
  ])
  expect(caught).toBe(0)
  expect(client.getQueryState(queryKey)?.status).toBe("success")
})

test("three failed read attempts stay an error and a later manual query retry can recover", async () => {
  let offline = true
  let reads = 0
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const options = {
    queryKey: ["owned-sdk", "/owned", "loadSessions"],
    queryFn: () =>
      retryBootstrapRead(
        async () => {
          reads++
          if (offline) throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
          return ["owned-result"]
        },
        () => true,
      ),
  }
  await expect(client.fetchQuery(options)).rejects.toMatchObject({ reason: "Transport" })
  expect(reads).toBe(3)
  expect(client.getQueryState(options.queryKey)?.status).toBe("error")
  offline = false
  const recovered = await client.fetchQuery<string[]>(options)
  expect(recovered).toEqual(["owned-result"])
  expect(reads).toBe(4)
})

test.each([
  new DOMException("Cancelled", "AbortError"),
  new DOMException("Deadline", "TimeoutError"),
  new Error("ETIMEDOUT"),
  new ClientError("Transport", { cause: new DOMException("Deadline", "TimeoutError") }),
  new ClientError("Transport", { cause: new DOMException("Cancelled", "AbortError") }),
  new ClientError("Transport", { cause: { status: 403 } }),
  new ClientError("UnexpectedStatus", { cause: { status: 401 } }),
  new ClientError("UnexpectedStatus", { cause: { status: 404 } }),
  new ClientError("UnexpectedStatus", { cause: { status: 500 } }),
  { _tag: "PermissionDenied", message: "Failed to fetch", status: 403 },
  new TypeError("Invalid URL"),
])("auth, cancellation, status and non-network errors never gain read retries: %p", async (error) => {
  let reads = 0
  expect(isTransientBootstrapReadError(error)).toBe(false)
  await expect(
    retryBootstrapRead(
      async () => {
        reads++
        throw error
      },
      () => true,
    ),
  ).rejects.toBe(error)
  expect(reads).toBe(1)
})

test("source retirement during retry backoff prevents another request", async () => {
  let current = true
  let reads = 0
  const first = deferred<void>()
  const result = retryBootstrapRead(
    async () => {
      reads++
      first.resolve()
      throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
    },
    () => current,
  )
  const observed = result.then(
    () => undefined,
    (error: unknown) => error,
  )
  await first.promise
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  current = false
  expect(await observed).toMatchObject({ name: "AbortError" })
  expect(reads).toBe(1)
})

test("real Query cancellation during backoff revokes the read while its server owner remains live", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  const first = deferred<void>()
  const queryKey = ["owned-sdk", "/owned", "cancelled-read"]
  let reads = 0
  let work: Promise<string> | undefined
  const request = client.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => {
      work = retryBootstrapRead(
        async () => {
          reads++
          first.resolve()
          throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
        },
        () => !signal.aborted,
      )
      return work
    },
  })
  const observed = request.catch(() => undefined)
  await first.promise
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await client.cancelQueries({ queryKey })
  await observed
  await work?.catch(() => undefined)
  expect(reads).toBe(1)
  expect(client.getQueryData(queryKey)).toBeUndefined()
})

test("the current client transport wrapper also receives only bounded GET retries", async () => {
  let reads = 0
  const value = await retryBootstrapRead(
    async () => {
      if (++reads === 1) throw new CurrentClientError("Transport", { cause: new TypeError("Failed to fetch") })
      return "current-client"
    },
    () => true,
  )
  expect(value).toBe("current-client")
  expect(reads).toBe(2)
})

test("retiring a source while protocol selection waits prevents even the first command GET", async () => {
  const { loadCommands } = await import("./bootstrap")
  const protocol = deferred<"v1" | "v2">()
  let current = true
  let reads = 0
  const result = loadCommands(
    "/owned",
    {
      list: async () => {
        reads++
        return { location: { directory: "/owned", project: { id: "owned", directory: "/owned" } }, data: [] }
      },
    },
    undefined,
    protocol.promise,
    () => current,
  )
  const observed = result.then(
    () => undefined,
    (error: unknown) => error,
  )
  current = false
  protocol.resolve("v2")
  expect(await observed).toMatchObject({ name: "AbortError" })
  expect(reads).toBe(0)
})

test("a pending response cannot publish after pagehide/pageshow revives the same source identity", async () => {
  const page = new EventTarget()
  const lifetime = createRequestLifetime(page)
  const current = lifetime.capture()
  const held = deferred<string>()
  const published: string[] = []
  const request = retryBootstrapRead(() => held.promise, current).then((value) => {
    published.push(value)
  })
  const observed = request.then(
    () => undefined,
    (error: unknown) => error,
  )
  page.dispatchEvent(new Event("pagehide"))
  page.dispatchEvent(new Event("pageshow"))
  held.resolve("old-response")
  expect(await observed).toMatchObject({ name: "AbortError" })
  expect(lifetime.active()).toBe(true)
  expect(published).toEqual([])
  lifetime.dispose()
})
