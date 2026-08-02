import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { SelectV2 } from "@arforge-ai/ui/v2/select-v2"
import { TextareaV2 } from "@arforge-ai/ui/v2/textarea-v2"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { useSessionOperationsText } from "./session-operations-text"

export function SessionFeedbackControl(props: { api: () => OperationsApi; sessionID: string }) {
  const language = useLanguage()
  const c = useSessionOperationsText()
  const [state, setState] = createStore({
    category: "experience" as "bug" | "feature" | "experience" | "other",
    rating: 5,
    message: "",
    saving: false,
    error: "",
    notice: "",
  })
  const submit = async () => {
    if (state.saving || !state.message.trim()) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await props.api().feedback.submit({
        category: state.category,
        rating: state.rating,
        message: state.message.trim(),
        sessionID: props.sessionID,
      })
      setState({ message: "", notice: language.t("common.save") })
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("saving", false)
    }
  }
  return (
    <section
      class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
      aria-labelledby="operations-feedback-title"
      data-testid="session-feedback-control"
    >
      <h2 id="operations-feedback-title" class="text-14-medium text-text-strong">
        {c().feedbackTitle}
      </h2>
      <p class="text-12-regular text-text-weak">{c().feedbackDescription}</p>
      <div class="grid gap-3 md:grid-cols-[180px_140px_1fr]">
        <label class="text-11-regular text-text-weak">
          {c().category}
          <SelectV2
            class="mt-1"
            appearance="large"
            options={["bug", "feature", "experience", "other"] as const}
            current={state.category}
            onSelect={(value) => value && setState("category", value)}
          />
        </label>
        <label class="text-11-regular text-text-weak">
          {c().rating}
          <SelectV2
            class="mt-1"
            appearance="large"
            numeric
            options={[5, 4, 3, 2, 1]}
            current={state.rating}
            onSelect={(value) => value && setState("rating", value)}
          />
        </label>
        <TextareaV2
          class="min-h-20"
          placeholder={c().feedbackMessage}
          aria-label={c().feedbackMessage}
          value={state.message}
          onInput={(event) => setState("message", event.currentTarget.value)}
        />
      </div>
      <div>
        <ButtonV2 size="small" variant="neutral" disabled={state.saving || !state.message.trim()} onClick={submit}>
          {state.saving ? language.t("common.saving") : language.t("common.submit")}
        </ButtonV2>
      </div>
      <Show when={state.error}>
        <div role="alert" class="rounded-md border border-border-danger p-3 text-12-regular text-text-danger">
          {state.error}
        </div>
      </Show>
      <Show when={state.notice}>
        <div role="status" class="rounded-md border border-border-weak-base p-3 text-12-regular text-text-weak">
          {state.notice}
        </div>
      </Show>
    </section>
  )
}
