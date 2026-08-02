import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import { useLanguage } from "@/context/language"
import { useSessionOperationsText } from "./session-operations-text"
import { useSessionOperationsAuxText } from "./session-operations-aux-text"

type QueueItem = Awaited<ReturnType<OperationsApi["sessions"]["promptQueueList"]>>[number]

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function SessionPromptQueueControl(props: { sessionID: string }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const c = useSessionOperationsText()
  const aux = useSessionOperationsAuxText()
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    error: "",
    notice: "",
    items: [] as QueueItem[],
    editingItem: undefined as QueueItem | undefined,
    editingText: "",
  })
  const api = () => serverSDK().operationsApi.sessions
  const refresh = async () => {
    setState({ loading: true, error: "" })
    try {
      setState("items", [...(await api().promptQueueList({ sessionID: props.sessionID }))])
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("loading", false)
    }
  }
  const cancelEdit = () => setState({ editingItem: undefined, editingText: "" })
  const edit = (item: QueueItem) => setState({ editingItem: item, editingText: item.prompt.text })
  const saveEdit = async () => {
    const item = state.editingItem
    const text = state.editingText.trim()
    if (!item || !text) return
    setState({ saving: true, error: "", notice: "" })
    try {
      const updated = await api().promptQueueUpdate({
        sessionID: props.sessionID,
        messageID: item.id,
        expectedAdmittedSeq: item.admittedSeq,
        prompt: { ...item.prompt, text },
      })
      setState("items", (items) => items.map((candidate) => (candidate.id === updated.id ? updated : candidate)))
      cancelEdit()
      setState("notice", "Queued prompt updated without changing FIFO position.")
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("saving", false)
    }
  }
  const remove = async (item: QueueItem) => {
    if (!window.confirm(`Remove queued prompt “${item.prompt.text.slice(0, 80)}”?`)) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await api().promptQueueRemove({
        sessionID: props.sessionID,
        messageID: item.id,
        expectedAdmittedSeq: item.admittedSeq,
      })
      setState("items", (items) => items.filter((candidate) => candidate.id !== item.id))
      setState("notice", "Queued prompt removed.")
    } catch (error) {
      setState("error", message(error))
    } finally {
      setState("saving", false)
    }
  }

  onMount(() => void refresh())

  return (
    <section
      id="session-followup-queue"
      class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
      aria-labelledby="session-followup-queue-title"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="session-followup-queue-title" class="text-14-medium text-text-strong">
            {c().promptQueue}
          </h2>
          <p class="mt-1 text-12-regular text-text-weak">{c().queueDescription}</p>
        </div>
        <Button size="small" variant="ghost" disabled={state.loading || state.saving} onClick={() => void refresh()}>
          {language.t("controlCenter.m020")}
        </Button>
      </div>
      <Show when={state.error}>
        <div role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-warning p-3 text-11-regular text-text-warning">
          <span>{state.error}</span>
          <Button type="button" size="small" variant="ghost" disabled={state.loading || state.saving} onClick={() => void refresh()}>
            {language.t("controlCenter.m020")}
          </Button>
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" aria-live="polite" class="rounded-md border border-border-weak-base p-3 text-11-regular text-text-weak">
          {state.notice}
        </div>
      </Show>
      <Show when={state.editingItem}>
        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <TextField
            label={c().promptQueue}
            multiline
            value={state.editingText}
            onChange={(value) => setState("editingText", value)}
            disabled={state.saving}
          />
          <div class="flex flex-wrap gap-2">
            <Button type="button" size="small" variant="secondary" disabled={state.saving || !state.editingText.trim()} onClick={() => void saveEdit()}>
              {language.t("common.save")}
            </Button>
            <Button type="button" size="small" variant="ghost" disabled={state.saving} onClick={cancelEdit}>
              {language.t("common.cancel")}
            </Button>
          </div>
        </div>
      </Show>
      <For each={state.items}>
        {(item, index) => (
          <article class="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-weak-base p-3">
            <div class="min-w-0 flex-1">
              <div class="text-10-regular text-text-weak">
                #{index() + 1} · {aux().admittedSequence} {item.admittedSeq} · {item.delivery}
              </div>
              <p class="mt-1 whitespace-pre-wrap break-words text-12-regular text-text-strong">{item.prompt.text}</p>
            </div>
            <div class="flex gap-2">
              <Button size="small" variant="ghost" disabled={state.saving || !!state.editingItem} onClick={() => edit(item)}>
                {language.t("common.edit")}
              </Button>
              <Button size="small" variant="ghost" disabled={state.saving} onClick={() => void remove(item)}>
                {language.t("common.delete")}…
              </Button>
            </div>
          </article>
        )}
      </For>
      <Show when={!state.loading && state.items.length === 0}>
        <p class="text-12-regular text-text-weak">{aux().noQueuedPrompts}</p>
      </Show>
    </section>
  )
}
