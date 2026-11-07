import { Button } from "@arforge-ai/ui/button"
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { useLanguage, type Locale } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { serializedTimeMillis, type MemoryCandidateReviewDto } from "@/utils/memory-candidate-api"
import {
  candidateBlockLabel,
  candidateReasonLabel,
  candidateReviewCopy,
  candidateValueLabel,
} from "./memory-candidate-review-copy"

type LocationInput = { location: { directory: string; workspace?: string } }
type Summary = {
  candidateID: string
  status: string
  sensitivity: string
  confidence: number
}

const publicError = (error: unknown) => (error instanceof Error ? error.message : String(error))
const formatTime = (value: number | string, locale: Locale) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(locale === "zh" ? "zh-CN" : locale === "zht" ? "zh-TW" : "en-US")
}

export function MemoryCandidateReviewCard(props: {
  api: () => OperationsApi
  location: () => LocationInput
  candidate: Summary
  autoOpen: boolean
  onChanged: (message: string, status: MemoryCandidateReviewDto["status"]) => void
}) {
  const language = useLanguage()
  const copy = () => candidateReviewCopy(language.locale())
  const [expanded, setExpanded] = createSignal(false)
  const [review, setReview] = createSignal<MemoryCandidateReviewDto>()
  const [loading, setLoading] = createSignal(false)
  const [action, setAction] = createSignal<"approve" | "reject" | "activate">()
  const [error, setError] = createSignal<string>()
  const [reason, setReason] = createSignal("")
  const [confirmReject, setConfirmReject] = createSignal(false)
  let autoOpened = false
  let disposed = false
  let sourceAPI = props.api()
  let sourceGeneration = 0
  let loadedReview: ScopeRequestToken | undefined

  const location = () => props.location().location
  const scopeKey = () => {
    const api = props.api()
    if (api !== sourceAPI) { sourceAPI = api; sourceGeneration += 1 }
    const source = location()
    return `${sourceGeneration}\u0000${source.directory}\u0000${source.workspace ?? ""}\u0000${props.candidate.candidateID}`
  }
  const guard = createScopeRequestGuard(scopeKey)
  const current = (request: ScopeRequestToken) => !disposed && guard.isCurrent(request)
  onCleanup(() => { disposed = true; loadedReview = undefined; guard.invalidate() })
  const load = async () => {
    if (disposed) return
    const request = guard.invalidate()
    const api = props.api()
    const source = { ...location() }
    const candidateID = props.candidate.candidateID
    loadedReview = undefined
    setLoading(true)
    setError(undefined)
    try {
      const next = await api.memoryCandidates.review({ candidateID, directory: source.directory, workspace: source.workspace })
      if (!current(request)) return
      setReview(next)
      loadedReview = request
    } catch (cause) {
      if (current(request)) setError(publicError(cause))
    } finally {
      if (current(request)) setLoading(false)
    }
  }
  createEffect(on(scopeKey, () => {
    guard.current()
    loadedReview = undefined
    setReview(undefined)
    setReason("")
    setError(undefined)
    setAction(undefined)
    setConfirmReject(false)
    if (expanded() || props.autoOpen) void load()
  }, { defer: true }))

  createEffect(() => {
    if (!props.autoOpen) {
      autoOpened = false
      return
    }
    if (autoOpened) return
    autoOpened = true
    setExpanded(true)
    void load()
  })

  const toggle = () => {
    if (expanded()) {
      setExpanded(false)
      setConfirmReject(false)
      return
    }
    setExpanded(true)
    void load()
  }

  const decide = async (operation: "approve" | "reject" | "activate") => {
    const value = review()
    const decisionReason = reason().trim()
    if (!value || !decisionReason || !loadedReview || !current(loadedReview)) return
    const request = guard.capture()
    const api = props.api()
    const source = { ...location() }
    setAction(operation)
    setError(undefined)
    try {
      const next = await api.memoryCandidates[operation]({
        candidateID: value.candidateID,
        directory: source.directory,
        workspace: source.workspace,
        expectedUpdatedAt: serializedTimeMillis(value.time.updated),
        reason: decisionReason,
      })
      if (!current(request)) return
      setReview(next)
      loadedReview = request
      setReason("")
      setConfirmReject(false)
      props.onChanged(
        operation === "approve" ? copy().approved : operation === "reject" ? copy().rejected : copy().activated,
        next.status,
      )
    } catch (cause) {
      if (current(request)) setError(publicError(cause))
    } finally {
      if (current(request)) setAction(undefined)
    }
  }

  return (
    <article
      id={`memory-candidate-${props.candidate.candidateID}`}
      class="scroll-mt-4 rounded-md border border-border-weak-base bg-background-base p-3 outline-none"
      classList={{ "md:col-span-2": expanded() }}
      tabindex="-1"
      data-testid="memory-candidate-card"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <code class="truncate text-10-regular text-text-weak">{props.candidate.candidateID}</code>
        <Button variant="secondary" size="small" onClick={toggle} aria-expanded={expanded()}>
          {expanded() ? copy().close : copy().review}
        </Button>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-10-regular text-text-weak">
        <span>{candidateValueLabel(review()?.status ?? props.candidate.status, language.locale())}</span>
        <span>{candidateValueLabel(review()?.sensitivity ?? props.candidate.sensitivity, language.locale())}</span>
        <span>{((review()?.confidence ?? props.candidate.confidence) * 100).toFixed(0)}%</span>
      </div>

      <Show when={expanded()}>
        <div
          class="mt-3 border-t border-border-weak-base pt-3"
          data-testid="memory-candidate-review"
          aria-busy={loading() || !!action()}
        >
          <Show when={loading()}>
            <p role="status" class="text-11-regular text-text-weak">
              {copy().loading}
            </p>
          </Show>
          <Show when={error()}>
            {(message) => (
              <div class="rounded-md border border-border-warning bg-background-weak p-2" role="alert">
                <p class="text-11-regular text-text-warning">{message()}</p>
                <Button variant="secondary" size="small" class="mt-2" onClick={() => void load()}>
                  {copy().retry}
                </Button>
              </div>
            )}
          </Show>
          <Show when={review()}>
            {(value) => (
              <div class="flex flex-col gap-3">
                <section aria-labelledby={`memory-candidate-content-${value().candidateID}`}>
                  <h5 id={`memory-candidate-content-${value().candidateID}`} class="text-11-medium text-text-strong">
                    {copy().content}
                  </h5>
                  <Show
                    when={!value().contentRedacted}
                    fallback={
                      <p class="mt-1 rounded-md border border-border-warning bg-background-weak p-2 text-11-regular text-text-warning">
                        {copy().redacted}
                      </p>
                    }
                  >
                    <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-weak-base bg-background-weak p-2 text-11-regular text-text-base">
                      {value().content}
                    </pre>
                  </Show>
                </section>

                <dl class="grid gap-2 text-10-regular text-text-weak sm:grid-cols-2">
                  <div>
                    <dt class="text-text-base">{copy().policy}</dt>
                    <dd>
                      {candidateValueLabel(value().policy.status, language.locale())} ·{" "}
                      {candidateReasonLabel(value().policy.reason, language.locale())}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-text-base">{copy().dedup}</dt>
                    <dd>{candidateValueLabel(value().dedup.status, language.locale())}</dd>
                  </div>
                  <div>
                    <dt class="text-text-base">{copy().retention}</dt>
                    <dd>
                      {candidateValueLabel(value().retention.mode, language.locale())} ·{" "}
                      {candidateReasonLabel(value().retention.reason, language.locale())}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-text-base">{copy().evidence}</dt>
                    <dd class="break-all" data-testid="memory-candidate-source-preview">
                      <Show when={value().sourceEvidenceIDs.length > 0} fallback={copy().noSourceEvidence}>
                        <For each={value().sourceEvidenceIDs}>{id => <code class="block">{id}</code>}</For>
                        <p>{copy().sourcePreviewUnavailable}</p>
                      </Show>
                    </dd>
                  </div>
                </dl>

                <Show when={value().blockedReasons.length > 0}>
                  <ul class="list-disc pl-5 text-11-regular text-text-warning" role="alert">
                    <For each={value().blockedReasons}>
                      {(code) => <li>{candidateBlockLabel(code, language.locale())}</li>}
                    </For>
                  </ul>
                </Show>

                <label class="flex flex-col gap-1 text-11-medium text-text-strong">
                  {copy().reason}
                  <textarea
                    value={reason()}
                    onInput={(event) => setReason(event.currentTarget.value)}
                    rows={2}
                    maxlength={500}
                    class="w-full resize-y rounded-md border border-border-weak-base bg-background-base px-2 py-1.5 text-11-regular text-text-base outline-none focus:border-border-focus"
                    aria-describedby={`memory-candidate-reason-help-${value().candidateID}`}
                  />
                </label>
                <p id={`memory-candidate-reason-help-${value().candidateID}`} class="text-10-regular text-text-weak">
                  {copy().reasonHelp}
                </p>

                <div class="flex flex-wrap gap-2">
                  <Show when={value().approvalAllowed}>
                    <Button
                      size="small"
                      disabled={!reason().trim() || !!action()}
                      onClick={() => void decide("approve")}
                    >
                      {action() === "approve" ? copy().processing : copy().approve}
                    </Button>
                  </Show>
                  <Show when={value().activationAllowed}>
                    <Button
                      size="small"
                      disabled={!reason().trim() || !!action()}
                      onClick={() => void decide("activate")}
                    >
                      {action() === "activate" ? copy().processing : copy().activate}
                    </Button>
                  </Show>
                  <Show when={value().status === "proposed" || value().status === "approved"}>
                    <Show
                      when={confirmReject()}
                      fallback={
                        <Button
                          variant="secondary"
                          size="small"
                          disabled={!reason().trim() || !!action()}
                          onClick={() => setConfirmReject(true)}
                        >
                          {copy().reject}
                        </Button>
                      }
                    >
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={!reason().trim() || !!action()}
                        onClick={() => void decide("reject")}
                      >
                        {action() === "reject" ? copy().processing : copy().confirmReject}
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={!!action()}
                        onClick={() => setConfirmReject(false)}
                      >
                        {copy().cancel}
                      </Button>
                    </Show>
                  </Show>
                </div>

                <details class="text-10-regular text-text-weak">
                  <summary class="cursor-pointer text-text-base">
                    {copy().audit} ({value().audit.length})
                  </summary>
                  <ol class="mt-2 flex flex-col gap-1">
                    <For each={value().audit}>
                      {(entry) => (
                        <li>
                          {formatTime(entry.createdAt, language.locale())} ·{" "}
                          {candidateValueLabel(entry.operation, language.locale())} ·{" "}
                          {candidateReasonLabel(entry.reason, language.locale())}
                        </li>
                      )}
                    </For>
                  </ol>
                </details>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </article>
  )
}
