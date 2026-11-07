import { createSimpleContext } from "@arforge-ai/ui/context"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { hasCustomAgent, resolveAgent, resolveAgentSelection } from "./local-agent"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  queuedVariantRestore,
  resolveModelVariant,
} from "./model-variant"
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
  variantBinding?: { kind: "default" | "prompt" | "queue"; model: ModelKey }
}

const sameModel = (left: ModelKey | undefined, right: ModelKey | undefined) =>
  !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID

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
    variantBinding: value.variantBinding
      ? { ...value.variantBinding, model: { ...value.variantBinding.model } }
      : undefined,
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

    const selectionTarget = createMemo(() => ({ scope: serverSDK().scope, directory: sdk().directory }), undefined, {
      equals: (previous, next) => previous.scope === next.scope && previous.directory === next.directory,
    })
    const selectionPersistence = createMemo(() => {
      const target = selectionTarget()
      // Keep the memo's owner so scope changes dispose its resources, but never
      // subscribe construction to the store snapshot or ready resource it creates.
      return untrack(() =>
        persisted(
          {
            ...Persist.serverWorkspace(target.scope, target.directory, "model-selection", ["model-selection.v1"]),
            migrate,
          },
          createStore<Saved>({ session: {} }),
        ),
      )
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

    const agentSelection = createMemo(() =>
      resolveAgentSelection(list(), {
        selected: scope()?.agent,
        fallback: agentsVisible() ? store.current : "build",
      }),
    )

    const agent = {
      list,
      visible: agentsVisible,
      selected: () => agentSelection().selected,
      unavailable: () => agentSelection().unavailable,
      current() {
        return agentSelection().current
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        const selected = item?.name ?? name
        if (selected === undefined) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", selected)
          setStore("last", {
            type: "agent",
            agent: selected,
            model: item?.model,
            variant: item?.variant ?? null,
          })
          const prev = scope()
          const nextModel = item?.model ?? prev?.model
          const binding =
            item?.variant === undefined && sameModel(prev?.variantBinding?.model, nextModel ?? fallback())
              ? prev?.variantBinding
              : undefined
          const next = {
            agent: selected,
            model: nextModel,
            variant: item?.variant ?? (prev?.variantBinding && !binding ? undefined : prev?.variant),
            variantBinding: binding,
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

    const variantBinding = () => {
      const binding = scope()?.variantBinding
      return sameModel(binding?.model, selectedModelKey()) ? binding : undefined
    }
    const selected = () => {
      const state = scope()
      return state?.variantBinding && !variantBinding() ? undefined : state?.variant
    }

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
        variantBinding: variantBinding(),
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
      set(item: ModelKey | undefined, options?: { recent?: boolean; restoring?: boolean }) {
        batch(() => {
          setStore("last", {
            type: "model",
            agent: agent.current()?.name,
            model: item ?? null,
            variant: selected(),
          })
          const bound = scope()?.variantBinding
          write(
            bound && !sameModel(bound.model, item)
              ? { model: item, variant: undefined, variantBinding: undefined }
              : { model: item },
          )
          if (!item || options?.restoring) return
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
          const choice = this.selected()
          if (choice === null && variantBinding()) return undefined
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: choice,
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
        set(value: string | undefined, options?: { restoring?: boolean }) {
          startTransition(() =>
            batch(() => {
              const model = current()
              const key = model ? { providerID: model.provider.id, modelID: model.id } : null
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: key,
                variant: value ?? null,
              })
              write({
                variant: value ?? null,
                variantBinding:
                  key && (options?.restoring || value === undefined)
                    ? { kind: options?.restoring ? "prompt" : "default", model: key }
                    : undefined,
              })
              if (model && !options?.restoring) {
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

    const queueVariant = (queued: ModelKey) => {
      return queuedVariantRestore({
        queued,
        current: selectedModelKey(),
        currentVariant: model.variant.current(),
        supported: model.variant.list(),
        explicit: variantBinding()?.kind === "default" && selected() === null,
      })
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
        queueVariant,
        restoreQueueVariant(queued: ModelKey | undefined) {
          if (!id() || !savedReady()) return
          // A previous editor's automatic restoration is not a new user choice.
          if (scope()?.variantBinding?.kind === "queue") write({ variant: undefined, variantBinding: undefined })
          if (!queued?.variant) return
          const result = queueVariant(queued)
          if (result.status !== "restore") return
          // Queue restoration belongs to this Session. It must not remember a
          // new global per-model preset or change other/new Session defaults.
          const model = { providerID: queued.providerID, modelID: queued.modelID }
          write({ model, variant: result.variant, variantBinding: { kind: "queue", model } })
        },
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
