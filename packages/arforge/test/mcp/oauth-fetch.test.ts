import { expect, test } from "bun:test"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpOAuthFetch } from "../../src/mcp/oauth-fetch"

function deferred<A>() {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const request = (token = "owned-refresh", extra = "") => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams("grant_type=refresh_token&refresh_token=" + token + "&client_id=owned" + extra),
})
const response = () =>
  Response.json({ access_token: "owned-access", refresh_token: "owned-rotated", token_type: "Bearer" })

test("SDK omitted refresh_token retains predecessor identity and permits the next expiry exchange", async () => {
  let calls = 0
  const owner = McpOAuthFetch.make(async () => {
    calls++
    return Response.json({ access_token: "owned-access-" + calls, token_type: "Bearer" })
  })
  owner.observe({ access_token: "old", refresh_token: "owned-refresh", token_type: "Bearer" })
  const first = await (await owner.fetch("https://owned.example/token", request())).json()
  const effective = { refresh_token: "owned-refresh", ...first }
  expect(() => owner.assertSave(effective)).not.toThrow()
  owner.committed(effective)
  await owner.fetch("https://owned.example/token", request())
  expect(calls).toBe(2)
})

test("same owner and refresh request exchanges once and gives independently readable Responses", async () => {
  const gate = deferred<Response>()
  let calls = 0
  const owner = McpOAuthFetch.make(async () => {
    calls++
    return gate.promise
  })
  const first = owner.fetch("https://owned.example/token", request())
  const second = owner.fetch("https://owned.example/token", request())
  const third = owner.fetch("https://owned.example/token", request())
  expect(calls).toBe(1)
  gate.resolve(response())
  const values = await Promise.all([first, second, third])
  expect(new Set(values).size).toBe(3)
  expect(await Promise.all(values.map((value) => value.json()))).toEqual(
    Array(3).fill({ access_token: "owned-access", refresh_token: "owned-rotated", token_type: "Bearer" }),
  )
})

test("late caller between HTTP completion and provider persistence reuses the completed exchange", async () => {
  let calls = 0
  const owner = McpOAuthFetch.make(async () => {
    calls++
    return response()
  })
  const first = await owner.fetch("https://owned.example/token", request())
  await first.json()
  // The real SDK still has asynchronous provider.saveTokens work ahead here.
  const late = await owner.fetch("https://owned.example/token", request())
  expect(calls).toBe(1)
  expect(await late.json()).toMatchObject({ refresh_token: "owned-rotated" })
})

test("different owner, endpoint, credentials, resource and scope never share an exchange", async () => {
  let calls = 0
  const base: FetchLike = async () => {
    calls++
    return response()
  }
  const a = McpOAuthFetch.make(base),
    b = McpOAuthFetch.make(base)
  await Promise.all([
    a.fetch("https://owned.example/token", request()),
    b.fetch("https://owned.example/token", request()),
    a.fetch("https://other.example/token", request()),
    a.fetch("https://owned.example/token", request("other")),
    a.fetch("https://owned.example/token", request("owned-refresh", "&resource=one")),
    a.fetch("https://owned.example/token", request("owned-refresh", "&scope=other")),
    a.fetch("https://owned.example/token", { ...request(), headers: { authorization: "Basic owned-other-client" } }),
  ])
  expect(calls).toBe(7)
})

test("non-refresh requests pass through unchanged and are never coalesced", async () => {
  const result = response(),
    options = { method: "POST", body: new URLSearchParams("grant_type=authorization_code&code=owned") }
  const seen: unknown[][] = []
  const owner = McpOAuthFetch.make(async (...args) => {
    seen.push(args)
    return result
  })
  expect(await owner.fetch("https://owned.example/token", options)).toBe(result)
  expect(await owner.fetch("https://owned.example/token", options)).toBe(result)
  expect(seen).toEqual([
    ["https://owned.example/token", options],
    ["https://owned.example/token", options],
  ])
})

