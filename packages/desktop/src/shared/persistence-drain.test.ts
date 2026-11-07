import { describe, expect, test } from "bun:test"
import { createPersistenceDrain } from "./persistence-drain"

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("persistence close drain", () => {
  test("retains an owner through every admitted batch, including a later write", async () => {
    const drain = createPersistenceDrain(),
      first = deferred(),
      second = deferred()
    drain.track("draft", first.promise)
    let closed = false
    const close = drain.flush().then(() => {
      closed = true
    })
    drain.track("settings", second.promise)
    first.resolve()
    await Bun.sleep(0)
    expect(closed).toBe(false)
    second.resolve()
    await close
    expect(closed).toBe(true)
  })

  test("does not mistake a swallowed scheduling rejection or unrelated success for saved state", async () => {
    const drain = createPersistenceDrain(),
      gate = deferred()
    const original = drain.track("draft", gate.promise)
    const caller = original.catch(() => undefined)
    gate.reject(new Error("write denied"))
    await caller
    await drain.track("settings", Promise.resolve())
    await expect(drain.flush()).rejects.toThrow("write denied")
    await drain.track("draft", Promise.resolve())
    await drain.flush()
  })

  test("an older failed acknowledgement cannot invalidate a newer successful write to the same key", async () => {
    const drain = createPersistenceDrain(),
      old = deferred()
    const caller = drain.track("draft", old.promise).catch(() => undefined)
    await drain.track("draft", Promise.resolve())
    old.reject(new Error("old write failure"))
    await caller
    await drain.flush()
  })

  test("namespace clear supersedes only preceding writes in that namespace", async () => {
    const drain = createPersistenceDrain(),
      old = deferred()
    const caller = drain.track("a:draft", old.promise).catch(() => undefined)
    await drain.track("b:draft", Promise.reject(new Error("other namespace"))).catch(() => undefined)
    await drain.track("a:clear", Promise.resolve(), { clearsPrefix: "a:" })
    old.reject(new Error("superseded old failure"))
    await caller
    await expect(drain.flush()).rejects.toThrow("other namespace")
    await drain.track("b:draft", Promise.resolve())
    await drain.track("a:new", Promise.reject(new Error("new failure"))).catch(() => undefined)
    await expect(drain.flush()).rejects.toThrow("new failure")
  })

  test("flush observes the original mutation once without replaying it", async () => {
    const drain = createPersistenceDrain()
    let writes = 0
    const operation = (async () => {
      writes++
      throw new Error("not saved")
    })()
    expect(drain.track("draft", operation)).toBe(operation)
    await operation.catch(() => undefined)
    await expect(drain.flush()).rejects.toThrow("not saved")
    await expect(drain.flush()).rejects.toThrow("not saved")
    expect(writes).toBe(1)
  })
})
