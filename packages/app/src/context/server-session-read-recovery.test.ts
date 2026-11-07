import { expect, test } from "bun:test"
import { Arforge, ClientError } from "@arforge-ai/client/promise"
import type { ArforgeClient, Session } from "@arforge-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const latest = { id: "msg_2", type: "user", text: "latest", time: { created: 2 } }
const older = { id: "msg_1", type: "user", text: "older", time: { created: 1 } }
const page = (data: unknown[], next: string | null) => ({ data, cursor: { previous: null, next } })
const transport = () => new ClientError("Transport", { cause: new TypeError("Failed to fetch") })

function setup(read: (url: URL, count: number) => Response | Promise<Response>, capture?: () => () => boolean) {
  const requests: URL[] = []
  const api = Arforge.make({
    baseUrl: "http://owned.invalid",
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input))
        requests.push(url)
        return read(url, requests.length)
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const store = createServerSession({} as ArforgeClient, api.session, api.message, { capture })
  store.remember({
    id: "ses_owned",
    slug: "owned",
    projectID: "p",
    directory: "/owned",
    title: "Owned",
    version: "1",
    time: { created: 1, updated: 1 },
  } as Session)
  return { store, requests }
}

test("real generated message GET retries wrapped Transport with the same opaque cursor", async () => {
  const ctx = setup((url, count) => {
    if (count === 1) return Response.json(page([latest], "opaque+/="))
    if (count === 2) throw new TypeError("Failed to fetch")
    return Response.json(page([older], null))
  })
  await ctx.store.sync("ses_owned")
  await ctx.store.history.loadMore("ses_owned")
  expect(ctx.requests).toHaveLength(3)
  expect(ctx.requests[1].searchParams.get("cursor")).toBe("opaque+/=")
  expect(ctx.requests[2].href).toBe(ctx.requests[1].href)
  expect(ctx.store.data.message.ses_owned.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
  expect(ctx.store.history.loading("ses_owned")).toBe(false)
})

test("three failed attempts retain existing messages and the cursor for an explicit retry", async () => {
  let offline = true
  const ctx = setup((_url, count) => {
    if (count === 1) return Response.json(page([latest], "older"))
    if (offline) throw transport()
    return Response.json(page([older], null))
  })
  await ctx.store.sync("ses_owned")
  await expect(ctx.store.history.loadMore("ses_owned")).rejects.toMatchObject({ reason: "Transport" })
  expect(ctx.requests).toHaveLength(4)
  expect(ctx.store.data.message.ses_owned.map((x) => x.id)).toEqual(["msg_2"])
  expect(ctx.store.history.more("ses_owned")).toBe(true)
  expect(ctx.store.history.loading("ses_owned")).toBe(false)
  offline = false
  await ctx.store.history.loadMore("ses_owned")
  expect(ctx.requests).toHaveLength(5)
  expect(ctx.store.data.message.ses_owned.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
})

test("HTTP forbidden never receives a read retry or clears loaded history", async () => {
  const ctx = setup((_url, count) =>
    count === 1 ? Response.json(page([latest], "older")) : new Response("Forbidden", { status: 403 }),
  )
  await ctx.store.sync("ses_owned")
  await expect(ctx.store.history.loadMore("ses_owned")).rejects.toBeDefined()
  expect(ctx.requests).toHaveLength(2)
  expect(ctx.store.data.message.ses_owned.map((x) => x.id)).toEqual(["msg_2"])
})

test("a retired page lifetime cannot issue another request during backoff", async () => {
  let live = true
  const firstFailure = Promise.withResolvers<void>()
  const ctx = setup(
    (_url, count) => {
      if (count === 1) return Response.json(page([latest], "older"))
      firstFailure.resolve()
      throw new TypeError("Failed to fetch")
    },
    () => () => live,
  )
  await ctx.store.sync("ses_owned")
  const observed = ctx.store.history.loadMore("ses_owned").catch((error) => error)
  await firstFailure.promise
  live = false
  expect(await observed).toBeUndefined()
  expect(ctx.requests).toHaveLength(2)
})

test("a successful response after page retirement never changes the cached messages", async () => {
  let live = true
  const pending = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const ctx = setup(
    (_url, count) => {
      if (count === 1) return Response.json(page([latest], "older"))
      requested.resolve()
      return pending.promise
    },
    () => () => live,
  )
  await ctx.store.sync("ses_owned")
  const observed = ctx.store.history.loadMore("ses_owned").catch((error) => error)
  await requested.promise
  live = false
  pending.resolve(Response.json(page([older], null)))
  expect(await observed).toBeUndefined()
  expect(ctx.store.data.message.ses_owned.map((x) => x.id)).toEqual(["msg_2"])
})
