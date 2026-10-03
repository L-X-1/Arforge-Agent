import { describe, expect, test } from "bun:test"
import { confirmModelChoice, groupModelOptions, modelGroupOpen, modelOptionKey, reconcileModelGroupCatalog, resolveModelChoice, restoreModelGroups, searchModelGroups, toggleModelGroup, type ModelChoice, type ModelGroupState } from "./dialog-select-model-state"

const models = [
  { id: "deployment/gpt", name: "Production deployment", provider: { id: "z", name: "Provider Z" } },
  { id: "gpt-5", name: "GPT-5", provider: { id: "z", name: "Provider Z" } },
  { id: "gpt-preview", name: "Preview GPT", provider: { id: "z", name: "Provider Z" } },
  { id: "gpt-5", name: "GPT-5", provider: { id: "a", name: "Provider A" } },
]
const state = (): ModelGroupState => ({ saved: restoreModelGroups(["z", "a"], "z"), query: "", searchOpen: {} })

describe("model group preferences", () => {
  test("opens the current provider when the first catalog arrives asynchronously", () => {
    const pending = restoreModelGroups([], "z")
    expect(pending.initialized).toBe(false)
    const loaded = reconcileModelGroupCatalog(["z", "a"], "z", pending)
    expect(loaded.open).toEqual({ z: true, a: false })
    expect(loaded.initialized).toBe(true)
  })
  test("uses the current provider learned with the first populated catalog", () => {
    const pending = restoreModelGroups([], undefined)
    const stillPending = reconcileModelGroupCatalog([], undefined, pending)
    expect(stillPending.initialized).toBe(false)
    expect(reconcileModelGroupCatalog(["z", "a"], "a", stillPending).open).toEqual({ z: false, a: true })
    expect(reconcileModelGroupCatalog(["z", "a"], undefined, stillPending).open).toEqual({ z: true, a: true })
  })
  test("later refreshes preserve manual folds and established empty records", () => {
    const loaded = reconcileModelGroupCatalog(["z", "a"], "z", restoreModelGroups([], "z"))
    const folded = toggleModelGroup({ saved: loaded, query: "", searchOpen: {} }, "z")
    expect(reconcileModelGroupCatalog(["z", "a"], "z", folded.saved).open).toEqual({ z: false, a: false })
    expect(reconcileModelGroupCatalog(["z", "a"], "z", { open: {}, currentProvider: "z" }).open)
      .toEqual({ z: false, a: false })
  })
  test("first open expands only the identified current group, or all groups when unknown", () => {
    expect(state().saved.open).toEqual({ z: true, a: false })
    expect(restoreModelGroups(["z", "a"], "missing").open).toEqual({ z: true, a: true })
  })
  test("manual groups are independent and reopening preserves the current collapsed group", () => {
    const expanded = toggleModelGroup(state(), "a")
    const collapsed = toggleModelGroup(expanded, "z")
    expect(collapsed.saved.open).toEqual({ z: false, a: true })
    expect(restoreModelGroups(["z", "a"], "z", collapsed.saved).open).toEqual(collapsed.saved.open)
  })
  test("a new current provider opens without collapsing other groups", () => {
    expect(restoreModelGroups(["z", "a"], "a", state().saved).open).toEqual({ z: true, a: true })
  })
  test("prunes removed IDs, starts added groups collapsed, and never uses display names as keys", () => {
    expect(restoreModelGroups(["z", "new"], "z", { open: { z: false, removed: true }, currentProvider: "z" }).open)
      .toEqual({ z: false, new: false })
    expect(modelOptionKey({ id: "b:c", name: "same", provider: { id: "a", name: "same" } }))
      .not.toBe(modelOptionKey({ id: "c", name: "same", provider: { id: "a:b", name: "same" } }))
  })
  test("search expands matches, permits temporary collapse, then restores the snapshot", () => {
    const before = toggleModelGroup(state(), "z")
    const searching = searchModelGroups(before, "gpt", ["z", "a"], ["z", "a"], "z")
    const folded = toggleModelGroup(searching, "a")
    expect(modelGroupOpen(folded, "a")).toBe(false)
    expect(modelGroupOpen(searchModelGroups(folded, " GPT ", ["z", "a"], ["z", "a"], "z"), "a")).toBe(false)
    expect(modelGroupOpen(searchModelGroups(folded, "gpt 5", ["a"], ["z", "a"], "z"), "a")).toBe(true)
    expect(searchModelGroups(folded, "", [], ["z", "a"], "z").saved.open).toEqual(before.saved.open)
  })
  test("clearing search reveals a newly selected provider while preserving the prior snapshot", () => {
    const searching = searchModelGroups(state(), "gpt", ["z", "a"], ["z", "a"], "z")
    expect(searchModelGroups(searching, "", [], ["z", "a"], "a").saved.open).toEqual({ z: true, a: true })
  })
  test("serializable scope records can be restored without storing query text or search-only folds", () => {
    const searching = toggleModelGroup(searchModelGroups(state(), "secret query", ["z"], ["z", "a"], "z"), "z")
    const serialized = JSON.stringify(searching.saved)
    expect(serialized).not.toContain("secret")
    expect(restoreModelGroups(["z", "a"], "z", JSON.parse(serialized))).toEqual(state().saved)
  })
})

