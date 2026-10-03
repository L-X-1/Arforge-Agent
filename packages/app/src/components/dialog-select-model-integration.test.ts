import { describe, expect, test } from "bun:test"
import { confirmBoundModelChoice, type ModelSelectionBinding } from "./dialog-select-model-binding"
import { reconcileModelCatalog } from "./dialog-select-model-catalog"
import { modelGroupOpen, restoreModelGroups, searchModelGroups, toggleModelGroup, type ModelChoice, type ModelGroupState } from "./dialog-select-model-state"

const alpha = { providerID: "p", modelID: "alpha" }
const beta = { providerID: "p", modelID: "beta" }

describe("model search catalog reconciliation", () => {
  test("expands matching providers arriving after search without losing the query", () => {
    const pending: ModelGroupState = { saved: restoreModelGroups([], "p"), query: "", searchOpen: {} }
    const searching = searchModelGroups(pending, "gpt", [], [], "p")
    const loaded = reconcileModelCatalog(searching, ["p", "q"], ["p"], "p")
    expect(loaded.query).toBe("gpt")
    expect(modelGroupOpen(loaded, "p")).toBe(true)
    expect(modelGroupOpen(loaded, "q")).toBe(false)
    expect(loaded.saved.open).toEqual({ p: true, q: false })
  })

  test("preserves manual search folds and restores the pre-search folds", () => {
    const initial: ModelGroupState = { saved: restoreModelGroups(["p", "q"], "p"), query: "", searchOpen: {} }
    const searching = searchModelGroups(initial, "gpt", ["p"], ["p", "q"], "p")
    const folded = toggleModelGroup(searching, "p")
    const refreshed = reconcileModelCatalog(folded, ["p", "q"], ["p", "q"], "p")
    expect(modelGroupOpen(refreshed, "p")).toBe(false)
    expect(modelGroupOpen(refreshed, "q")).toBe(true)
    const cleared = searchModelGroups(refreshed, "", [], ["p", "q"], "p")
    expect(modelGroupOpen(cleared, "p")).toBe(true)
    expect(modelGroupOpen(cleared, "q")).toBe(false)
  })

  test("repeated catalogs are semantically idempotent", () => {
    const initial: ModelGroupState = { saved: restoreModelGroups([], undefined), query: "gpt", searchOpen: {} }
    const loaded = reconcileModelCatalog(initial, ["p"], ["p"], "p")
    expect(reconcileModelCatalog(loaded, ["p"], ["p"], "p")).toEqual(loaded)
  })
})

function fixture() {
  let scope = "server/workspace/draft-1"
  let current: ModelChoice = alpha
  let ready = true
  let writes = 0
  let reads = 0
  let legacyOptions: { recent: boolean } | undefined
  const model = {
    ready: () => true,
    list: () => [alpha, beta].map((choice) => ({ id: choice.modelID, provider: { id: choice.providerID } })),
    current: () => { reads++; return { id: "legacy-fallback", provider: { id: "other" } } },
    set: (choice: ModelChoice, options: { recent: boolean }) => { writes++; current = choice; legacyOptions = options },
  }
  const binding: ModelSelectionBinding = {
    key: () => current,
    scope: () => scope,
    ready: () => ready,
    unavailable: () => undefined,
    select: (choice, expectedScope) => {
      if (scope !== expectedScope) throw new Error("stale write")
      current = choice
    },
  }
  return {
    model, binding, scope: () => scope, current: () => current, writes: () => writes, reads: () => reads,
    legacyOptions: () => legacyOptions,
    changeScope: () => scope = "server/workspace/draft-2",
    notReady: () => ready = false,
  }
}

describe("optional independent model binding", () => {
  test("uses the explicit key and commit rather than a legacy fallback", async () => {
    const f = fixture()
    await confirmBoundModelChoice({ choice: beta, model: f.model, binding: f.binding, scope: f.scope, expectedScope: f.scope(), active: () => true })
    expect(f.current()).toEqual(beta)
    expect(f.writes()).toBe(0)
    expect(f.reads()).toBe(0)
  })

  test("does not fall back to the legacy setter while binding hydration is pending", async () => {
    const f = fixture()
    f.notReady()
    await expect(confirmBoundModelChoice({ choice: beta, model: f.model, binding: f.binding, scope: f.scope, expectedScope: f.scope(), active: () => true }))
      .rejects.toMatchObject({ reason: "unavailable" })
    expect(f.current()).toEqual(alpha)
    expect(f.writes()).toBe(0)
  })

  test("rejects a late receipt after a scope change", async () => {
    const f = fixture()
    let finish!: () => void
    const binding = { ...f.binding, select: () => new Promise<void>((resolve) => finish = resolve) }
    const pending = confirmBoundModelChoice({ choice: beta, model: f.model, binding, scope: f.scope, expectedScope: f.scope(), active: () => true })
    f.changeScope()
    finish()
    await expect(pending).rejects.toMatchObject({ reason: "scope-changed" })
    expect(f.writes()).toBe(0)
    expect(f.current()).toEqual(alpha)
  })

  test("rejects a late receipt from a closed opening even when the scope is unchanged", async () => {
    const f = fixture()
    let active = true
    let finish!: () => void
    const binding = { ...f.binding, select: () => new Promise<void>((resolve) => finish = resolve) }
    const pending = confirmBoundModelChoice({ choice: beta, model: f.model, binding, scope: f.scope, expectedScope: f.scope(), active: () => active })
    active = false
    finish()
    await expect(pending).rejects.toMatchObject({ reason: "scope-changed" })
    expect(f.writes()).toBe(0)
  })

  test("retains legacy model callers without changing recent/default preferences", async () => {
    const f = fixture()
    const model = { ...f.model, current: () => ({ id: f.current().modelID, provider: { id: f.current().providerID } }) }
    await confirmBoundModelChoice({ choice: beta, model, scope: f.scope, expectedScope: f.scope(), active: () => true })
    expect(f.writes()).toBe(1)
    expect(f.current()).toEqual(beta)
    expect(f.legacyOptions()).toEqual({ recent: false })
  })
})
