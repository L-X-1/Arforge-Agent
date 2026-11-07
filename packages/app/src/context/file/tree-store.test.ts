import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { FileNode } from "@arforge-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const node = (path: string): FileNode => ({
  path,
  absolute: `/owned/${path}`,
  name: path,
  type: "file",
  ignored: false,
})

function fixture() {
  const requests: ReturnType<typeof deferred<FileNode[]>>[] = []
  const errors: string[] = []
  let directory = "A"
  const value = createRoot((dispose) => ({
    dispose,
    tree: createFileTreeStore({
      scope: () => directory,
      normalizeDir: (input) => input,
      list() {
        const request = deferred<FileNode[]>()
        requests.push(request)
        return request.promise
      },
      onError: (message) => errors.push(message),
    }),
  }))
  return {
    ...value,
    requests,
    errors,
    source: (next: string) => {
      directory = next
    },
  }
}

describe("file tree request ownership", () => {
  test("a closed workspace cannot publish a delayed directory error", async () => {
    const f = fixture()
    const pending = f.tree.listDir("")
    f.dispose()
    f.requests[0].reject(new Error("retired workspace read failure"))
    await pending
    expect(f.errors).toEqual([])
    expect(f.tree.isLoaded("")).toBe(false)
  })

  test("returning to the same directory cannot accept a retired pre-reset listing", async () => {
    const f = fixture()
    try {
      const first = f.tree.listDir("")
      f.source("B")
      f.tree.reset()
      f.source("A")
      f.tree.reset()
      const current = f.tree.listDir("")
      f.requests[1].resolve([node("current.txt")])
      await current
      f.requests[0].resolve([node("retired.txt")])
      await first
      expect(f.tree.children("").map((file) => file.path)).toEqual(["current.txt"])
      expect(f.tree.node("retired.txt")).toBeUndefined()
      expect(f.errors).toEqual([])
    } finally {
      f.dispose()
    }
  })

  test("an old completion cannot remove a current request from deduplication", async () => {
    const f = fixture()
    try {
      const first = f.tree.listDir("")
      f.tree.reset()
      const current = f.tree.listDir("")
      f.requests[0].reject(new Error("old"))
      await first
      const joined = f.tree.listDir("")
      expect(joined).toBe(current)
      expect(f.requests).toHaveLength(2)
      expect(f.errors).toEqual([])
      f.requests[1].resolve([node("new.txt")])
      await current
      expect(f.tree.children("").map((file) => file.path)).toEqual(["new.txt"])
    } finally {
      f.dispose()
    }
  })

  test("a current failure remains visible and retry still loads the directory", async () => {
    const f = fixture()
    try {
      const first = f.tree.listDir("")
      expect(f.tree.listDir("")).toBe(first)
      f.requests[0].reject(new Error("current error"))
      await first
      expect(f.errors).toEqual(["current error"])
      expect(f.tree.dirState("")?.error).toBe("current error")
      const retry = f.tree.listDir("", { force: true })
      f.requests[1].resolve([node("recovered.txt")])
      await retry
      expect(f.tree.children("").map((file) => file.path)).toEqual(["recovered.txt"])
      expect(f.tree.dirState("")?.error).toBeUndefined()
    } finally {
      f.dispose()
    }
  })
})
