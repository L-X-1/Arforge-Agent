import { expect, test } from "bun:test"
import { createRequestLifetime } from "./request-lifetime"

test("active requests retain their results and genuine failures", async () => {
  const page = new EventTarget()
  const lifetime = createRequestLifetime(page)
  const current = lifetime.capture()
  const failure = new Error("Transport")
  const failures: unknown[] = []
  try {
    await Promise.reject(failure).catch((error) => {
      if (current()) failures.push(error)
    })
    expect(lifetime.active()).toBe(true)
    expect(current()).toBe(true)
    expect(failures).toEqual([failure])
  } finally {
    lifetime.dispose()
  }
})

test("pagehide invalidates results and errors from the departing page", async () => {
  const page = new EventTarget()
  const lifetime = createRequestLifetime(page)
  const current = lifetime.capture()
  const settled: string[] = []
  try {
    const result = Promise.resolve().then(() => {
      if (current()) settled.push("result")
    })
    const failure = Promise.reject(new Error("Transport")).catch(() => {
      if (current()) settled.push("error")
    })
    page.dispatchEvent(new Event("pagehide"))
    await Promise.all([result, failure])
    expect(lifetime.active()).toBe(false)
    expect(current()).toBe(false)
    expect(settled).toEqual([])
  } finally {
    lifetime.dispose()
  }
})

test("page restoration starts a new lifetime without reviving old requests", () => {
  const page = new EventTarget()
  let resumed = 0
  const lifetime = createRequestLifetime(page, () => resumed++)
  const previous = lifetime.capture()
  try {
    page.dispatchEvent(new Event("pageshow"))
    expect(resumed).toBe(0)
    page.dispatchEvent(new Event("pagehide"))
    page.dispatchEvent(new Event("pageshow"))
    page.dispatchEvent(new Event("pageshow"))
    expect(resumed).toBe(1)
    expect(lifetime.active()).toBe(true)
    expect(previous()).toBe(false)
    expect(lifetime.capture()()).toBe(true)
  } finally {
    lifetime.dispose()
  }
})

test("owner disposal is final and detaches page lifecycle listeners", () => {
  const page = new EventTarget()
  let resumed = 0
  const lifetime = createRequestLifetime(page, () => resumed++)
  const current = lifetime.capture()
  lifetime.dispose()
  lifetime.dispose()
  page.dispatchEvent(new Event("pagehide"))
  page.dispatchEvent(new Event("pageshow"))
  expect(resumed).toBe(0)
  expect(lifetime.active()).toBe(false)
  expect(current()).toBe(false)
})

test("non-browser owners still invalidate requests on cleanup", () => {
  const lifetime = createRequestLifetime()
  const current = lifetime.capture()
  expect(current()).toBe(true)
  lifetime.dispose()
  expect(current()).toBe(false)
})
