import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@arforge-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { officialDeepSeekFlash } from "@arforge-ai/core/deepseek-flash"
import type { CatalogProvider } from "@arforge-ai/session-ui/context"

export type ModelKey = { providerID: string; modelID: string }

export function providerModelID(provider: CatalogProvider, modelID: string) {
  if (provider.id !== "deepseek" || Object.hasOwn(provider.models, modelID)) return modelID
  const canonical = provider.models["deepseek-flash"]
  if (
    canonical && canonical.enabled !== false &&
    canonical.id !== modelID &&
    canonical.api.id === canonical.id &&
    officialDeepSeekFlash(provider.id, modelID, canonical.api.url) === canonical.id
  )
    return canonical.id
  return modelID
}

export function providerModel(provider: CatalogProvider, modelID: string) {
  const selected = provider.models[providerModelID(provider, modelID)]
  return selected?.enabled !== false ? selected : undefined
}

function listedModel(provider: CatalogProvider, model: CatalogProvider["models"][string]) {
  if (model.enabled === false || model.listed === false) return false
  const canonical = provider.models["deepseek-flash"]
  return (
    !canonical || canonical.enabled === false || canonical.id === model.id ||
    model.api.id !== model.id || model.api.npm !== canonical.api.npm ||
    officialDeepSeekFlash(provider.id, model.id, canonical.api.url) !== canonical.id ||
    !officialDeepSeekFlash(provider.id, model.id, model.api.url)
  )
}

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(props.directory)

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models)
          .filter((m) => listedModel(p, m))
          .map((m) => ({ ...m, provider: p })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const display = <T extends { name: string }>(m: T) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })
    const list = createMemo(() => available().map(display))

    const find = (key: ModelKey) => {
      const provider = providers.all().get(key.providerID)
      const model = provider && providerModel(provider, key.modelID)
      if (!provider || !model || !providers.connected().some((item) => item.id === provider.id)) return
      return list().find((item) => item.id === model.id && item.provider.id === provider.id) ?? display({ ...model, provider })
    }

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
