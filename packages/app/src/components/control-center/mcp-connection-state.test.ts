import { describe, expect, test } from "bun:test"
import {
  buildMcpConnection,
  createMcpConnectionState,
  mcpConnectionDraft,
  type ConfigMcpMap,
  type McpConnectionCallbacks,
  type McpConnectionSource,
  type McpEntry,
} from "./mcp-connection-state"

const local: McpEntry = {
  type: "local",
  command: ["node", "server.js", "", "a b"],
  cwd: "./tools",
  read_only_paths: ["../deps", "C:\\Read Only"],
  environment: { TOKEN: "synthetic-only", EMPTY: "" },
  enabled: false,
  timeout: { startup: 1234, request: 5678 },
}
const remote: McpEntry = {
  type: "remote",
  url: "https://mcp.example.test/mcp",
  headers: { Authorization: "synthetic-only", "X-Empty": "" },
  oauth: {
    clientId: "client",
    clientSecret: "synthetic-only",
    scope: "read write",
    callbackPort: 19876,
    redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
  },
  enabled: true,
  timeout: 9000,
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(callbacks: Partial<McpConnectionCallbacks> = {}) {
  let source: McpConnectionSource = { scope: "source-a/workspace", name: "one", ready: true }
  const writes: { name: string; value: McpEntry }[] = []
  let saved = 0
  const controller = createMcpConnectionState({
    source: () => source,
    callbacks: () => ({
      load: async () => ({ one: local, other: remote }),
      save: async (name, value) => {
        writes.push({ name, value })
      },
      onSaved: () => {
        saved++
      },
      ...callbacks,
    }),
  })
  return {
    controller,
    writes,
    saved: () => saved,
    source: (next: McpConnectionSource) => {
      source = next
    },
  }
}

describe("MCP connection fields", () => {
  test.each(["__proto__", "constructor", "prototype"])(
    "rejects reserved object server name %s before saving",
    (name) => {
      const draft = { ...mcpConnectionDraft(), name, command: '["node"]' }
      expect(buildMcpConnection(draft)).toMatchObject({ ok: false, errors: { name: "name" } })
    },
  )
  test("round-trips all local fields including empty arguments and secret values", () => {
    expect(buildMcpConnection(mcpConnectionDraft("one", local), local, [], "one")).toEqual({
      ok: true,
      name: "one",
      value: local,
    })
  })
  test("round-trips all remote/OAuth fields and keeps an unchanged legacy timeout", () => {
    expect(buildMcpConnection(mcpConnectionDraft("one", remote), remote, [], "one")).toEqual({
      ok: true,
      name: "one",
      value: remote,
    })
  })
  test("preserves unknown root and nested OAuth/timeout fields without changing input objects", () => {
    const original = {
      ...remote,
      extension: { keep: true },
      oauth: { ...(remote.oauth as object), future: "keep" },
      timeout: { startup: 100, future: 900 },
    } as unknown as McpEntry
    const before = structuredClone(original)
    const draft = mcpConnectionDraft("one", original)
    draft.url = "https://new.example.test/mcp"
    const result = buildMcpConnection(draft, original, [], "one")
    expect(result).toMatchObject({
      ok: true,
      value: {
        extension: { keep: true },
        oauth: { future: "keep", clientSecret: "synthetic-only" },
        timeout: { startup: 100, future: 900 },
      },
    })
    expect(original).toEqual(before)
  })
  test("new local form emits only its entry and omits inherited blanks", () => {
    const draft = { ...mcpConnectionDraft(), name: "新服务", command: '["node", "server.js"]' }
    expect(buildMcpConnection(draft)).toEqual({
      ok: true,
      name: "新服务",
      value: { type: "local", command: ["node", "server.js"] },
    })
  })
  test("clearing one phase preserves the other phase and converts only edited numeric timeouts", () => {
    const draft = mcpConnectionDraft("one", remote)
    draft.startup = ""
    expect(buildMcpConnection(draft, remote, [], "one")).toMatchObject({
      ok: true,
      value: { timeout: { request: 9000 } },
    })
    const result = buildMcpConnection(draft, remote, [], "one")
    if (result.ok && "timeout" in result.value && typeof result.value.timeout === "object") {
      expect(result.value.timeout).not.toHaveProperty("startup")
    }
  })
  test.each(["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"])(
    "rejects invalid phase timeout %s",
    (startup) => {
      expect(buildMcpConnection({ ...mcpConnectionDraft("one", local), startup }, local, [], "one")).toMatchObject({
        ok: false,
        errors: { startup: "positive-integer" },
      })
    },
  )
  test.each(["", "{}", '["node", 2]', '[""]', "[]", '["node", "\\u0000"]'])(
    "rejects invalid command JSON %s",
    (command) => {
      expect(buildMcpConnection({ ...mcpConnectionDraft("one", local), command }, local, [], "one")).toMatchObject({
        ok: false,
        errors: { command: "command" },
      })
    },
  )
  test("rejects duplicate row keys and invalid paths without consuming entered text", () => {
    const draft = {
      ...mcpConnectionDraft("one", local),
      readOnlyPaths: '["  "]',
      environment: [
        { key: "A", value: "1" },
        { key: "A", value: "2" },
      ],
    }
    expect(buildMcpConnection(draft, local, [], "one")).toMatchObject({
      ok: false,
      errors: { readOnlyPaths: "paths", environment: "environment" },
    })
    expect(draft.readOnlyPaths).toBe('["  "]')
  })
  test("headers compare keys case-insensitively and reject line injection", () => {
    for (const headers of [
      [
        { key: "Auth", value: "1" },
        { key: "auth", value: "2" },
      ],
      [{ key: "X-Test", value: "one\r\ntwo" }],
    ]) {
      expect(buildMcpConnection({ ...mcpConnectionDraft("one", remote), headers }, remote, [], "one")).toMatchObject({
        ok: false,
        errors: { headers: "headers" },
      })
    }
  })
  test("blank newly added rows are ignored and named empty values are preserved", () => {
    const draft = mcpConnectionDraft("one", local)
    draft.environment.push({ key: "", value: "" })
    expect(buildMcpConnection(draft, local, [], "one")).toMatchObject({
      ok: true,
      value: { environment: { TOKEN: "synthetic-only", EMPTY: "" } },
    })
  })
  test("OAuth disabled, automatic and configured stay distinct", () => {
    const draft = mcpConnectionDraft("one", remote)
    expect(buildMcpConnection({ ...draft, oauth: "disabled" }, remote, [], "one")).toMatchObject({
      ok: true,
      value: { oauth: false },
    })
    const auto = buildMcpConnection({ ...draft, oauth: "auto" }, remote, [], "one")
    expect(auto.ok).toBe(true)
    if (auto.ok) expect(auto.value).not.toHaveProperty("oauth")
    expect(buildMcpConnection(draft, remote, [], "one")).toMatchObject({
      ok: true,
      value: { oauth: { clientSecret: "synthetic-only" } },
    })
  })
  test.each(["0", "65536", "3.5"])("rejects invalid callback port %s", (callbackPort) => {
    expect(buildMcpConnection({ ...mcpConnectionDraft("one", remote), callbackPort }, remote, [], "one")).toMatchObject(
      { ok: false, errors: { callbackPort: "port" } },
    )
  })
  test.each(["file:///tmp/mcp", "https://user:password@example.test/mcp", "broken"])(
    "rejects invalid URL %s",
    (url) => {
      expect(buildMcpConnection({ ...mcpConnectionDraft("one", remote), url }, remote, [], "one")).toMatchObject({
        ok: false,
        errors: { url: "url" },
      })
    },
  )
  test("does not copy secrets across an explicitly changed transport", () => {
    const draft = { ...mcpConnectionDraft("one", remote), type: "local" as const, command: '["node"]' }
    const result = buildMcpConnection(draft, remote, [], "one")
    expect(result.ok).toBe(true)
    if (result.ok) for (const key of ["oauth", "headers", "url"]) expect(result.value).not.toHaveProperty(key)
  })
  test("names stay immutable and a new duplicate cannot overwrite an existing connection", () => {
    const draft = { ...mcpConnectionDraft("one", local), name: "other" }
    expect(buildMcpConnection(draft, local, ["one", "other"], "one")).toMatchObject({ ok: true, name: "one" })
    expect(buildMcpConnection(draft, undefined, ["other"])).toMatchObject({
      ok: false,
      errors: { name: "duplicate-name" },
    })
  })
  test("toggle-only override stays an override and incomplete definitions do not become runnable", () => {
    const original: McpEntry = { enabled: false }
    expect(buildMcpConnection(mcpConnectionDraft("one", original), original, [], "one")).toEqual({
      ok: true,
      name: "one",
      value: original,
    })
    const incomplete = { type: "local", enabled: true } as McpEntry
    expect(buildMcpConnection(mcpConnectionDraft("one", incomplete), incomplete, [], "one")).toMatchObject({
      ok: false,
      errors: { command: "command" },
    })
  })
})

describe("MCP connection source and draft ownership", () => {
  test("existing reserved object names stay visible and immutable but cannot submit", async () => {
    const f = fixture({ load: async () => Object.fromEntries([["__proto__", local]]) })
    f.source({ scope: "a", name: "__proto__", ready: true })
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { cwd: "./attempted", name: "renamed" })
    await f.controller.submit(owner)
    expect(f.controller.state.draft.name).toBe("__proto__")
    expect(f.controller.state.draft.cwd).toBe("./tools")
    expect(f.writes).toHaveLength(0)
  })
  test("loads the full map from the captured callback and saves only the named entry", async () => {
    const f = fixture()
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { cwd: "./new" })
    await f.controller.submit(owner)
    expect(f.writes).toEqual([{ name: "one", value: { ...local, cwd: "./new" } }])
    expect(f.saved()).toBe(1)
  })
  test("invalid input and a failed save keep all draft values", async () => {
    const f = fixture({
      save: async () => {
        throw new Error("synthetic secret must not surface")
      },
    })
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { command: "invalid-json" })
    await f.controller.submit(owner)
    expect(f.controller.state.errors.command).toBe("command")
    expect(f.controller.state.draft.command).toBe("invalid-json")
    f.controller.edit(owner, { command: '["node", "new"]' })
    await f.controller.submit(owner)
    expect(f.controller.state.error).toBe("save")
    expect(f.controller.state.draft.command).toBe('["node", "new"]')
    expect(f.controller.state.draft.environment[0].value).toBe("synthetic-only")
  })
  test("edits made during a save survive completion and suppress a consuming onSaved callback", async () => {
    const saving = deferred<void>()
    const f = fixture({ save: () => saving.promise })
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { cwd: "./submitted" })
    const pending = f.controller.submit(owner)
    f.controller.edit(owner, { cwd: "./newer", environment: [{ key: "NEW", value: "synthetic-new" }] })
    saving.resolve()
    await pending
    expect(f.controller.state.draft.cwd).toBe("./newer")
    expect(f.controller.state.draft.environment).toEqual([{ key: "NEW", value: "synthetic-new" }])
    expect(f.controller.state.notice).toBe("saved-with-edits")
    expect(f.saved()).toBe(0)
  })
  test("A-B-A delayed reads and retired item handlers cannot replace a reclaimed form", async () => {
    const old = deferred<ConfigMcpMap>()
    let calls = 0
    const f = fixture({ load: async () => (++calls === 1 ? old.promise : { one: local, other: remote }) })
    const pending = f.controller.open()
    const retired = f.controller.state.owner
    f.source({ scope: "source-b/workspace", name: "other", ready: true })
    await f.controller.open()
    f.source({ scope: "source-a/workspace", name: "one", ready: true })
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { cwd: "./reclaimed" })
    f.controller.edit(retired, { cwd: "./retired" })
    await f.controller.submit(retired)
    old.resolve({ one: { ...local, cwd: "./late" } })
    await pending
    expect(f.controller.state.draft.cwd).toBe("./reclaimed")
    expect(f.writes).toHaveLength(0)
  })
  test("same-source item A-B-A delayed saves cannot publish success or failure", async () => {
    for (const failure of [false, true]) {
      const saving = deferred<void>()
      const f = fixture({ save: () => saving.promise })
      await f.controller.open()
      const pending = f.controller.submit(f.controller.state.owner)
      f.source({ scope: "source-a/workspace", name: "other", ready: true })
      await f.controller.open()
      f.source({ scope: "source-a/workspace", name: "one", ready: true })
      await f.controller.open()
      f.controller.edit(f.controller.state.owner, { cwd: "./a2" })
      if (failure) saving.reject(new Error("failed"))
      else saving.resolve()
      await pending
      expect(f.controller.state.draft.cwd).toBe("./a2")
      expect(f.controller.state.error).toBe("")
      expect(f.controller.state.notice).toBe("")
      expect(f.saved()).toBe(0)
    }
  })
  test("checks source before effects run and does not save while unready", async () => {
    const f = fixture()
    await f.controller.open()
    const owner = f.controller.state.owner
    f.source({ scope: "source-b/workspace", name: "one", ready: true })
    await f.controller.submit(owner)
    expect(f.writes).toHaveLength(0)
    f.source({ scope: "source-a/workspace", name: "one", ready: false })
    await f.controller.open()
    expect(f.controller.state.loaded).toBe(false)
  })
  test("dispose retires read and save completion and releases form secrets", async () => {
    const saving = deferred<void>()
    const f = fixture({ save: () => saving.promise })
    await f.controller.open()
    const pending = f.controller.submit(f.controller.state.owner)
    f.controller.dispose()
    saving.resolve()
    await pending
    expect(f.controller.state.draft.environment).toEqual([])
    expect(f.controller.state.notice).toBe("")
    expect(f.saved()).toBe(0)
    const reading = deferred<ConfigMcpMap>()
    const r = fixture({ load: () => reading.promise })
    const loading = r.controller.open()
    r.controller.dispose()
    reading.resolve({ one: local })
    await loading
    expect(r.controller.state.loaded).toBe(false)
  })
  test("new connection locks its saved name without replacing edits during the first save", async () => {
    const saving = deferred<void>()
    const f = fixture({ save: () => saving.promise })
    f.source({ scope: "a", ready: true })
    await f.controller.open()
    const owner = f.controller.state.owner
    f.controller.edit(owner, { name: "new", command: '["node"]' })
    const pending = f.controller.submit(owner)
    f.controller.edit(owner, { command: '["node", "newer"]' })
    saving.resolve()
    await pending
    expect(f.controller.state.lockedName).toBe("new")
    expect(f.controller.state.draft.command).toBe('["node", "newer"]')
  })
  test("missing named configuration is not silently created; a load failure can be retried", async () => {
    let calls = 0
    const f = fixture({
      load: async () => {
        if (++calls === 1) throw new Error("offline")
        return {}
      },
    })
    await f.controller.open()
    expect(f.controller.state.error).toBe("load")
    await f.controller.open()
    expect(f.controller.state.entryState).toBe("missing")
    await f.controller.submit(f.controller.state.owner)
    expect(f.writes).toHaveLength(0)
  })
})
