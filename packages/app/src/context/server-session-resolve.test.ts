import { describe, expect, test } from "bun:test"
import type { SessionApi, MessageApi } from "@arforge-ai/client/promise"
import type { ArforgeClient, Session } from "@arforge-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const info: Session = {
  id: "ses_resolve_owned",
  slug: "owned",
  projectID: "project",
  directory: "/owned",
  title: "Retained Session",
  version: "1",
  time: { created: 1, updated: 1 },
}
const currentInfo = {
  ...info,
  location: { directory: "/owned" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const transport = () =>
  Object.assign(new Error("Transport"), {
    name: "ClientError",
    reason: "Transport",
    cause: new TypeError("Failed to fetch"),
  })

function setup(protocol: "v1" | "v2", read: () => Promise<void>, capture?: () => () => boolean) {
  let calls = 0
  const get = async () => {
    calls++
    await read()
  }
  const client = {
    session: {
      get: async () => {
        await get()
        return { data: info }
      },
    },
  } as unknown as ArforgeClient
  const store =
    protocol === "v1"
      ? createServerSession(client, { capture })
      : createServerSession(
          client,
          {
            get: async () => {
              await get()
              return currentInfo
            },
          } as unknown as Omit<SessionApi, "compact">,
          {} as MessageApi,
          { capture },
        )
  return { store, calls: () => calls }
}

describe("owned Session metadata GET recovery", () => {
  for (const protocol of ["v1", "v2"] as const) {
    test(protocol + " retries a transient transport failure before remembering the exact Session", async () => {
      let failures = 1
      const ctx = setup(protocol, async () => {
        if (failures-- > 0) throw transport()
      })
      const resolved = await ctx.store.resolve(info.id)
      expect(resolved.id).toBe(info.id)
      expect(resolved.directory).toBe("/owned")
      expect(ctx.calls()).toBe(2)
      expect(ctx.store.get(info.id)?.title).toBe(info.title)
    })
  }

  test("exhausts three attempts and keeps failure visible without caching fabricated metadata", async () => {
    const ctx = setup("v2", async () => {
      throw transport()
    })
    await expect(ctx.store.resolve(info.id)).rejects.toMatchObject({ name: "ClientError", reason: "Transport" })
    expect(ctx.calls()).toBe(3)
    expect(ctx.store.get(info.id)).toBeUndefined()
  })

  for (const error of [
    Object.assign(new Error("unauthorized"), { status: 401 }),
    new DOMException("cancelled", "AbortError"),
    Object.assign(new Error("not found"), { _tag: "NotFound" }),
  ]) {
    test("does not retry authoritative or cancelled reads: " + error.name + " " + error.message, async () => {
      const ctx = setup("v2", async () => {
        throw error
      })
      await expect(ctx.store.resolve(info.id)).rejects.toBe(error)
      expect(ctx.calls()).toBe(1)
    })
  }

  test("deduplicates callers across the same bounded recovery", async () => {
    let failures = 1
    const ctx = setup("v2", async () => {
      if (failures-- > 0) throw transport()
    })
    const first = ctx.store.resolve(info.id),
      second = ctx.store.resolve(info.id)
    expect(second).toBe(first)
    expect((await first).id).toBe(info.id)
    expect(ctx.calls()).toBe(2)
  })

  test("source retirement during backoff prevents another GET and leaves the cache unchanged", async () => {
    let live = true
    const ctx = setup(
      "v2",
      async () => {
        throw transport()
      },
      () => () => live,
    )
    const pending = ctx.store.resolve(info.id)
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await Bun.sleep(0)
    expect(ctx.calls()).toBe(1)
    live = false
    expect(await settled).toMatchObject({ name: "AbortError" })
    expect(ctx.calls()).toBe(1)
    expect(ctx.store.get(info.id)).toBeUndefined()
  })
})
