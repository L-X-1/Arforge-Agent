import { expect, test } from "bun:test"
import { McpOAuthFetch } from "../../src/mcp/oauth-fetch"

const request = () => ({ method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "owned-R1", client_id: "owned" }) })
const tokens = { access_token: "owned-A2", refresh_token: "owned-R2", token_type: "Bearer", expires_in: 3600 }

test("different subscriber facades share one response through the save gap", async () => {
  let calls = 0, emptied = 0
  const gate = Promise.withResolvers<Response>()
  const shared = McpOAuthFetch.shared(() => emptied++, () => {}, async () => { calls++; return gate.promise })
  const a = shared.attach(), b = shared.attach()
  a.observe({ access_token: "owned-A1", refresh_token: "owned-R1", token_type: "Bearer" })
  b.observe({ access_token: "owned-A1", refresh_token: "owned-R1", token_type: "Bearer" })
  try {
    const first = a.fetch("https://owned.invalid/token", request())
    gate.resolve(Response.json(tokens))
    expect(await (await first).json()).toEqual(tokens)
    // A has the HTTP result but has not committed it to storage yet.
    expect(await (await b.fetch("https://owned.invalid/token", request())).json()).toEqual(tokens)
    expect(calls).toBe(1)
    expect(a.proof(tokens)).toBe(b.proof(tokens))
    a.committed(tokens)
    expect(() => b.assertSave(tokens)).not.toThrow()
    a.invalidate()
    expect(shared.subscribers()).toBe(1)
    expect(() => b.assertSave(tokens)).not.toThrow()
    expect(() => a.assertSave(tokens)).toThrow()
  } finally { a.invalidate(); b.invalidate() }
  expect(emptied).toBe(1)
  expect(shared.subscribers()).toBe(0)
})

test("cancelling one transport does not abort another provider waiter", async () => {
  const gate = Promise.withResolvers<Response>()
  let networkSignal: AbortSignal | null | undefined
  const shared = McpOAuthFetch.shared(() => {}, () => {}, async (_url, init) => { networkSignal = init?.signal; return gate.promise })
  const a = shared.attach(), b = shared.attach(), cancel = new AbortController()
  try {
    const first = a.bind(cancel.signal)("https://owned.invalid/token", request())
    const failed = first.then(() => false, () => true)
    const second = b.fetch("https://owned.invalid/token", request())
    cancel.abort()
    expect(await failed).toBe(true)
    expect(networkSignal?.aborted).toBe(false)
    gate.resolve(Response.json(tokens))
    expect(await (await second).json()).toEqual(tokens)
    expect(() => b.assertSave(tokens)).not.toThrow()
  } finally { a.invalidate(); b.invalidate(); gate.resolve(Response.json(tokens)) }
})

test("final release aborts ignored-abort work and rejects every late save", async () => {
  const gate = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  const shared = McpOAuthFetch.shared(() => {}, () => {}, async (_url, init) => { signal = init?.signal; return gate.promise })
  const a = shared.attach(), b = shared.attach()
  const first = a.fetch("https://owned.invalid/token", request()).then(() => false, () => true)
  const second = b.fetch("https://owned.invalid/token", request()).then(() => false, () => true)
  a.invalidate(); b.invalidate()
  expect(signal?.aborted).toBe(true)
  gate.resolve(Response.json(tokens))
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(() => a.assertSave(tokens)).toThrow()
  expect(() => b.assertSave(tokens)).toThrow()
  expect(shared.subscribers()).toBe(0)
})

test("shared credential authority still separates exact resource/scope requests", async () => {
  let calls = 0
  const shared = McpOAuthFetch.shared(() => {}, () => {}, async (_url, init) => {
    calls++
    const form = new URLSearchParams(String(init?.body))
    return Response.json({ ...tokens, access_token: "owned-access-" + form.get("resource"), refresh_token: "owned-R1" })
  })
  const a = shared.attach(), b = shared.attach()
  try {
    const one = request(), two = request()
    one.body.set("resource", "one"); two.body.set("resource", "two")
    two.body.set("scope", "other")
    const [first, second] = await Promise.all([
      a.fetch("https://owned.invalid/token", one), b.fetch("https://owned.invalid/token", two),
    ])
    expect((await first.json()).access_token).toBe("owned-access-one")
    expect((await second.json()).access_token).toBe("owned-access-two")
    expect(calls).toBe(2)
  } finally { a.invalidate(); b.invalidate() }
})
