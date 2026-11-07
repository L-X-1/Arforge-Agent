import { expect, test } from "bun:test"
import { ClientError } from "@arforge-ai/client/promise"
import { createStore } from "solid-js/store"
import { createPermissionRetirement } from "./permission-retirement"

const ask = (id: string, scope = "ses_owned") => ({
  id,
  sessionID: scope,
  resources: ["echo owned"],
  requiresHumanConfirmation: true,
})
const paused = { type: "agent.run.state-changed", data: { sessionID: "ses_owned", to: "paused" } }
const failed = { type: "session.next.step.failed", data: { sessionID: "ses_owned" } }
function setup(read: (current: () => boolean) => Promise<readonly ReturnType<typeof ask>[]>) {
  const [state, set] = createStore({
    requests: [ask("per_old"), ask("per_live")],
    draft: "retained draft",
    savedRules: [],
  })
  let live = true,
    calls = 0,
    writes = 0
  const notices: { error: unknown; retry: () => void }[] = []
  const owner = createPermissionRetirement({
    get: () => state.requests,
    set: (_id, requests) => {
      writes++
      set("requests", requests)
    },
    read: (_id, current) => {
      calls++
      return read(current)
    },
    capture: () => () => live,
    onError: (error, retry) => notices.push({ error, retry }),
  })
  return {
    owner,
    state,
    set,
    notices,
    retire: () => {
      live = false
    },
    calls: () => calls,
    writes: () => writes,
  }
}

test("a stopped task prunes only vanished asks, coalesces terminal events and leaves live L3 requests/draft/rules intact", async () => {
  const response = Promise.withResolvers<ReturnType<typeof ask>[]>()
  const ctx = setup(() => response.promise)
  ctx.owner.observe({ type: failed.type, current: failed })
  ctx.owner.observe({ type: paused.type, current: paused })
  const done = ctx.owner.refresh("ses_owned")
  response.resolve([ask("per_live")])
  await done
  expect(ctx.calls()).toBe(1)
  expect(ctx.state.requests).toEqual([ask("per_live")])
  expect(ctx.state.draft).toBe("retained draft")
  expect(ctx.state.savedRules).toEqual([])
})

test("new and updated Asked events outrank an older empty GET", async () => {
  const response = Promise.withResolvers<ReturnType<typeof ask>[]>()
  const ctx = setup(() => response.promise),
    done = ctx.owner.refresh("ses_owned")
  ctx.set("requests", [ask("per_old"), ask("per_live"), ask("per_new")])
  ctx.owner.observe({ type: "permission.asked", properties: { id: "per_live", sessionID: "ses_owned" } })
  ctx.owner.observe({
    type: "permission.v2.asked",
    current: { type: "permission.v2.asked", data: { id: "per_new", sessionID: "ses_owned" } },
  })
  response.resolve([])
  await done
  expect(ctx.state.requests).toEqual([ask("per_live"), ask("per_new")])
})

test("a replied request is never resurrected by the earlier GET", async () => {
  const response = Promise.withResolvers<ReturnType<typeof ask>[]>()
  const ctx = setup(() => response.promise),
    done = ctx.owner.refresh("ses_owned")
  ctx.set("requests", [])
  ctx.owner.observe({ type: "permission.replied", properties: { requestID: "per_old", sessionID: "ses_owned" } })
  response.resolve([ask("per_old")])
  await done
  expect(ctx.state.requests).toEqual([])
  expect(ctx.writes()).toBe(0)
})

test("A-B-A source retirement blocks a late read and preserves its replacement's pending identity", async () => {
  const a = Promise.withResolvers<ReturnType<typeof ask>[]>(),
    b = Promise.withResolvers<ReturnType<typeof ask>[]>()
  let turn = 0
  const ctx = setup(() => (++turn === 1 ? a.promise : b.promise)),
    old = ctx.owner.refresh("ses_owned")
  await Promise.resolve()
  ctx.owner.observe({
    type: "session.next.moved",
    current: { type: "session.next.moved", data: { sessionID: "ses_owned" } },
  })
  const replacement = ctx.owner.refresh("ses_owned")
  a.resolve([])
  await old
  expect(ctx.state.requests).toHaveLength(2)
  expect(ctx.owner.refresh("ses_owned")).toBe(replacement)
  b.resolve([ask("per_live")])
  await replacement
  expect(ctx.state.requests).toEqual([ask("per_live")])
})

test("an unavailable GET keeps asks visible, offers explicit retry and never interprets403 as an empty list", async () => {
  let denied = true
  const error = new ClientError("UnexpectedStatus", { cause: { status: 403 } })
  const ctx = setup(async () => {
    if (denied) throw error
    return []
  })
  await ctx.owner.refresh("ses_owned")
  expect(ctx.calls()).toBe(1)
  expect(ctx.state.requests).toHaveLength(2)
  expect(ctx.notices).toHaveLength(1)
  denied = false
  ctx.notices[0].retry()
  await ctx.owner.refresh("ses_owned")
  expect(ctx.calls()).toBe(2)
  expect(ctx.state.requests).toEqual([])
})

test("a failed read's old retry cannot dispatch after delete or move back to the same ID", async () => {
  const ctx = setup(async () => {
    throw new Error("unavailable")
  })
  await ctx.owner.refresh("ses_owned")
  expect(ctx.notices).toHaveLength(1)
  ctx.owner.observe({ type: "session.deleted", properties: { info: { id: "ses_owned" } } })
  ctx.notices[0].retry()
  await Promise.resolve()
  expect(ctx.calls()).toBe(1)
})

test("page retirement during transport backoff prevents another GET and any error notice", async () => {
  const started = Promise.withResolvers<void>()
  const ctx = setup(async () => {
    started.resolve()
    throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
  })
  const done = ctx.owner.refresh("ses_owned")
  await started.promise
  ctx.retire()
  await done
  expect(ctx.calls()).toBe(1)
  expect(ctx.writes()).toBe(0)
  expect(ctx.notices).toEqual([])
})

test("malformed success responses keep the existing asks rather than pruning them", async () => {
  const ctx = setup(async () => ({ data: [] }) as unknown as ReturnType<typeof ask>[])
  await ctx.owner.refresh("ses_owned")
  expect(ctx.writes()).toBe(0)
  expect(ctx.state.requests).toHaveLength(2)
  expect(ctx.notices).toHaveLength(1)
})

test("ordinary streaming/completion without a retired ask adds no polling; disposal blocks deferred first dispatch", async () => {
  const ctx = setup(async () => [])
  ctx.owner.observe({
    type: "session.next.text.delta",
    current: { type: "session.next.text.delta", data: { sessionID: "ses_owned" } },
  })
  ctx.owner.observe({
    type: "session.next.step.ended",
    current: { type: "session.next.step.ended", data: { sessionID: "ses_owned", finish: "stop" } },
  })
  expect(ctx.calls()).toBe(0)
  const done = ctx.owner.refresh("ses_owned")
  ctx.owner.dispose()
  await done
  expect(ctx.calls()).toBe(0)
  expect(ctx.writes()).toBe(0)
})

test("a settled run with no cached approval adds no GET", async () => {
  const ctx = setup(async () => [])
  ctx.set("requests", [])
  ctx.owner.observe({ type: paused.type, current: paused })
  await ctx.owner.refresh("ses_owned")
  expect(ctx.calls()).toBe(0)
  expect(ctx.writes()).toBe(0)
})
