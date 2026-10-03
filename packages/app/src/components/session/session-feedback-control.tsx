import { bindManagementApi, createManagementScope } from "@/components/settings-v2/management-async"
import { onCleanup } from "solid-js"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import { managementCopy } from "@/components/settings-v2/management-state"
import "@/components/settings-v2/management-review.css"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { SelectV2 } from "@arforge-ai/ui/v2/select-v2"
import { TextareaV2 } from "@arforge-ai/ui/v2/textarea-v2"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createStore } from "solid-js/store"
import { useSessionOperationsText } from "./session-operations-text"

export function SessionFeedbackControl(props: { api: () => OperationsApi; sessionID: string; disabled?: boolean }) {
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
  const source = props.api()
  const sessionID = props.sessionID
  const scope = createManagementScope(source, sessionID, () => ({ source: props.api(), sessionID: props.sessionID }))
  onCleanup(scope.dispose)
  const api = bindManagementApi(source, scope)
  const blocked = () => !scope.live() || !!props.disabled || state.saving
  const submit = async () => {
    if (blocked() || !state.message.trim()) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await api.feedback.submit({
        category: state.category,
        rating: state.rating,
        message: state.message.trim(),
        sessionID,
      })
      setState({ message: "", notice: managementCopy(language.locale()).saved })
    } catch (error) {
      if (scope.live()) setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      if (scope.live()) setState("saving", false)
    }
  }
  return (
    <section
      class="flex flex-col gap-3 border-t border-border-weak-base pt-5"
      aria-labelledby="operations-feedback-title"
      data-testid="session-feedback-control"
      aria-busy={state.saving}
    >
      <h2 id="operations-feedback-title" class="text-14-medium text-text-strong">
        {c().feedbackTitle}
      </h2>
      <p class="text-12-regular text-text-weak">{c().feedbackDescription}</p>
      <div class="grid gap-3 md:grid-cols-[180px_140px_1fr]">
        <label class="text-11-regular text-text-weak">
          {c().category}
          <SelectV2
            disabled={blocked()}
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
            disabled={blocked()}
            class="mt-1"
            appearance="large"
            numeric
            options={[5, 4, 3, 2, 1]}
            current={state.rating}
            onSelect={(value) => value && setState("rating", value)}
          />
        </label>
        <TextareaV2
          disabled={blocked()}
          class="min-h-20"
          placeholder={c().feedbackMessage}
          aria-label={c().feedbackMessage}
          value={state.message}
          onInput={(event) => setState("message", event.currentTarget.value)}
        />
      </div>
      <div>
        <ButtonV2 size="small" variant="neutral" disabled={blocked() || !state.message.trim()} onClick={submit}>
          {state.saving ? language.t("common.saving") : language.t("common.submit")}
        </ButtonV2>
      </div>
      <ManagementStatus saving={state.saving} error={state.error} notice={state.notice} />
    </section>
  )
}