test("one waiter abort does not cancel another authorized refresh waiter", async () => {
  const gate = deferred<Response>(),
    a = new AbortController(),
    b = new AbortController()
  let sharedSignal: AbortSignal | null | undefined,
    calls = 0
  const owner = McpOAuthFetch.make(async (_url, init) => {
    calls++
    sharedSignal = init?.signal
    return gate.promise
  })
  const first = owner
    .fetch("https://owned.example/token", { ...request(), signal: a.signal })
    .catch((error) => error.name)
  const second = owner.fetch("https://owned.example/token", { ...request(), signal: b.signal })
  a.abort(new DOMException("owned cancellation", "AbortError"))
  expect(await first).toBe("AbortError")
  expect(sharedSignal?.aborted).toBe(false)
  gate.resolve(response())
  expect((await second).ok).toBe(true)
  expect(calls).toBe(1)
})

test("all waiter cancellation evicts only that flight, and late cleanup preserves its replacement", async () => {
  const old = deferred<Response>(),
    cancel = new AbortController()
  let calls = 0
  const owner = McpOAuthFetch.make(async () => {
    calls++
    return calls === 1 ? old.promise : response()
  })
  const first = owner
    .fetch("https://owned.example/token", { ...request(), signal: cancel.signal })
    .catch((error) => error.name)
  cancel.abort(new DOMException("owned cancellation", "AbortError"))
  expect(await first).toBe("AbortError")
  await owner.fetch("https://owned.example/token", request())
  old.resolve(response())
  await Promise.resolve()
  await owner.fetch("https://owned.example/token", request())
  expect(calls).toBe(2)
})

test("network, invalid_grant and malformed successful responses remain visible and are evicted", async () => {
  for (const mode of ["network", "invalid-grant", "malformed"] as const) {
    let calls = 0
    const owner = McpOAuthFetch.make(async () => {
      calls++
      if (calls > 1) return response()
      if (mode === "network") throw new Error("owned network failure")
      if (mode === "invalid-grant") return Response.json({ error: "invalid_grant" }, { status: 400 })
      return Response.json({ access_token: "missing-required-token-type" })
    })
    const first = await owner.fetch("https://owned.example/token", request()).then(
      (value) => value.status,
      () => "rejected",
    )
    expect(first).toBe(mode === "network" ? "rejected" : mode === "invalid-grant" ? 400 : 200)
    expect((await owner.fetch("https://owned.example/token", request())).ok).toBe(true)
    expect(calls).toBe(2)
  }
})

test("revocation rejects an in-flight exchange immediately even when its fetch ignores abort", async () => {
  const gate = deferred<Response>()
  const owner = McpOAuthFetch.make(async () => gate.promise)
  const pending = owner.fetch("https://owned.example/token", request()).catch((error) => error.name)
  owner.invalidate()
  expect(await pending).toBe("AbortError")
  gate.resolve(response())
  expect(() =>
    owner.assertSave({ access_token: "owned-access", refresh_token: "owned-rotated", token_type: "Bearer" }),
  ).toThrow()
})

test("a closed transport cannot start a token request or publish an earlier response", async () => {
  const controller = new AbortController(),
    gate = deferred<Response>()
  let calls = 0
  const owner = McpOAuthFetch.make(async () => {
    calls++
    return gate.promise
  })
  const bound = owner.bind(controller.signal)
  const pending = bound("https://owned.example/token", request()).catch((error) => error.name)
  controller.abort(new DOMException("owned transport closed", "AbortError"))
  owner.invalidate()
  expect(await pending).toBe("AbortError")
  expect(await bound("https://owned.example/token", request()).catch((error) => error.name)).toBe("AbortError")
  expect(calls).toBe(1)
  gate.resolve(response())
})

test("a retired credential generation cannot overwrite a newer rotation or re-exchange its old token", async () => {
  let calls = 0
  const owner = McpOAuthFetch.make(async () =>
    Response.json({ access_token: "access-" + ++calls, refresh_token: "rotation-" + calls, token_type: "Bearer" }),
  )
  owner.observe({ access_token: "old", refresh_token: "owned-refresh", token_type: "Bearer" })
  const first = await (await owner.fetch("https://owned.example/token", request())).json()
  owner.committed(first)
  const second = await (await owner.fetch("https://owned.example/token", request("rotation-1"))).json()
  owner.committed(second)
  expect(() => owner.assertSave(first)).toThrow()
  expect(await owner.fetch("https://owned.example/token", request()).catch((error) => error.name)).toBe("AbortError")
  expect(calls).toBe(2)
})