describe("configured catalog order", () => {
  test("retains provider and model configuration order without searching", () => {
    const groups = groupModelOptions(models)
    expect(groups.map((group) => group.id)).toEqual(["z", "a"])
    expect(groups[0].items.map((model) => model.id)).toEqual(["deployment/gpt", "gpt-5", "gpt-preview"])
  })
  test("sorts matches within stable provider groups and removes groups with no matches", () => {
    const groups = groupModelOptions(models, "gpt")
    expect(groups.map((group) => group.id)).toEqual(["z", "a"])
    expect(groups[0].items.map((model) => model.id)).toEqual(["gpt-5", "gpt-preview", "deployment/gpt"])
    expect(groupModelOptions(models, "provider a gpt").map((group) => group.id)).toEqual(["a"])
    expect(groupModelOptions(models, "no match")).toEqual([])
  })
})

describe("confirmed model choices", () => {
  const choice: ModelChoice = { providerID: "z", modelID: "gpt-5" }
  test("unavailable explicit choices never fall through to a different model", () => {
    let lookedUp = false
    expect(resolveModelChoice(choice, () => false, () => { lookedUp = true; return "paid fallback" })).toBeUndefined()
    expect(lookedUp).toBe(false)
  })
  test("confirms the requested identity without editing the frozen running or queued bindings", async () => {
    const queued = { providerID: "a", modelID: "original" }
    const running = { ...queued }
    const newSessionDefault = { ...queued }
    let current: ModelChoice = { ...queued }
    await confirmModelChoice({ choice, scope: () => "server/workspace/session", expectedScope: "server/workspace/session",
      available: () => true, write: (value) => { current = value }, current: () => current })
    expect(current).toEqual(choice)
    expect(queued).toEqual({ providerID: "a", modelID: "original" })
    expect(running).toEqual(queued)
    expect(newSessionDefault).toEqual(queued)
  })
  test("rejects stale scope before writing and rejects unavailable catalog entries", async () => {
    let writes = 0
    const input = { choice, scope: () => "other", expectedScope: "original", available: () => true, write: () => { writes++ }, current: () => choice }
    await expect(confirmModelChoice(input)).rejects.toThrow("scope-changed")
    await expect(confirmModelChoice({ ...input, expectedScope: "other", available: () => false })).rejects.toThrow("unavailable")
    expect(writes).toBe(0)
  })
  test("waits for confirmation, rejects late receipts after navigation, and does not claim success on no-op writes", async () => {
    let scope = "original"
    let resolve!: () => void
    const deferred = new Promise<void>((done) => resolve = done)
    const operation = confirmModelChoice({ choice, scope: () => scope, expectedScope: "original", available: () => true,
      write: () => deferred, current: () => choice })
    scope = "new-session"
    resolve()
    await expect(operation).rejects.toThrow("scope-changed")
    await expect(confirmModelChoice({ choice, scope: () => scope, expectedScope: scope, available: () => true,
      write: () => undefined, current: () => undefined })).rejects.toThrow("not-confirmed")
  })
  test("rejected writes preserve the previous choice", async () => {
    const previous = { providerID: "a", modelID: "original" }
    await expect(confirmModelChoice({ choice, scope: () => "session", expectedScope: "session", available: () => true,
      write: () => Promise.reject(new Error("failure")), current: () => previous })).rejects.toThrow("failure")
    expect(previous).toEqual({ providerID: "a", modelID: "original" })
  })
})
