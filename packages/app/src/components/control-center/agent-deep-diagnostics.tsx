import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import {
  contractAuditEffect,
  contractAuditBoundaryLabel,
  contractAuditEvidenceLabel,
  contractAuditMissingLabel,
  contractAuditRequirementLabel,
  contractAuditStatus,
  contractAuditTitle,
  isContractAuditSectionID,
  parseContractAudit,
} from "./contract-audit-presentation"
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
type DeepInsights = Awaited<ReturnType<OperationsApi["agentCapabilities"]["deepInsights"]>>["data"]
type PlanPreview = Awaited<ReturnType<OperationsApi["agentCapabilities"]["planPreview"]>>["data"]
export function AgentDeepDiagnostics(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  const language = useLanguage()
  const [state, setState] = createStore({
    loading: false,
    error: "",
    notice: "",
    insights: undefined as DeepInsights | undefined,
    task: "",
    planText: "",
    plan: undefined as PlanPreview | undefined,
    runID: "",
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return `${value.directory}\u0000${value.workspace ?? ""}`
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const action = async (
    run: (location: LocationInput, request: ScopeRequestToken) => Promise<void>,
    notice: string,
  ) => {
    if (state.loading || !props.ready()) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      await run(requestedLocation, request)
      if (scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicError(error, t("Unknown deep-diagnostics error")))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const loadInsights = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.deepInsights(location)
      if (scopeGuard.isCurrent(request)) setState("insights", result.data)
    }, t("\u6DF1\u5EA6\u8BCA\u65AD\u5B8C\u6210\u3002\u7ED3\u679C\u4E3A\u53EA\u8BFB\u5FEB\u7167\uFF0C\u4E0D\u4F1A\u751F\u6210\u53D1\u5E03\u8BC1\u636E\u6216\u4FEE\u6539\u6743\u9650\u3002"))
  const previewPlan = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.planPreview({
        ...location,
        task: state.task.trim(),
        planText: state.planText.trim(),
      })
      if (scopeGuard.isCurrent(request)) setState("plan", result.data)
    }, t("\u8BA1\u5212\u5DF2\u89C4\u8303\u5316\uFF1B\u8FD9\u4E0D\u662F\u6267\u884C\u6279\u51C6\u3002"))
  const exportTrace = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.runTraceExport({
        ...location,
        runID: state.runID.trim(),
      })
      const artifact = result.data
      if ("found" in artifact && artifact.found === false)
        throw new Error(t("\u6CA1\u6709\u627E\u5230\u8BE5 Run \u7684 Trace\u3002"))
      if (!scopeGuard.isCurrent(request)) return
      const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mime_type }))
      try {
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = artifact.filename
        anchor.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    }, t("Trace \u5DF2\u5BFC\u51FA\u5230\u672C\u673A\u4E0B\u8F7D\u76EE\u5F55\u3002"))
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => `${props.ready() ? "ready" : "not-ready"}\u0000${locationScopeKey()}`,
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready() || !scopeChanged) return
        setState({ loading: false, error: "", notice: "", insights: undefined, plan: undefined })
      },
    ),
  )
  return (
    <section
      class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4"
      data-testid="agent-deep-diagnostics"
    >
      <header>
        <h2 class="text-14-medium text-text-strong">{t("Agent \u6DF1\u5EA6\u8BCA\u65AD")}</h2>
        <p class="mt-1 text-12-regular text-text-weak">
          {t(
            "\u6587\u4EF6\u89C2\u5BDF\u3001\u81EA\u4FEE\u6B63\u8BC4\u4F30\u548C\u53D1\u5E03\u95E8\u7981\u53EF\u80FD\u9700\u8981\u8F83\u957F\u65F6\u95F4\uFF0C\u56E0\u6B64\u53EA\u5728\u4F60\u660E\u786E\u70B9\u51FB\u540E\u52A0\u8F7D\uFF0C\u4E0D\u963B\u585E\u63A7\u5236\u4E2D\u5FC3\u9996\u5C4F\u3002",
          )}
        </p>
      </header>

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

      <div>
        <Button size="small" variant="secondary" disabled={state.loading || !props.ready()} onClick={loadInsights}>
          {state.loading ? t("\u6B63\u5728\u8FD0\u884C\u2026") : t("\u8FD0\u884C\u53EA\u8BFB\u6DF1\u5EA6\u8BCA\u65AD")}
        </Button>
      </div>
      <Show when={state.insights}>
        {(value) => (
          <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <For each={value().sections}>
              {(section) => {
                if (isContractAuditSectionID(section.id)) {
                  const audit = parseContractAudit(section.data)
                  if (audit)
                    return (
                      <details
                        class="rounded-md border border-border-weak-base p-3"
                        data-testid={`deep-insight-${section.id}`}
                      >
                        <summary class="cursor-pointer text-13-medium text-text-strong">
                          {contractAuditTitle(section.id, language.locale())}
                        </summary>
                        <div class="mt-3 flex flex-col gap-2 text-12-regular text-text-weak">
                          <p class="text-text-strong">{contractAuditStatus(audit, language.locale())}</p>
                          <p>{contractAuditEffect(audit, language.locale())}</p>
                          <p>{contractAuditBoundaryLabel(audit.execution_boundary, language.locale())}</p>
                          <p>{contractAuditMissingLabel(audit.missing_requirements.length, language.locale())}</p>
                          <Show when={audit.missing_requirements.length > 0}>
                            <ul class="list-disc space-y-1 pl-5">
                              <For each={audit.missing_requirements}>
                                {(requirement) => (
                                  <li>{contractAuditRequirementLabel(requirement, language.locale())}</li>
                                )}
                              </For>
                            </ul>
                          </Show>
                          <p class="whitespace-pre-wrap text-text-strong">{audit.caveat}</p>
                          <details
                            data-testid={`deep-insight-${section.id}-advanced`}
                            class="rounded border border-border-weak-base p-2"
                          >
                            <summary class="cursor-pointer">{contractAuditEvidenceLabel(language.locale())}</summary>
                            <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
                              {JSON.stringify(section.data, null, 2)}
                            </pre>
                          </details>
                        </div>
                      </details>
                    )
                }
                return (
                  <details
                    class="rounded-md border border-border-weak-base p-3"
                    data-testid={`deep-insight-${section.id}`}
                  >
                    <summary class="cursor-pointer text-13-medium text-text-strong">{section.title}</summary>
                    <pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
                      {JSON.stringify(section.data, null, 2)}
                    </pre>
                  </details>
                )
              }}
            </For>
          </div>
        )}
      </Show>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{t("Plan \u5408\u540C\u9884\u89C8")}</h3>
          <TextField
            label={t("\u4EFB\u52A1")}
            value={state.task}
            onChange={(value) => setState("task", value)}
            placeholder={t("\u91CD\u6784\u8EAB\u4EFD\u9A8C\u8BC1\u8FB9\u754C")}
          />
          <textarea
            class="min-h-28 resize-y rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular text-text-strong"
            value={state.planText}
            onInput={(event) => setState("planText", event.currentTarget.value)}
            placeholder={t(
              "- \u5BA1\u8BA1\u73B0\u6709\u8C03\u7528\u65B9\n- \u589E\u52A0\u517C\u5BB9\u8FC1\u79FB\n- \u56DE\u5F52\u5E76\u51C6\u5907\u56DE\u6EDA",
            )}
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.task.trim() || !state.planText.trim()}
              onClick={previewPlan}
            >
              {t("\u89C4\u8303\u5316\u8BA1\u5212")}
            </Button>
          </div>
          <Show when={state.plan}>
            {(value) => (
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
                {JSON.stringify(value(), null, 2)}
              </pre>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{t("Run Trace \u5BFC\u51FA")}</h3>
          <p class="text-11-regular text-text-weak">
            {t(
              "\u4EC5\u5BFC\u51FA\u5DF2\u6709\u6301\u4E45\u5316 Trace\uFF0C\u4E0D\u4F1A\u91CD\u653E Run\uFF0C\u4E5F\u4E0D\u4F1A\u6062\u590D\u6216\u5220\u9664\u5DE5\u4F5C\u533A\u6587\u4EF6\u3002",
            )}
          </p>
          <TextField
            label={t("Run ID")}
            value={state.runID}
            onChange={(value) => setState("runID", value)}
            placeholder={t("run_...")}
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.runID.trim()}
              onClick={exportTrace}
            >
              {t("\u5BFC\u51FA JSON")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
function publicError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return fallback
  }
}
