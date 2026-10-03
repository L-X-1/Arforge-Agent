import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPromptModelState } from "./prompt-model-state"

type Key = { providerID: string; modelID: string; variant?: string | null }
const primary = { providerID: "provider", modelID: "primary" }
const fallback = { providerID: "provider", modelID: "fallback" }

function fixture() {
  const writes: Array<{ target: object; model: Key | undefined }> = []
  const visibility: Key[] = []
  const recent: Key[] = []
  const variants: Array<{ key: Key; value: string | undefined }> = []
  const target = (initial?: Key) => {
    const [current, setCurrent] = createSignal(initial)
    const value = {
      draft: "unchanged draft", cursor: 5,
      model: { current, set: (model: Key | undefined) => {
        writes.push({ target: value, model })
        setCurrent(model)
      } },
    }
    return value
  }
  const first = target()
  const [active, setActive] = createSignal(first)
  const [location, setLocation] = createSignal({ server: "server-a", directory: "/workspace-a" })
  const [hydrated, setHydrated] = createSignal(true)
  let hydration: Promise<unknown> | undefined
  const ready = Object.defineProperty(hydrated, "promise", { get: () => hydration })
  const [connected, setConnected] = createSignal(["provider"])
  const entries = ["primary", "fallback", "family/model"].map((id) => ({
    id, name: id, provider: { id: "provider", name: "Provider" }, variants: { low: {}, high: {} },
  }))
  const [catalog, setCatalog] = createSignal(new Map([["provider", {
    id: "provider", models: Object.fromEntries(entries.map((item) => [item.id, item])),
  }]]))
  const [configured, setConfigured] = createSignal<string | undefined>()
  const [agent, setAgent] = createSignal<{ model: Key; variant?: string } | undefined>()
  const dependencies = {
    agent, configured, scope: location,
    prompt: { ready, capture: active },
    providers: {
      all: catalog,
      connected: () => connected().map((id) => ({ id })),
      default: () => ({ provider: "fallback" }),
    },
    models: {
      ready: Object.assign(() => true, { promise: Promise.resolve() }),
      find: (key: Key) => entries.find((item) => item.id === key.modelID && item.provider.id === key.providerID),
      list: () => entries,
      visible: () => true,
      setVisibility: (key: Key) => { visibility.push(key) },
      recent: { list: () => recent, push: (key: Key) => { recent.push(key) } },
      variant: { get: () => undefined, set: (key: Key, value: string | undefined) => { variants.push({ key, value }) } },
    },
  }
  const model = createPromptModelState(dependencies as unknown as Parameters<typeof createPromptModelState>[0])
  const gate = (isReady = false) => {
    let release!: () => void
    hydration = new Promise<void>((resolve) => { release = resolve })
    setHydrated(isReady)
    return () => { setHydrated(true); release() }
  }
  return { model, first, active, target, setActive, location, setLocation, setConnected, setCatalog,
    setConfigured, setAgent, writes, visibility, recent, variants, gate }
}

async function withState(run: (state: ReturnType<typeof fixture>) => void | Promise<void>) {
  let dispose!: () => void
  const state = createRoot((cleanup) => { dispose = cleanup; return fixture() })
  try { await run(state) } finally { dispose() }
}

