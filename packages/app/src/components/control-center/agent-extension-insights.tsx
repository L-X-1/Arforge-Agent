import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { agentExtensionPublicError, isRetiredAgentCapabilityError } from "./agent-extension-error"
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
type Customizations = Awaited<ReturnType<OperationsApi["agentCapabilities"]["customizationList"]>>["data"]
type SkillRead = Awaited<ReturnType<OperationsApi["agentCapabilities"]["skillRead"]>>["data"]
type SkillRoute = Awaited<ReturnType<OperationsApi["agentCapabilities"]["skillRoute"]>>["data"]
type WorkflowEvents = Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowRunEvents"]>>["data"]
export function AgentExtensionInsights(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  const [state, setState] = createStore({
    loading: false,
    error: "",
    notice: "",
    customizations: undefined as Customizations | undefined,
    skillID: "",
    skill: undefined as SkillRead | undefined,
    routeRequest: "",
    route: undefined as SkillRoute | undefined,
    commandName: "",
    commandArgs: "",
    rendered: "",
    workflowRunID: "",
    workflowEvents: undefined as WorkflowEvents | undefined,
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const action = async (
    run: (location: LocationInput, request: ScopeRequestToken) => Promise<void>,
    notice: string,
    unavailable?: string,
  ) => {
    if (state.loading || !props.ready()) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ loading: true, error: "", notice: "" })
    try {
      await run(requestedLocation, request)
      if (scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) {
        if (unavailable && isRetiredAgentCapabilityError(error)) {
          setState("notice", unavailable)
        } else {
          setState("error", agentExtensionPublicError(error, t("Unknown Agent extension error")))
        }
      }
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const loadCustomizations = () =>
    action(
      async (location, request) => {
        const result = await props.api().agentCapabilities.customizationList(location)
        if (scopeGuard.isCurrent(request)) setState("customizations", result.data)
      },
      t("\u81EA\u5B9A\u4E49\u547D\u4EE4\u548C Hook \u6E05\u5355\u5DF2\u5237\u65B0\u3002"),
      t("当前运行时不提供自定义命令和钩子（Hook）检查；技能（Skill）与工作流（Workflow）功能仍可正常使用。"),
    )
  const readSkill = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.skillRead({
        ...location,
        skillID: state.skillID.trim(),
        maxChars: 60000,
      })
      if (scopeGuard.isCurrent(request)) setState("skill", result.data)
    }, t("Skill \u5185\u5BB9\u5DF2\u901A\u8FC7\u53EA\u8BFB\u8FB9\u754C\u52A0\u8F7D\u3002"))
  const routeSkills = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.skillRoute({
        ...location,
        request: state.routeRequest.trim(),
      })
      if (scopeGuard.isCurrent(request)) setState("route", result.data)
    }, t("Skill \u8DEF\u7531\u9884\u89C8\u5DF2\u751F\u6210\uFF1B\u6CA1\u6709\u6267\u884C\u4EFB\u4F55 Skill\u3002"))
  const renderCommand = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.customizationRender({
        ...location,
        name: state.commandName.trim(),
        args: state.commandArgs,
      })
      if (scopeGuard.isCurrent(request)) setState("rendered", result.data.rendered)
    }, t("\u81EA\u5B9A\u4E49\u547D\u4EE4\u6A21\u677F\u5DF2\u53EA\u8BFB\u6E32\u67D3\u3002"))
  const loadWorkflowEvents = () =>
    action(async (location, request) => {
      const result = await props.api().agentCapabilities.workflowRunEvents({
        ...location,
        runID: state.workflowRunID.trim(),
        after: 0,
        limit: 200,
      })
      if (scopeGuard.isCurrent(request)) setState("workflowEvents", result.data)
    }, t("Workflow \u4E8B\u4EF6\u9875\u5DF2\u52A0\u8F7D\u3002"))
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready()) return
        if (scopeChanged) {
          setState({
            loading: false,
            error: "",
            notice: "",
            customizations: undefined,
            skill: undefined,
            route: undefined,
            rendered: "",
            workflowEvents: undefined,
          })
        }
        void loadCustomizations()
      },
    ),
  )
  return (
    <section
      class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4"
      data-testid="agent-extension-insights"
      aria-busy={state.loading}
    >
      <header>
        <h2 class="text-14-medium text-text-strong">{t("Agent \u6269\u5C55\u8BED\u4E49\u5C42")}</h2>
        <p class="mt-1 text-12-regular text-text-weak">
          {t(
            "Skill \u5185\u5BB9\u4E0E\u8DEF\u7531\u3001\u81EA\u5B9A\u4E49\u547D\u4EE4\u4EE5\u53CA Workflow \u4E8B\u4EF6\u5747\u7ECF\u8FC7 typed Server API\uFF1B\u8FD9\u91CC\u4E0D\u4F1A\u66B4\u9732\u539F\u59CB Bridge \u8C03\u7528\u5668\u3002",
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

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{t("\u8BFB\u53D6 Skill")}</h3>
          <TextField
            label={t("Skill ID")}
            value={state.skillID}
            onChange={(value) => setState("skillID", value)}
            placeholder="superpowers"
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.skillID.trim()}
              onClick={readSkill}
            >
              {t("\u53EA\u8BFB\u52A0\u8F7D")}
            </Button>
          </div>
          <Show when={state.skill}>
            {(value) => (
              <Show when={value().ok} fallback={<p class="text-12-regular text-text-danger">{skillError(value())}</p>}>
                <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
                  {skillContent(value())}
                </pre>
              </Show>
            )}
          </Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{t("Skill \u8DEF\u7531\u9884\u89C8")}</h3>
          <textarea
            class="min-h-24 resize-y rounded-md border border-border-weak-base bg-background-base p-3 text-12-regular text-text-strong"
            value={state.routeRequest}
            onInput={(event) => setState("routeRequest", event.currentTarget.value)}
            placeholder={t(
              "\u7C98\u8D34\u4E00\u6BB5\u771F\u5B9E\u4EFB\u52A1\uFF1B\u8FD9\u91CC\u53EA\u8BA1\u7B97\u5E94\u8BE5\u4F7F\u7528\u54EA\u4E9B Skill\u3002",
            )}
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.routeRequest.trim()}
              onClick={routeSkills}
            >
              {t("\u9884\u89C8\u8DEF\u7531")}
            </Button>
          </div>
          <Show when={state.route}>{(value) => <JsonPreview value={value()} />}</Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-13-medium text-text-strong">{t("\u81EA\u5B9A\u4E49\u547D\u4EE4 / Hook")}</h3>
            <Button size="small" variant="ghost" disabled={state.loading} onClick={loadCustomizations}>
              {t("\u5237\u65B0")}
            </Button>
          </div>
          <Show when={state.customizations}>
            {(value) => (
              <>
                <div class="flex flex-wrap gap-2">
                  <For each={value().commands.items}>
                    {(command) => (
                      <Button size="small" variant="ghost" onClick={() => setState("commandName", command.name)}>
                        /{command.name}
                      </Button>
                    )}
                  </For>
                </div>
                <p class="text-11-regular text-text-weak">
                  {value().commands.count}
                  {t("\u4E2A\u547D\u4EE4 \u00B7")}
                  {value().hooks.count}
                  {t("\u4E2A Hook\uFF1BHook \u5728\u8FD9\u91CC\u53EA\u8BFB\u5C55\u793A\uFF0C\u4E0D\u6267\u884C\u3002")}
                </p>
              </>
            )}
          </Show>
          <TextField
            label={t("\u547D\u4EE4\u540D")}
            value={state.commandName}
            onChange={(value) => setState("commandName", value)}
            placeholder={t("review")}
          />
          <TextField
            label={t("\u6A21\u677F\u53C2\u6570")}
            value={state.commandArgs}
            onChange={(value) => setState("commandArgs", value)}
            placeholder={t("src/server.ts")}
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.commandName.trim()}
              onClick={renderCommand}
            >
              {t("\u6E32\u67D3\u4F46\u4E0D\u6267\u884C")}
            </Button>
          </div>
          <Show when={state.rendered}>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
              {state.rendered}
            </pre>
          </Show>
        </div>

        <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
          <h3 class="text-13-medium text-text-strong">{t("Workflow \u4E8B\u4EF6")}</h3>
          <TextField
            label={t("Workflow Run ID")}
            value={state.workflowRunID}
            onChange={(value) => setState("workflowRunID", value)}
            placeholder={t("wfr_...")}
          />
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={state.loading || !state.workflowRunID.trim()}
              onClick={loadWorkflowEvents}
            >
              {t("\u52A0\u8F7D\u4E8B\u4EF6\u9875")}
            </Button>
          </div>
          <Show when={state.workflowEvents}>{(value) => <JsonPreview value={value()} />}</Show>
        </div>
      </div>
    </section>
  )
}
function JsonPreview(props: { value: unknown }) {
  const t = useControlCenterText()
  return (
    <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-11-regular">
      {JSON.stringify(props.value, null, 2)}
    </pre>
  )
}
function skillContent(value: SkillRead) {
  return value.ok ? value.content : ""
}
function skillError(value: SkillRead) {
  return value.ok ? "" : value.error
}
