import { createSimpleContext } from "@arforge-ai/ui/context"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { hasCustomAgent, resolveAgent } from "./local-agent"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { resolveModelChoice, ModelChoiceError } from "@/components/dialog-select-model-state"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const settings = useSettings()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const agentsVisible = createMemo(() => settings.visibility.customAgents() || hasCustomAgent(list()))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const selectionTarget = createMemo(
      () => ({ scope: serverSDK().scope, directory: sdk().directory }),
      undefined,
      { equals: (previous, next) => previous.scope === next.scope && previous.directory === next.directory },
    )
    const selectionPersistence = createMemo(() => {
      const target = selectionTarget()
      // Keep the memo's owner so scope changes dispose its resources, but never
      // subscribe construction to the store snapshot or ready resource it creates.
      return untrack(() => persisted(
        {
          ...Persist.serverWorkspace(target.scope, target.directory, "model-selection", ["model-selection.v1"]),
          migrate,
        },
        createStore<Saved>({ session: {} }),
      ))
    })
    const saved = () => selectionPersistence()[0]
    const saveSession = (session: string, state: State | undefined) =>
      untrack(() => selectionPersistence()[1]("session", session, state))
    const savedReady = Object.defineProperty(() => selectionPersistence()[3](), "promise", {
      get: () => selectionPersistence()[3].promise,
    }) as (() => boolean) & { readonly promise: Promise<unknown> | undefined }

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const pickAgent = (name: string | undefined) => {
      return resolveAgent(list(), name)
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved().session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved().session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      saveSession(session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const configuredModel = () => {
      const configured = sync().data.config.model
      if (!configured) return
      const separator = configured.indexOf("/")
      if (separator < 1) return
      return { providerID: configured.slice(0, separator), modelID: configured.slice(separator + 1) }
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const value = providers.default()
      const explicit = value as Record<string, string | undefined>
      if (explicit.providerID && explicit.modelID) {
        const model = { providerID: explicit.providerID, modelID: explicit.modelID }
        if (validModel(model)) return model
      }
      for (const [providerID, modelID] of Object.entries(value)) {
        if (!modelID || providerID === "providerID" || providerID === "modelID") continue
        const model = { providerID, modelID }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      visible: agentsVisible,
      current() {
        return pickAgent(agentsVisible() ? (scope()?.agent ?? store.current) : "build")
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            saveSession(session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const selectedModelKey = () => scope()?.model ?? agent.current()?.model ?? fallback()
    const selectionScope = () => ScopedKey.from(serverSDK().scope, sdk().directory, id() ?? "__draft__")
    const current = () => resolveModelChoice(selectedModelKey(), validModel, models.find)

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        saveSession(session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        batch(() => {
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: selected(),
            })
            write({ model: item })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
              write({ variant: value ?? null })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
              }
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      // Local selection is a next-submit binding. It never edits an in-flight
      // request, durable queue entry, or the configured new-session default.
      modelSelection: {
        key: selectedModelKey,
        scope: selectionScope,
        ready: savedReady,
        unavailable() {
          const key = selectedModelKey()
          if (!key) return
          const provider = providers.all().get(key.providerID)
          if (!provider) return "provider" as const
          if (!connected().has(key.providerID)) return "disconnected" as const
          if (!provider.models[key.modelID]) return "removed" as const
        },
        select(item: ModelKey, expectedScope: string) {
          if (selectionScope() !== expectedScope) throw new ModelChoiceError("scope-changed")
          if (!savedReady() || !models.ready() || !validModel(item)) throw new ModelChoiceError("unavailable")
          model.set(item, { recent: false })
        },
      },
      session: {
        ready: savedReady,
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string, state?: State) {
          const next = clone(state ?? snapshot())
          if (!next) return
          const key = handoffKey(serverSDK().scope, dir, session)
          handoff.set(key, next)

          if (dir === sdk().directory) {
            saveSession(session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved().session[session] !== undefined) return
          if (handoff.has(handoffKey(serverSDK().scope, sdk().directory, session))) return

          saveSession(session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})

export type ModelSelection = ReturnType<typeof useLocal>["model"]