describe("draft model selection", () => {
  test("uses defaults only when no explicit choice exists", () => withState(async (state) => {
    expect(state.model.current()?.id).toBe("fallback")
    state.setAgent({ model: primary })
    expect(state.model.current()?.id).toBe("primary")
    await state.model.set(fallback)
    expect(state.model.current()?.id).toBe("fallback")
    await state.model.set(undefined)
    expect(state.model.current()?.id).toBe("primary")
  }))

  for (const reason of ["provider", "disconnected", "removed"] as const) {
    test("retains explicit key and draft when " + reason, () => withState((state) => {
      const selected = reason === "provider"
        ? { providerID: "missing-provider", modelID: "primary" }
        : reason === "removed" ? { providerID: "provider", modelID: "removed-model" } : primary
      state.first.model.set(selected)
      if (reason === "disconnected") state.setConnected([])
      expect(state.model.binding.key()).toEqual(selected)
      expect(state.model.binding.unavailable()).toBe(reason)
      expect(state.model.current()).toBeUndefined()
      expect(state.first.draft).toBe("unchanged draft")
      expect(state.first.cursor).toBe(5)
    }))
  }

  test("recovers the same explicit choice when its provider reconnects", () => withState((state) => {
    state.first.model.set(primary)
    state.setConnected([])
    expect(state.model.current()).toBeUndefined()
    state.setConnected(["provider"])
    expect(state.model.current()?.id).toBe("primary")
    expect(state.model.binding.unavailable()).toBeUndefined()
  }))

  test("preserves slash-containing model IDs in configured defaults", () => withState((state) => {
    state.setConfigured("provider/family/model")
    expect(state.model.current()?.id).toBe("family/model")
  }))

  test("does not expose fallback while draft hydration is pending", () => withState(async (state) => {
    const release = state.gate()
    expect(state.model.ready()).toBe(false)
    expect(state.model.current()).toBeUndefined()
    state.first.model.set({ providerID: "missing", modelID: "old" })
    release()
    await state.model.ready.promise
    expect(state.model.current()).toBeUndefined()
    expect(state.model.binding.key()).toEqual({ providerID: "missing", modelID: "old" })
  }))

  test("setter resolves only after hydration, model, visibility and recent writes", () => withState(async (state) => {
    const release = state.gate()
    let complete = false
    const pending = state.model.set(primary, { recent: true }).then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    expect(state.writes).toHaveLength(0)
    state.first.model.set({ ...fallback, variant: "high" })
    release()
    await pending
    expect(complete).toBe(true)
    expect(state.first.model.current()).toEqual({ ...primary, variant: "high" })
    expect(state.visibility).toEqual([primary])
    expect(state.recent).toEqual([primary])
  }))

  test("does not write either draft after switching targets during hydration", () => withState(async (state) => {
    const release = state.gate()
    const pending = state.model.set(primary)
    const other = state.target(fallback)
    state.setActive(other)
    release()
    await expect(pending).rejects.toMatchObject({ reason: "scope-changed" })
    expect(state.first.model.current()).toBeUndefined()
    expect(other.model.current()).toEqual(fallback)
    expect(state.writes).toHaveLength(0)
    expect(state.visibility).toHaveLength(0)
  }))

  for (const change of [{ server: "server-b", directory: "/workspace-a" }, { server: "server-a", directory: "/workspace-b" }]) {
    test("rejects a retargeted draft in " + JSON.stringify(change), () => withState(async (state) => {
      const release = state.gate()
      const pending = state.model.set(primary)
      state.setLocation(change)
      release()
      await expect(pending).rejects.toMatchObject({ reason: "scope-changed" })
      expect(state.writes).toHaveLength(0)
    }))
  }

  test("binding rejects an old picker scope without writing", () => withState(async (state) => {
    const expectedScope = state.model.binding.scope()
    state.setActive(state.target())
    await expect(state.model.binding.select(primary, expectedScope)).rejects.toMatchObject({ reason: "scope-changed" })
    expect(state.writes).toHaveLength(0)
  }))

  test("revalidates provider availability before committing", () => withState(async (state) => {
    const release = state.gate()
    const pending = state.model.set(primary)
    state.setConnected([])
    release()
    await expect(pending).rejects.toMatchObject({ reason: "unavailable" })
    expect(state.writes).toHaveLength(0)
    expect(state.visibility).toHaveLength(0)
  }))

  test("variant setter returns completion and retains explicit default semantics", () => withState(async (state) => {
    await state.model.set(primary)
    await state.model.variant.set("high")
    expect(state.first.model.current()).toEqual({ ...primary, variant: "high" })
    await state.model.variant.set(undefined)
    expect(state.first.model.current()).toEqual({ ...primary, variant: null })
    expect(state.variants).toEqual([{ key: primary, value: "high" }, { key: primary, value: undefined }])
  }))

  test("variant write cannot follow the user into another draft", () => withState(async (state) => {
    await state.model.set(primary)
    state.writes.length = 0
    const release = state.gate(true)
    const pending = state.model.variant.set("high")
    const other = state.target(fallback)
    state.setActive(other)
    release()
    await expect(pending).rejects.toMatchObject({ reason: "scope-changed" })
    expect(state.writes).toHaveLength(0)
    expect(state.variants).toHaveLength(0)
    expect(other.model.current()).toEqual(fallback)
  }))
})
