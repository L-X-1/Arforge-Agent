import "@/components/settings-v2/management-review.css"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useOnboarding } from "@/context/onboarding"
import { onboardingCopy } from "./onboarding-copy"
import { ManagementStatus } from "@/components/settings-v2/management-status"

export function HomeFirstRunGuide(props: {
  canStart: boolean
  connection?: "loading" | "offline" | "ready"
  scope?: string
  onRetry?: () => Promise<unknown>
  onStart: () => void
}) {
  const language = useLanguage()
  const onboarding = useOnboarding()
  const copy = () => onboardingCopy(language.locale())
  const connection = () => props.connection ?? "ready"
  const [feedback, setFeedback] = createStore({ retrying: false, error: undefined as unknown })
  let version = 0
  let mounted = true
  createEffect(on(() => [props.scope, onboarding.visible()], () => {
    version++
    setFeedback({ retrying: false, error: undefined })
  }))
  onCleanup(() => { mounted = false; version++ })
  const retry = async () => {
    if (feedback.retrying || !props.onRetry) return
    const scope = props.scope
    const current = ++version
    const active = () => mounted && current === version && props.scope === scope && onboarding.visible()
    setFeedback({ retrying: true, error: undefined })
    try {
      await props.onRetry()
    } catch (error) {
      if (active()) setFeedback("error", error ?? language.t("common.requestFailed"))
    } finally {
      if (active()) setFeedback("retrying", false)
    }
  }
  const canStart = () => props.canStart && connection() === "ready" && !feedback.retrying
  const startLabel = () => feedback.retrying || connection() === "loading" ? language.t("common.loading")
    : connection() === "offline" ? language.t("session.error.serverConnection")
    : props.canStart ? copy().start : feedback.error ? language.t("common.requestFailed") : copy().projectNeeded
  const connectionFeedback = () => connection() !== "ready" || feedback.retrying || !!feedback.error
  const projectNeeded = () => connection() === "ready" && !props.canStart && !connectionFeedback()

  return (
    <Show when={onboarding.visible()}>
      <section
        data-component="arforge-first-run-guide"
        data-arforge-management="onboarding"
        aria-labelledby="arforge-first-run-title"
        class="mt-5 rounded-[16px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-5 py-5 shadow-[inset_0_1px_0_var(--arforge-glass-specular)] motion-reduce:transition-none"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[12px] font-normal uppercase tracking-[0.08em] text-v2-text-text-accent">{copy().eyebrow}</p>
            <h1 id="arforge-first-run-title" class="mt-1 text-[18px] font-medium leading-6 text-v2-text-text-base">
              {copy().title}
            </h1>
            <p class="mt-2 max-w-[680px] text-[14px] font-normal leading-5 text-v2-text-text-muted">{copy().description}</p>
          </div>
          <button
            type="button"
            class="min-h-11 shrink-0 rounded-[8px] px-3 py-1.5 text-[12px] font-normal text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-none focus-visible:shadow-[var(--arforge-focus-ring)]"
            onClick={() => onboarding.dismiss()}
          >
            {copy().skip}
          </button>
        </div>

        <ol class="mt-5 grid gap-3 md:grid-cols-3">
          <For each={copy().steps}>
            {(step, index) => (
              <li class="flex gap-3 rounded-[12px] bg-v2-background-bg-base/45 p-3">
                <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-accent/14 text-[12px] font-medium text-v2-text-text-accent">
                  {index() + 1}
                </span>
                <div>
                  <h2 class="text-[14px] font-medium leading-5 text-v2-text-text-base">{step[0]}</h2>
                  <p class="mt-0.5 text-[12px] font-normal leading-[18px] text-v2-text-text-muted">{step[1]}</p>
                </div>
              </li>
            )}
          </For>
        </ol>

        <div class="mt-4 flex flex-col gap-3 border-t border-v2-border-border-muted pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-x-5 gap-y-2 text-[12px] font-normal leading-[18px] text-v2-text-text-muted">
            <span>
              <strong class="mr-1 font-medium text-v2-text-text-base">{copy().automatic}</strong>
              {copy().automaticText}
            </span>
            <span>
              <strong class="mr-1 font-medium text-v2-text-text-base">{copy().manual}</strong>
              {copy().manualText}
            </span>
          </div>
          <ButtonV2
            aria-describedby={!canStart() ? connectionFeedback() ? "arforge-first-run-connection" : "arforge-first-run-project-needed" : undefined}
            data-action="onboarding-start-task"
            variant="neutral"
            size="normal"
            icon="edit"
            disabled={!canStart()}
            title={startLabel()}
            onClick={props.onStart}
          >
            {startLabel()}
          </ButtonV2>
        </div>
        <Show when={connectionFeedback()}>
          <div id="arforge-first-run-connection" class="mt-3 [&_.arforge-management-status]:!text-[14px] [&_.arforge-management-status]:!font-normal [&_.arforge-management-status-copy>strong]:!font-medium" data-component="onboarding-connection-feedback">
            <ManagementStatus
              loading={connection() === "loading"}
              initialLoading={!feedback.retrying}
              refreshing={feedback.retrying}
              offline={connection() === "offline"}
              error={feedback.error}
              onRetry={props.onRetry ? () => void retry() : undefined}
            />
          </div>
        </Show>
        <Show when={projectNeeded()}>
          <p id="arforge-first-run-project-needed" role="status" class="arforge-management-empty !text-[14px] font-normal">{copy().projectNeeded}</p>
        </Show>
      </section>
    </Show>
  )
}

export function NewSessionPromptGuide(props: { onUseExample: (text: string) => void }) {
  const language = useLanguage()
  const onboarding = useOnboarding()
  const copy = () => onboardingCopy(language.locale())

  return (
    <Show when={onboarding.visible()}>
      <section
        data-component="arforge-first-task-examples"
        data-arforge-management="onboarding"
        aria-labelledby="arforge-first-task-title"
        class="rounded-[14px] border border-v2-border-border-muted bg-v2-background-bg-layer-01/70 p-4 shadow-[inset_0_1px_0_var(--arforge-glass-specular)]"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 id="arforge-first-task-title" class="text-[14px] font-medium leading-5 text-v2-text-text-base">
              {copy().promptTitle}
            </h2>
            <p class="mt-1 text-[12px] font-normal leading-[18px] text-v2-text-text-muted">{copy().promptDescription}</p>
          </div>
          <button
            type="button"
            class="flex size-11 shrink-0 items-center justify-center rounded-[8px] text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none focus-visible:shadow-[var(--arforge-focus-ring)]"
            aria-label={copy().closePrompt}
            title={copy().closePrompt}
            onClick={() => onboarding.dismiss()}
          >
            <IconV2 name="xmark-small" />
          </button>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-3">
          <For each={copy().examples}>
            {(example) => (
              <button
                type="button"
                class="min-h-11 rounded-[10px] border border-v2-border-border-muted bg-transparent p-3 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none focus-visible:shadow-[var(--arforge-focus-ring)]"
                title={copy().useExample}
                onClick={() => props.onUseExample(example[1])}
              >
                <span class="block text-[14px] font-medium text-v2-text-text-base">{example[0]}</span>
                <span class="mt-1 block line-clamp-3 text-[12px] font-normal leading-4 text-v2-text-text-muted">{example[1]}</span>
              </button>
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}
