import { batch, createMemo } from "solid-js"
import type { ModelKey, ModelSelection } from "@/context/local"
import type { useModels } from "@/context/models"
import type { usePrompt } from "@/context/prompt"
import type { useProviders } from "@/hooks/use-providers"
import type { ModelSelectionBinding } from "@/components/dialog-select-model"
import { ModelChoiceError, sameModelChoice } from "@/components/dialog-select-model-state"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "@/context/model-variant"

export function createPromptModelState(input: {
  agent: () => { model?: ModelKey; variant?: string } | undefined
  models: ReturnType<typeof useModels>
  prompt: Pick<ReturnType<typeof usePrompt>, "capture" | "ready">
  providers: Pick<ReturnType<typeof useProviders>, "all" | "connected" | "default">
  configured: () => string | undefined
  scope: () => { server: string; directory: string }
}) {
  const { models, prompt, providers } = input
  const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))
  const targets = new WeakMap<object, number>()
  let nextTarget = 0
  const scope = () => {
    const target = prompt.capture()
    let id = targets.get(target)
    if (id === undefined) targets.set(target, (id = ++nextTarget))
    const location = input.scope()
    return JSON.stringify([location.server, location.directory, id])
  }
  const ready = Object.defineProperty(() => models.ready() && prompt.ready(), "promise", {
    get: () => Promise.all([models.ready.promise, prompt.ready.promise]),
  }) as ModelSelection["ready"]
  const unavailableKey = (key: ModelKey) => {
    const provider = providers.all().get(key.providerID)
    if (!provider) return "provider" as const
    if (!connected().has(key.providerID)) return "disconnected" as const
    if (!provider.models[key.modelID]) return "removed" as const
  }
  const valid = (key: ModelKey) => unavailableKey(key) === undefined
  const configured = () => {
    const value = input.configured()
    if (!value) return
    const separator = value.indexOf("/")
    if (separator < 1) return
    const key = { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
    if (valid(key)) return key
  }
  const defaultModel = () => {
    const value = providers.default()
    const explicit = value as Record<string, string | undefined>
    if (explicit.providerID && explicit.modelID) {
      const key = { providerID: explicit.providerID, modelID: explicit.modelID }
      if (valid(key)) return key
    }
    for (const [providerID, modelID] of Object.entries(value)) {
      if (!modelID || providerID === "providerID" || providerID === "modelID") continue
      const key = { providerID, modelID }
      if (valid(key)) return key
    }
  }
  const key = () => {
    // Use the captured store rather than the suspense resource, which can still
    // expose the previous draft's value while a different draft is hydrating.
    const explicit = prompt.capture().model.current()
    if (explicit) return { providerID: explicit.providerID, modelID: explicit.modelID }
    return [input.agent()?.model, configured(), models.recent.list().find(valid), defaultModel()].find(
      (item): item is ModelKey => !!item && valid(item),
    )
  }
  const current = () => {
    if (!ready()) return
    const selected = key()
    return selected && valid(selected) ? models.find(selected) : undefined
  }
  const recentModels = createMemo(() =>
    models.recent.list().filter(valid).map(models.find).filter((item): item is NonNullable<typeof item> => !!item),
  )
  const capture = () => ({
    target: prompt.capture(),
    scope: scope(),
    // Capture both hydration promises before yielding, not the active draft later.
    ready: ready.promise,
  })
  const assertScope = (owner: ReturnType<typeof capture>) => {
    if (scope() !== owner.scope || prompt.capture() !== owner.target) throw new ModelChoiceError("scope-changed")
  }

  const selection = {
    ready,
    current,
    recent: recentModels,
    list: models.list,
    cycle(direction: 1 | -1) {
      const items = recentModels()
      const item = current()
      if (!item) return
      const index = items.findIndex((entry) => entry.provider.id === item.provider.id && entry.id === item.id)
      if (index === -1) return
      const next = items[(index + direction + items.length) % items.length]
      if (next) return selection.set({ providerID: next.provider.id, modelID: next.id })
    },
    async set(item: ModelKey | undefined, options?: { recent?: boolean }) {
      const owner = capture()
      const next = item ? { providerID: item.providerID, modelID: item.modelID } : undefined
      const recent = options?.recent
      await owner.ready
      assertScope(owner)
      if (!ready() || (next && !valid(next))) throw new ModelChoiceError("unavailable")
      batch(() => {
        owner.target.model.set(next ? { ...next, variant: owner.target.model.current()?.variant } : undefined)
        if (!next) return
        models.setVisibility(next, true)
        if (recent) models.recent.push(next)
      })
    },
    visible: models.visible,
    setVisibility: models.setVisibility,
    variant: {
      configured() {
        const item = input.agent()
        const model = current()
        if (!item || !model) return
        return getConfiguredAgentVariant({
          agent: { model: item.model, variant: item.variant },
          model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
        })
      },
      selected() {
        return prompt.capture().model.current()?.variant
      },
      current() {
        const resolved = resolveModelVariant({
          variants: this.list(), selected: this.selected(), configured: this.configured(),
        })
        if (resolved) return resolved
        const model = current()
        if (!model) return
        const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
        if (saved && this.list().includes(saved)) return saved
      },
      list() {
        return Object.keys(current()?.variants ?? {})
      },
      async set(value: string | undefined) {
        const owner = capture()
        const model = current()
        if (!model) return
        const selected = { providerID: model.provider.id, modelID: model.id }
        await owner.ready
        assertScope(owner)
        if (!ready() || !valid(selected)) throw new ModelChoiceError("unavailable")
        if (!sameModelChoice(key(), selected)) throw new ModelChoiceError("not-confirmed")
        batch(() => {
          owner.target.model.set({ ...selected, variant: value ?? null })
          models.variant.set(selected, value)
        })
      },
      cycle() {
        const variants = this.list()
        if (variants.length === 0) return
        return this.set(cycleModelVariant({ variants, selected: this.selected(), configured: this.configured() }))
      },
    },
  } satisfies ModelSelection

  const binding: ModelSelectionBinding = {
    key,
    scope,
    ready,
    unavailable() {
      const selected = key()
      return selected ? unavailableKey(selected) : undefined
    },
    async select(item, expectedScope) {
      if (scope() !== expectedScope) throw new ModelChoiceError("scope-changed")
      await selection.set(item, { recent: false })
    },
  }
  return Object.assign(selection, { binding })
}
