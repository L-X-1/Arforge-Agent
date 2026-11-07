import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { FileContent } from "@arforge-ai/sdk/v2"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
type Read = ReturnType<typeof deferred<{ data: FileContent }>>
let sdk: () => unknown
const notices: { description?: string }[] = []
// Supply only the surrounding services; execute FileProvider's actual init,
// real Solid stores/effects, path helpers, tree and async file-load callbacks.
mock.module("@arforge-ai/ui/context", () => ({
  createSimpleContext: (config: { init(): unknown }) => ({ use: config.init, provider: () => undefined }),
}))
mock.module("./sdk", () => ({ useSDK: () => sdk }))
mock.module("./sync", () => ({ useSync: () => ({}) }))
mock.module("./server-sdk", () => ({ useServerSDK: () => () => ({ scope: "owned-server" }) }))
mock.module("@solidjs/router", () => ({ useParams: () => ({ id: "ses_owned" }) }))
mock.module("./language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("./layout", () => ({ useLayout: () => ({ tabs: () => ({ all: () => [] }) }) }))
mock.module("@/utils/toast", () => ({ showToast: (notice: { description?: string }) => notices.push(notice) }))
mock.module("./file/view-cache", () => ({
  createFileViewCache: () => ({ load: () => ({ ready: () => true }), clear() {} }),
}))
const { useFile } = await import("./file")

const content = (text: string): FileContent => ({ type: "text", content: text })
const disposers: (() => void)[] = []
function fixture() {
  const requests: Read[] = []
  return createRoot((dispose) => {
    disposers.push(dispose)
    const [scope, setScope] = createStore({ directory: "/owned/A" })
    sdk = () => ({
      directory: scope.directory,
      client: {
        file: {
          read: () => {
            const request = deferred<{ data: FileContent }>()
            requests.push(request)
            return request.promise
          },
          list: async () => ({ data: [] }),
        },
      },
      event: { listen: () => () => undefined },
    })
    const file = useFile()
    return { file, requests, dispose, source: (directory: string) => setScope("directory", directory) }
  })
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  notices.length = 0
})

describe("file content request ownership", () => {
  test("a disposed workspace cannot publish its delayed read error", async () => {
    const f = fixture()
    const pending = f.file.load("note.txt")
    f.dispose()
    f.requests[0].reject(new Error("retired file read"))
    await pending
    expect(notices).toEqual([])
  })

  test("a disposed workspace cannot install delayed file bytes", async () => {
    const f = fixture()
    const pending = f.file.load("note.txt")
    f.dispose()
    f.requests[0].resolve({ data: content("retired bytes") })
    await pending
    expect(f.file.get("note.txt")?.content).toBeUndefined()
  })

  test("an A-B-A return preserves current bytes and request deduplication", async () => {
    const f = fixture()
    const first = f.file.load("note.txt")
    f.source("/owned/B")
    await Promise.resolve()
    f.source("/owned/A")
    await Promise.resolve()
    const current = f.file.load("note.txt")
    expect(f.requests).toHaveLength(2)
    f.requests[0].resolve({ data: content("retired bytes") })
    await first
    expect(f.file.get("note.txt")?.loaded).not.toBe(true)
    expect(f.file.load("note.txt")).toBe(current)
    expect(f.requests).toHaveLength(2)
    f.requests[1].resolve({ data: content("current bytes") })
    await current
    expect(f.file.get("note.txt")?.content).toEqual(content("current bytes"))
    expect(notices).toEqual([])
  })

  test("a live read failure remains visible and an explicit retry succeeds", async () => {
    const f = fixture()
    const first = f.file.load("note.txt")
    expect(f.file.load("note.txt")).toBe(first)
    f.requests[0].reject(new Error("live file read"))
    await first
    expect(notices).toMatchObject([{ description: "live file read" }])
    expect(f.file.get("note.txt")?.error).toBe("live file read")
    const retry = f.file.load("note.txt", { force: true })
    f.requests[1].resolve({ data: content("recovered bytes") })
    await retry
    expect(f.file.get("note.txt")).toMatchObject({ loaded: true, loading: false, content: content("recovered bytes") })
    expect(f.file.get("note.txt")?.error).toBeUndefined()
  })
})
