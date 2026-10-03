import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { DirectorySDK } from "./sdk"
import { ServerScope } from "@/utils/server-scope"

let getWorkspaceTerminalCacheKey: typeof import("./terminal").getWorkspaceTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let createWorkspaceTerminalSession: typeof import("./terminal").createWorkspaceTerminalSession
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!() })

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@arforge-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const persistence = await import("@/utils/persist")
  mock.module("@/utils/persist", () => ({
    ...persistence,
    persisted: (_target: unknown, store: readonly [unknown, unknown]) => [store[0], store[1], undefined, () => true],
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  createWorkspaceTerminalSession = mod.createWorkspaceTerminalSession
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo"))).toBe("local\u0000/repo\u0000__workspace__")
  })

  test("can include a server scope", () => {
    expect(String(getWorkspaceTerminalCacheKey("/repo", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000__workspace__",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })
})


type CreatedPTY = { data?: { id?: string; title?: string } }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function terminalHarness(options: {
  create?: () => Promise<CreatedPTY>
  update?: () => Promise<unknown>
  remove?: () => Promise<unknown>
  scope?: ServerScope
} = {}) {
  let counter = 0
  let exited: ((event: { properties: { id: string } }) => void) | undefined
  const calls = {
    create: mock(options.create ?? (async () => ({ data: { id: `pty-${++counter}` } }))),
    update: mock(options.update ?? (async () => ({ data: {} }))),
    remove: mock(options.remove ?? (async () => ({ data: true }))),
  }
  const sdk = {
    directory: "/repo",
    protocol: Promise.resolve("v2"),
    api: { pty: calls },
    client: { pty: calls },
    event: { on: (_name: string, callback: typeof exited) => { exited = callback; return () => { exited = undefined } } },
  } as unknown as DirectorySDK
  const terminal = createRoot((dispose) => {
    disposers.push(dispose)
    return createWorkspaceTerminalSession(sdk, "/repo", options.scope ?? ServerScope.local)
  })
  return { terminal, calls, exited: (id: string) => exited?.({ properties: { id } }) }
}

describe("workspace terminal operation feedback", () => {
  test("creation failure clears busy state and exposes a safe, dismissible receipt", async () => {
    const { terminal } = terminalHarness({ create: async () => { throw new Error("private transport detail") } })
    await terminal.new({ focus: true })
    expect(terminal.all()).toEqual([])
    expect(terminal.pending("create")).toBe(false)
    expect(terminal.operationError()?.operation).toBe("create")
    expect(JSON.stringify(terminal.operationError())).not.toContain("private transport detail")
    terminal.dismissOperationError()
    expect(terminal.operationError()).toBeUndefined()
  })

  test("missing identifiers are not silently reported as successful creation", async () => {
    const { terminal } = terminalHarness({ create: async () => ({ data: {} }) })
    await terminal.new()
    expect(terminal.operationError()?.operation).toBe("create")
    expect(terminal.all()).toEqual([])
  })

  test("duplicate creation clicks share the pending operation", async () => {
    const pending = deferred<CreatedPTY>()
    const { terminal, calls } = terminalHarness({ create: () => pending.promise })
    const first = terminal.new()
    const second = terminal.new()
    await Promise.resolve()
    expect(terminal.pending("create")).toBe(true)
    expect(calls.create).toHaveBeenCalledTimes(1)
    pending.resolve({ data: { id: "one" } })
    await first
    await second
    expect(terminal.pending("create")).toBe(false)
    expect(terminal.all().map((item) => item.id)).toEqual(["one"])
  })

  test("failed close retains the active tab and its contents", async () => {
    const { terminal } = terminalHarness({ remove: async () => { throw new Error("close unavailable") } })
    await terminal.new()
    await terminal.update({ id: "pty-1", buffer: "retained output" })
    await terminal.close("pty-1")
    expect(terminal.active()).toBe("pty-1")
    expect(terminal.all()[0]?.buffer).toBe("retained output")
    expect(terminal.operationError()?.operation).toBe("close")
    expect(terminal.pending("close", "pty-1")).toBe(false)
  })

  test("close removes the tab only after acknowledgement and suppresses duplicate requests", async () => {
    const pending = deferred<unknown>()
    const { terminal, calls } = terminalHarness({ remove: () => pending.promise })
    await terminal.new()
    await terminal.new()
    const first = terminal.close("pty-2")
    const second = terminal.close("pty-2")
    await Promise.resolve()
    expect(terminal.all()).toHaveLength(2)
    expect(terminal.pending("close", "pty-2")).toBe(true)
    expect(calls.remove).toHaveBeenCalledTimes(1)
    pending.resolve({ data: true })
    await first
    await second
    expect(terminal.all().map((item) => item.id)).toEqual(["pty-1"])
    expect(terminal.active()).toBe("pty-1")
  })

  test("a confirmed exit event prevents a late close rejection from claiming failure", async () => {
    const pending = deferred<unknown>()
    const { terminal, exited } = terminalHarness({ remove: () => pending.promise })
    await terminal.new()
    const closing = terminal.close("pty-1")
    await Promise.resolve()
    exited("pty-1")
    pending.reject(new Error("already exited"))
    await closing
    expect(terminal.all()).toEqual([])
    expect(terminal.operationError()).toBeUndefined()
  })

  test("an older failed update cannot overwrite a later successful edit", async () => {
    const firstReply = deferred<unknown>()
    const secondReply = deferred<unknown>()
    let request = 0
    const { terminal } = terminalHarness({ update: () => ++request === 1 ? firstReply.promise : secondReply.promise })
    await terminal.new()
    const first = terminal.update({ id: "pty-1", title: "first" })
    const second = terminal.update({ id: "pty-1", title: "second" })
    await Promise.resolve()
    secondReply.resolve({ data: {} })
    await second
    firstReply.reject(new Error("old write failed"))
    await first
    expect(terminal.all()[0]?.title).toBe("second")
    expect(terminal.operationError()).toBeUndefined()
    expect(terminal.pending("update", "pty-1")).toBe(false)
  })

  test("cloning rechecks the source index after a tab reorder", async () => {
    const pending = deferred<CreatedPTY>()
    let create = 0
    const { terminal } = terminalHarness({ create: async () => ++create <= 2
      ? { data: { id: `pty-${create}` } } : pending.promise })
    await terminal.new()
    await terminal.new()
    const cloning = terminal.clone("pty-1")
    terminal.move("pty-1", 1)
    pending.resolve({ data: { id: "replacement" } })
    await cloning
    expect(terminal.all().map((item) => item.id)).toEqual(["pty-2", "replacement"])
    expect(terminal.active()).toBe("pty-2")
  })

  test("late errors remain attached to their original workspace binding", async () => {
    const pending = deferred<unknown>()
    const first = terminalHarness({ scope: "server:first" as ServerScope, remove: () => pending.promise })
    const second = terminalHarness({ scope: "server:second" as ServerScope })
    await first.terminal.new()
    await second.terminal.new()
    const closing = first.terminal.close("pty-1")
    pending.reject(new Error("first server offline"))
    await closing
    expect(first.terminal.operationError()?.operation).toBe("close")
    expect(second.terminal.operationError()).toBeUndefined()
    expect(second.calls.remove).toHaveBeenCalledTimes(0)
    expect(second.terminal.all()).toHaveLength(1)
  })
})
