import { describe, expect, test } from "bun:test"
import { createDirectoryAccess } from "./directory-access"
import { createRequestLifetime } from "./request-lifetime"
import { ClientError } from "@arforge-ai/client"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("server-owned directory availability", () => {
  test("a transient wrapped read recovers before caching directory availability", async () => {
    let calls = 0
    const access = createDirectoryAccess(async (directory) => {
      calls++
      if (calls === 1) throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })
      return { directory }
    })
    const pending = access.check("C:/owned/project")
    expect(access.check("C:\\owned\\project")).toBe(pending)
    await pending
    expect(calls).toBe(2)
    expect(access.get("C:/owned/project")?.status).toBe("ready")
  })

  test("a forbidden read is not replayed and remains explicitly retryable", async () => {
    let calls = 0
    const access = createDirectoryAccess(async () => {
      calls++
      throw { _tag: "ForbiddenError", status: 403 }
    })
    await access.check("C:/owned/project")
    expect(calls).toBe(1)
    expect(access.get("C:/owned/project")?.status).toBe("unavailable")
    await access.check("C:/owned/project", { force: true })
    expect(calls).toBe(2)
  })

  test("retirement while a transient read is pending prevents retry and publication", async () => {
    const read = deferred<{ directory: string }>()
    let calls = 0
    const access = createDirectoryAccess(() => {
      calls++
      return read.promise
    })
    const pending = access.check("C:/owned/project")
    await Promise.resolve()
    access.dispose()
    read.reject(new ClientError("Transport", { cause: new TypeError("Failed to fetch") }))
    await pending
    expect(calls).toBe(1)
    expect(access.get("C:/owned/project")?.status).toBe("checking")
  })

  test("deduplicates normalized paths and accepts only the exact directory response", async () => {
    const read = deferred<{ directory: string }>()
    let calls = 0
    const access = createDirectoryAccess(() => {
      calls++
      return read.promise
    })
    const first = access.check("C:\\owned\\project\\")
    expect(access.check("C:/owned/project")).toBe(first)
    expect(access.get("C:/owned/project")?.status).toBe("checking")
    read.resolve({ directory: "C:/owned/project" })
    await first
    expect(calls).toBe(1)
    expect(access.get("C:/owned/project")?.status).toBe("ready")
    const wrong = createDirectoryAccess(async () => ({ directory: "C:/other" }))
    await wrong.check("C:/owned/project")
    expect(wrong.get("C:/owned/project")?.status).toBe("unavailable")
  })

  test("keeps failed sources unavailable until an explicit retry succeeds", async () => {
    let exists = false,
      calls = 0
    const access = createDirectoryAccess(async (directory) => {
      calls++
      if (!exists) throw new Error("ENOENT owned fixture")
      return { directory }
    })
    await access.check("C:/missing")
    expect(access.get("C:/missing")?.status).toBe("unavailable")
    exists = true
    await access.check("C:/missing")
    expect(calls).toBe(1)
    await access.check("C:/missing", { force: true })
    expect(access.get("C:/missing")?.status).toBe("ready")
  })

  test("never shares the same path between servers and ignores disposed responses", async () => {
    const read = deferred<{ directory: string }>()
    const a = createDirectoryAccess(() => read.promise)
    const b = createDirectoryAccess(async () => {
      throw new Error("other server unavailable")
    })
    const pending = a.check("C:/same")
    await b.check("C:/same")
    a.dispose()
    read.resolve({ directory: "C:/same" })
    await pending
    expect(a.get("C:/same")?.status).toBe("checking")
    expect(b.get("C:/same")?.status).toBe("unavailable")
  })

  test("a restored page retries independently of its stale pending read", async () => {
    const target = new EventTarget(),
      old = deferred<{ directory: string }>(),
      current = deferred<{ directory: string }>()
    const lifetime = createRequestLifetime(target)
    let calls = 0
    const access = createDirectoryAccess(() => (++calls === 1 ? old.promise : current.promise), lifetime.capture)
    const first = access.check("C:/restored")
    await Promise.resolve()
    target.dispatchEvent(new Event("pagehide"))
    target.dispatchEvent(new Event("pageshow"))
    const retry = access.check("C:/restored", { force: true })
    expect(retry).not.toBe(first)
    current.resolve({ directory: "C:/restored" })
    await retry
    old.reject(new Error("stale error"))
    await first
    expect(calls).toBe(2)
    expect(access.get("C:/restored")?.status).toBe("ready")
    lifetime.dispose()
  })
})
