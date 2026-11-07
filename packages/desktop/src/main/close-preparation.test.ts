import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { createClosePreparation } from "./close-preparation"

afterEach(() => mock.restore())

function fixture(options: { initiallyBlocked?: boolean; timeoutMs?: number; request?: (requestID: string) => void } = {}) {
  let blocked = options.initiallyBlocked ?? false
  let blocks = 0
  let restorations = 0
  let generation = 0
  const requests: string[] = []
  const controller = createClosePreparation({
    request(requestID) {
      requests.push(requestID)
      options.request?.(requestID)
    },
    blockInput() {
      const original = blocked
      blocks++
      blocked = true
      return () => {
        restorations++
        blocked = original
      }
    },
    createID: () => `close-${++generation}`,
    timeoutMs: options.timeoutMs,
  })
  return {
    controller,
    requests,
    blocked: () => blocked,
    blocks: () => blocks,
    restorations: () => restorations,
  }
}

describe("per-window close preparation", () => {
  test("holds close pending, deduplicates preparation and keeps input blocked after success", async () => {
    const ctx = fixture()
    const pending = ctx.controller.prepare()
    let settled = false
    void pending.then(() => { settled = true })
    expect(ctx.controller.prepare()).toBe(pending)
    expect(ctx.requests).toEqual(["close-1"])
    expect(ctx.blocks()).toBe(1)
    expect(ctx.blocked()).toBe(true)
    expect(ctx.controller.acknowledge({ requestID: "wrong-window-token", ok: true })).toBe(false)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(true)
    await pending
    expect(settled).toBe(true)
    expect(ctx.controller.ready).toBe(true)
    expect(ctx.controller.prepare()).toBe(pending)
    expect(ctx.blocked()).toBe(true)
    expect(ctx.restorations()).toBe(0)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: false, error: "late failure" })).toBe(false)
    expect(ctx.controller.ready).toBe(true)
    ctx.controller.cancel()
    ctx.controller.cancel()
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(false)
    expect(ctx.restorations()).toBe(1)
  })

  test("installs the shared promise before a synchronous request acknowledgement", async () => {
    let reentrant: Promise<void> | undefined
    const ctx = fixture({ request(requestID) {
      reentrant = ctx.controller.prepare()
      expect(ctx.controller.acknowledge({ requestID, ok: true })).toBe(true)
    } })
    const pending = ctx.controller.prepare()
    expect(reentrant).toBe(pending)
    await pending
    expect(ctx.controller.ready).toBe(true)
    expect(ctx.requests).toEqual(["close-1"])
    expect(ctx.blocked()).toBe(true)
    ctx.controller.cancel()
    expect(ctx.blocked()).toBe(false)
  })

  test("cancellation rejects pending and ignores the cancelled generation during retry", async () => {
    const ctx = fixture()
    const pending = ctx.controller.prepare()
    const failure = new Error("native close cancelled")
    ctx.controller.cancel(failure)
    await expect(pending).rejects.toBe(failure)
    expect(ctx.blocked()).toBe(false)
    expect(ctx.restorations()).toBe(1)
    const next = ctx.controller.prepare()
    expect(next).not.toBe(pending)
    expect(ctx.requests).toEqual(["close-1", "close-2"])
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: false })).toBe(false)
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(true)
    expect(ctx.controller.acknowledge({ requestID: "close-2", ok: true })).toBe(true)
    await next
    ctx.controller.cancel()
    expect(ctx.restorations()).toBe(2)
    expect(ctx.blocked()).toBe(false)
  })

  test("a successful but cancelled close requires a fresh generation", async () => {
    const ctx = fixture()
    const first = ctx.controller.prepare()
    ctx.controller.acknowledge({ requestID: "close-1", ok: true })
    await first
    ctx.controller.cancel()
    const next = ctx.controller.prepare()
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    expect(ctx.controller.acknowledge({ requestID: "close-2", ok: true })).toBe(true)
    await next
    ctx.controller.cancel()
    expect(ctx.restorations()).toBe(2)
  })

  test.each([false, true])("failure restores the original input state (originally blocked: %s)", async (initiallyBlocked) => {
    const ctx = fixture({ initiallyBlocked })
    const pending = ctx.controller.prepare()
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: false, error: "storage write rejected" })).toBe(true)
    await expect(pending).rejects.toThrow("storage write rejected")
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(initiallyBlocked)
    expect(ctx.restorations()).toBe(1)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    const next = ctx.controller.prepare()
    ctx.controller.acknowledge({ requestID: "close-2", ok: true })
    await next
    ctx.controller.cancel()
    expect(ctx.blocked()).toBe(initiallyBlocked)
    expect(ctx.restorations()).toBe(2)
  })

  test("failure without a message rejects rather than declaring readiness", async () => {
    const ctx = fixture()
    const pending = ctx.controller.prepare()
    ctx.controller.acknowledge({ requestID: "close-1", ok: false })
    await expect(pending).rejects.toThrow("Close preparation failed")
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(false)
  })

  test("timeout restores input, invalidates late acknowledgement and permits a new request", async () => {
    const ctx = fixture({ timeoutMs: 5 })
    const pending = ctx.controller.prepare()
    await expect(pending).rejects.toThrow("Close preparation timed out")
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(false)
    expect(ctx.restorations()).toBe(1)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    const next = ctx.controller.prepare()
    expect(ctx.requests).toEqual(["close-1", "close-2"])
    ctx.controller.acknowledge({ requestID: "close-2", ok: true })
    await next
    ctx.controller.cancel()
    expect(ctx.restorations()).toBe(2)
  })

  test.each([false, true])("a synchronous request throw rejects even after synchronous success acknowledgement: %s", async (acknowledge) => {
    const failure = new Error("request delivery failed")
    let attempts = 0
    const ctx = fixture({ request(requestID) {
      if (++attempts !== 1) return
      if (acknowledge) ctx.controller.acknowledge({ requestID, ok: true })
      throw failure
    } })
    await expect(ctx.controller.prepare()).rejects.toBe(failure)
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(false)
    expect(ctx.restorations()).toBe(1)
    expect(ctx.controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    const next = ctx.controller.prepare()
    ctx.controller.acknowledge({ requestID: "close-2", ok: true })
    await next
    ctx.controller.cancel()
  })

  test("resend delivers the same pending token without reblocking or restarting its timer", async () => {
    const schedule = spyOn(globalThis, "setTimeout")
    const ctx = fixture({ request(requestID) {
      if (ctx.requests.length === 2) ctx.controller.acknowledge({ requestID, ok: true })
    } })
    ctx.controller.resend()
    expect(ctx.requests).toEqual([])
    const pending = ctx.controller.prepare()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0]?.[1]).toBe(10_000)
    ctx.controller.resend()
    await pending
    expect(ctx.requests).toEqual(["close-1", "close-1"])
    expect(ctx.blocks()).toBe(1)
    expect(schedule).toHaveBeenCalledTimes(1)
    ctx.controller.resend()
    expect(ctx.requests).toHaveLength(2)
    ctx.controller.cancel()
    expect(ctx.restorations()).toBe(1)
  })

  test("resend delivery failure rejects the pending barrier and restores input", async () => {
    const ctx = fixture({ request() {
      if (ctx.requests.length === 2) throw new Error("preload delivery failed")
    } })
    const pending = ctx.controller.prepare()
    ctx.controller.resend()
    await expect(pending).rejects.toThrow("preload delivery failed")
    expect(ctx.controller.ready).toBe(false)
    expect(ctx.blocked()).toBe(false)
    expect(ctx.restorations()).toBe(1)
  })

  test.each(["success", "failure", "cancel"] as const)("clears the pending timer on %s", async (outcome) => {
    const clear = spyOn(globalThis, "clearTimeout")
    const ctx = fixture()
    const pending = ctx.controller.prepare()
    const settled = pending.catch(() => undefined)
    if (outcome === "cancel") ctx.controller.cancel()
    else ctx.controller.acknowledge({ requestID: "close-1", ok: outcome === "success" })
    await settled
    expect(clear).toHaveBeenCalledTimes(1)
    ctx.controller.cancel()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(ctx.restorations()).toBe(1)
  })

  test("surfaces input restoration failure when a ready native close is cancelled", async () => {
    const failure = new Error("input restorer failed")
    const controller = createClosePreparation({
      createID: () => "close-1",
      request() {},
      blockInput: () => () => { throw failure },
    })
    const pending = controller.prepare()
    controller.acknowledge({ requestID: "close-1", ok: true })
    await pending
    expect(() => controller.cancel()).toThrow(AggregateError)
    expect(controller.ready).toBe(false)
    expect(controller.acknowledge({ requestID: "close-1", ok: true })).toBe(false)
    expect(() => controller.cancel()).not.toThrow()
  })
})
