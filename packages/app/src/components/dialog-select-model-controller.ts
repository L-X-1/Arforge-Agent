import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams, useSearchParams } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { useLocal, type ModelSelection } from "@/context/local"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { ScopedKey } from "@/utils/server-scope"
import { confirmBoundModelChoice, type ModelSelectionBinding } from "./dialog-select-model-binding"
import { ModelChoiceError } from "./dialog-select-model-state"

const messages = {
  "en": {
    "retry": "Retry",
    "unavailable": "The selected model is unavailable. Your selection and draft are preserved.",
    "provider": "The selected provider is no longer in this workspace's catalog.",
    "disconnected": "The selected provider is disconnected. Reconnect it to use this model.",
    "removed": "The selected model is no longer in the provider's catalog.",
    "failed": "The model could not be selected. Your previous selection and draft are preserved.",
    "stale": "The model catalog could not be refreshed. The last available catalog is shown.",
    "notConfirmed": "The selection was not confirmed. Retry or configure the provider.",
    "changed": "The session changed. Reopen its model selector to try again."
  },
  "zh": {
    "retry": "\u91cd\u8bd5",
    "unavailable": "\u5f53\u524d\u6a21\u578b\u4e0d\u53ef\u7528\u3002\u5df2\u4fdd\u7559\u539f\u9009\u62e9\u548c\u8349\u7a3f\u3002",
    "provider": "\u5f53\u524d\u670d\u52a1\u5546\u5df2\u4e0d\u5728\u6b64\u5de5\u4f5c\u533a\u7684\u6a21\u578b\u76ee\u5f55\u4e2d\u3002",
    "disconnected": "\u5f53\u524d\u670d\u52a1\u5546\u672a\u8fde\u63a5\u3002\u8bf7\u91cd\u65b0\u8fde\u63a5\u540e\u4f7f\u7528\u6b64\u6a21\u578b\u3002",
    "removed": "\u5f53\u524d\u6a21\u578b\u5df2\u4e0d\u5728\u670d\u52a1\u5546\u76ee\u5f55\u4e2d\u3002",
    "failed": "\u6a21\u578b\u9009\u62e9\u5931\u8d25\u3002\u5df2\u4fdd\u7559\u539f\u9009\u62e9\u548c\u8349\u7a3f\u3002",
    "stale": "\u6a21\u578b\u76ee\u5f55\u5237\u65b0\u5931\u8d25\uff0c\u5f53\u524d\u663e\u793a\u6700\u540e\u4e00\u6b21\u53ef\u7528\u7684\u76ee\u5f55\u3002",
    "notConfirmed": "\u6a21\u578b\u9009\u62e9\u5c1a\u672a\u786e\u8ba4\u3002\u8bf7\u91cd\u8bd5\u6216\u914d\u7f6e\u670d\u52a1\u5546\u3002",
    "changed": "\u4f1a\u8bdd\u5df2\u5207\u6362\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u5f53\u524d\u4f1a\u8bdd\u7684\u6a21\u578b\u9009\u62e9\u5668\u3002"
  }
}

/** Shared dialog entrypoint contract. The popover uses the same confirmation primitive. */
export function createModelDialogSelection(props: {
  model?: ModelSelection
  binding?: ModelSelectionBinding
  onSelect(): void
}) {
  const local = useLocal()
  const language = useLanguage()
  const sdk = useSDK()
  const params = useParams()
  const [route] = useSearchParams<{ draftId?: string }>()
  const queryClient = useQueryClient()
  const model = () => props.model ?? local.model
  const binding = () => props.binding ?? (model() === local.model ? local.modelSelection : undefined)
  const copy = () => language.intl().startsWith("zh") ? messages.zh : messages.en
  const scope = () => binding()?.scope() ?? ScopedKey.from(sdk().scope, sdk().directory, params.id ?? route.draftId ?? "__draft__")
  const opened = { scope: scope(), model: model(), binding: binding() }
  const [state, setState] = createStore({
    selecting: false, refreshing: false, stale: false, error: "", catalogLoading: false, catalogError: false,
  })
  let mounted = true
  let version = 0
  const sameScope = () => scope() === opened.scope && model() === opened.model && binding() === opened.binding
  const active = () => mounted && !state.stale && sameScope()
  const ready = () => !state.stale && model().ready() && (!binding() || binding()!.ready()) && !state.catalogLoading
  const busy = () => state.selecting || state.refreshing
  const catalogKey = () => [sdk().scope, sdk().directory, "providers"]
  const currentChoice = () => {
    const selected = binding()
    if (selected) return selected.key()
    const current = model().current()
    return current ? { providerID: current.provider.id, modelID: current.id } : undefined
  }
  const currentKey = createMemo(() => {
    const current = currentChoice()
    return current ? `${current.providerID}:${current.modelID}` : undefined
  })
  const unavailable = () => binding()?.unavailable()

  createEffect(() => {
    if (sameScope()) return
    version++
    // A dialog opened for an old scope must not become writable after navigating back.
    setState({ stale: true, selecting: false, refreshing: false, error: copy().changed })
  })
  createEffect(() => {
    const key = catalogKey()
    const update = () => {
      if (!active()) return
      const query = queryClient.getQueryState(key)
      setState({ catalogError: query?.status === "error", catalogLoading: !!query && !query.data && query.status === "pending" })
    }
    update()
    onCleanup(queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === key[0] && event.query.queryKey[1] === key[1] && event.query.queryKey[2] === key[2]) update()
    }))
  })
  onCleanup(() => { mounted = false; version++ })

  const select = async (item: ReturnType<ModelSelection["list"]>[number]) => {
    if (!active() || !ready() || busy()) return
    const attempt = ++version
    const current = () => active() && attempt === version
    setState({ selecting: true, error: "" })
    try {
      await confirmBoundModelChoice({
        choice: { providerID: item.provider.id, modelID: item.id },
        model: opened.model, binding: opened.binding, scope, expectedScope: opened.scope, active: current,
      })
      if (current()) props.onSelect()
    } catch (error) {
      if (!current()) return
      setState("error", error instanceof ModelChoiceError
        ? error.reason === "unavailable" ? copy().unavailable : error.reason === "scope-changed" ? copy().changed : copy().notConfirmed
        : copy().failed)
    } finally {
      if (current()) setState("selecting", false)
    }
  }

  const refresh = async () => {
    if (!active() || busy()) return
    const attempt = ++version
    const key = catalogKey()
    const current = () => active() && attempt === version
    setState({ refreshing: true, error: "" })
    try {
      if (!queryClient.getQueryState(key)) throw new ModelChoiceError("unavailable")
      await queryClient.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true })
    } catch {
      if (current()) setState("error", copy().stale)
    } finally {
      if (current()) setState("refreshing", false)
    }
  }

  return { model, binding, scope, active, ready, busy, state, currentChoice, currentKey, unavailable, copy, select, refresh }
}
