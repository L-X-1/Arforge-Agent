import { useControlCenterText } from "@/components/control-center/control-center-text"
import { useLanguage } from "@/context/language"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { sessionExtensionPublicError } from "./session-extension-error"
import { hasOperationDirectory } from "./session-operation-boundary"
import {
  workflowAccessLabel,
  workflowAttemptLabel,
  workflowConditionLabel,
  workflowDateTime,
  workflowDependencyLabel,
  workflowDurationLabel,
  workflowNodeKindLabel,
  workflowNodeSummary,
  workflowParallelismHelp,
  workflowParallelismLabel,
  workflowPermissionLabel,
  workflowProgressBreakdownLabel,
  workflowProgressLabel,
  workflowExecutionModeLabel,
  workflowRunStatusLabel,
  workflowSchedulingActionLabel,
  workflowSchedulingFailureLabel,
  workflowSchedulingSummary,
  workflowSplitReasonLabel,
} from "./workflow-presentation"
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
type WorkflowPage = Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowList"]>>["data"]
type WorkflowDefinition = WorkflowPage["items"][number]
type WorkflowRunPage = Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowRunList"]>>["data"]
type WorkflowRun = WorkflowRunPage["items"][number]
type WorkflowPreview = Awaited<ReturnType<OperationsApi["agentCapabilities"]["workflowPreview"]>>["data"]
type SkillPage = Awaited<ReturnType<OperationsApi["agentCapabilities"]["skillList"]>>["data"]
type ManagedSkill = SkillPage["items"][number]
type NativeSkill = Awaited<ReturnType<OperationsApi["skills"]["list"]>>["data"][number]
type PluginPage = Awaited<ReturnType<OperationsApi["agentCapabilities"]["pluginList"]>>["data"]
type ManagedPlugin = PluginPage["items"][number]
type PluginInspection = Awaited<ReturnType<OperationsApi["agentCapabilities"]["pluginInspect"]>>["data"]
type PluginCandidate = PluginInspection["candidates"][number]
type PluginReview = ManagedPlugin | PluginCandidate
const freshControlRequestID = () => `cpr_${crypto.randomUUID()}`
export function SessionExtensionControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  sessionID?: string
  disabled?: boolean
}) {
  const t = useControlCenterText()
  const language = useLanguage()
  const copy = (simplifiedChinese: string, english: string) =>
    language.locale() === "zh" || language.locale() === "zht" ? simplifiedChinese : english
  const extensionStatus = (value: string) => {
    const labels: Record<string, readonly [string, string]> = {
      ready: ["可用", "Ready"],
      ok: ["通过", "Passed"],
      safe: ["安全", "Safe"],
      warning: ["需注意", "Needs attention"],
      blocked: ["已阻止", "Blocked"],
      valid: ["有效", "Valid"],
      verified: ["已验证", "Verified"],
      passed: ["已通过", "Passed"],
      unsigned: ["未签名", "Unsigned"],
      untrusted: ["签名不受信任", "Untrusted signature"],
      invalid: ["无效", "Invalid"],
      missing: ["缺失", "Missing"],
      unknown: ["未知", "Unknown"],
    }
    const hit = labels[value]
    return hit ? copy(hit[0], hit[1]) : value.replaceAll("_", " ")
  }
  const extensionSource = (value: string) => {
    const labels: Record<string, readonly [string, string]> = {
      project: ["项目", "Project"],
      workspace: ["工作区", "Workspace"],
      local: ["本机", "Local"],
      global: ["全局", "Global"],
      managed: ["受管", "Managed"],
      builtin: ["内置", "Built-in"],
      profile: ["用户配置", "Profile"],
      external: ["外部来源", "External"],
    }
    const hit = labels[value]
    return hit ? copy(hit[0], hit[1]) : value.replaceAll("_", " ")
  }
  const extensionFinding = (finding: { rule: string; message: string }) => {
    const labels: Record<string, string> = {
      "forbidden-runtime-boundary": "插件尝试访问受保护的运行时边界。",
      "undeclared-egress": "插件包含未在清单中声明的联网访问。",
      "undeclared-secret": "插件包含未在清单中声明的密钥访问。",
      signature: "插件未提供可验证的签名，请确认来源可信。",
      "scan-limit": "插件超出安全扫描限制。",
      "unsafe-path": "插件包中包含不安全的文件路径。",
    }
    return language.locale() === "zh" || language.locale() === "zht"
      ? (labels[finding.rule] ?? finding.message)
      : finding.message
  }
  const extensionProblem = (problem: string) => {
    if (language.locale() !== "zh" && language.locale() !== "zht") return problem
    if (/compatibility\.platforms|current platform/i.test(problem)) return "插件不支持当前操作系统。"
    if (/compatibility\.api_version/i.test(problem)) return "插件接口版本与当前 Arforge 不兼容。"
    if (/entrypoint/i.test(problem)) return "插件入口文件无效或超出插件目录。"
    if (/name must/i.test(problem)) return "插件名称格式无效。"
    if (/version/i.test(problem)) return "插件版本信息无效。"
    return "插件清单未通过验证，请修正后重新检查。"
  }
  const workflowErrorText = (value: string) =>
    sessionExtensionPublicError(
      value,
      copy("工作流执行失败，请检查配置后重试。", "The workflow failed. Check its configuration and try again."),
      language.locale(),
    )
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    error: "",
    notice: "",
    workflows: [] as WorkflowDefinition[],
    workflowRuns: [] as WorkflowRun[],
    preview: undefined as WorkflowPreview | undefined,
    selectedRun: undefined as WorkflowRun | undefined,
    permissionMode: "acceptEdits" as "plan" | "acceptEdits" | "fullAccess",
    maxParallel: 4,
    skills: [] as ManagedSkill[],
    nativeSkills: [] as NativeSkill[],
    plugins: [] as ManagedPlugin[],
    pluginSource: "",
    pluginCandidate: "",
    pluginInspection: undefined as PluginInspection | undefined,
    recoveryID: "",
  })
  const fail = (error: unknown) => {
    setState({
      error: sessionExtensionPublicError(
        error,
        t("Extension management failed. Refresh and try again."),
        language.locale(),
      ),
      notice: "",
    })
  }
  const mutation = async (action: () => Promise<void>, notice: string) => {
    setState({ saving: true, error: "", notice: "" })
    try {
      await action()
      setState("notice", notice)
    } catch (error) {
      fail(error)
    } finally {
      setState("saving", false)
    }
  }
  const refresh = async () => {
    const input = props.location()
    if (!hasOperationDirectory(input)) {
      setState({
        loading: false,
        error: t("Workspace context is still loading. Reopen this panel if the Session was just imported."),
      })
      return
    }
    setState({ loading: true, error: "" })
    try {
      const [workflows, workflowRuns, skills, nativeSkills, plugins] = await Promise.all([
        props.api().agentCapabilities.workflowList(input),
        props.api().agentCapabilities.workflowRunList({
          ...input,
          ...(props.sessionID ? { sessionID: props.sessionID } : {}),
          limit: 50,
        }),
        props.api().agentCapabilities.skillList(input),
        props.api().skills.list(input),
        props.api().agentCapabilities.pluginList(input),
      ])
      setState({
        workflows: [...workflows.data.items],
        workflowRuns: [...workflowRuns.data.items],
        skills: [...skills.data.items],
        nativeSkills: [...nativeSkills.data],
        plugins: [...plugins.data.items],
      })
      if (state.selectedRun) {
        setState(
          "selectedRun",
          workflowRuns.data.items.find((item) => item.run_id === state.selectedRun?.run_id),
        )
      }
    } catch (error) {
      fail(error)
    } finally {
      setState("loading", false)
    }
  }
  const previewWorkflow = (workflow: WorkflowDefinition) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowPreview({
          ...props.location(),
          path: workflow.path,
        })
        setState("preview", result.data)
      },
      t("Validated Workflow {{workflow}}.", { workflow: workflow.name || workflow.path }),
    )
  const startWorkflow = (workflow: WorkflowDefinition) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowStart({
          ...props.location(),
          path: workflow.path,
          ...(props.sessionID ? { sessionID: props.sessionID } : {}),
          permissionMode: state.permissionMode,
          maxParallel: state.maxParallel,
        })
        setState("selectedRun", result.data)
        await refresh()
      },
      t("Started Workflow {{workflow}}.", { workflow: workflow.name || workflow.path }),
    )
  const controlWorkflow = (run: WorkflowRun, action: "pause" | "resume" | "cancel") => {
    const actionLabel = {
      pause: copy("暂停", "pause"),
      resume: copy("继续", "resume"),
      cancel: copy("取消", "cancel"),
    }[action]
    if (action === "cancel" && !window.confirm(t("Cancel Workflow Run {{run}}?", { run: run.run_id })))
      return Promise.resolve()
    return mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowControl({
          ...props.location(),
          runID: run.run_id,
          action,
        })
        setState("selectedRun", result.data)
        await refresh()
      },
      t("Workflow {{action}} request accepted.", { action: actionLabel }),
    )
  }
  const decideWorkflow = (run: WorkflowRun, nodeID: string, approved: boolean) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowApprove({
          ...props.location(),
          runID: run.run_id,
          nodeID,
          approved,
        })
        setState("selectedRun", result.data)
        await refresh()
      },
      approved ? t("Approval recorded.") : t("Rejection recorded."),
    )
  const retryWorkflow = (run: WorkflowRun, nodeID: string) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowRetry({
          ...props.location(),
          runID: run.run_id,
          nodeID,
          includeDescendants: true,
        })
        setState("selectedRun", result.data)
        await refresh()
      },
      t("Retry requested for {{node}} and its descendants.", { node: nodeID }),
    )
  const openWorkflowRun = (run: WorkflowRun) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.workflowRunGet({
          ...props.location(),
          runID: run.run_id,
        })
        setState("selectedRun", result.data)
      },
      t("Loaded current Workflow state for {{run}}.", { run: run.run_id }),
    )
  const setSkillEnabled = (skill: ManagedSkill, enabled: boolean) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.skillSetEnabled({
          ...props.location(),
          skillID: skill.id,
          enabled,
          requestID: freshControlRequestID(),
        })
        setState("skills", [...result.data.skills.items])
      },
      t("{{name}} is now {{state}}.", {
        name: skill.name,
        state: enabled ? t("enabled") : t("disabled"),
      }),
    )
  const refreshSkills = () =>
    mutation(async () => {
      const result = await props.api().agentCapabilities.skillRefresh(props.location())
      setState("skills", [...result.data.items])
    }, t("Skill discovery cache refreshed."))
  const setPluginEnabled = (plugin: ManagedPlugin, enabled: boolean) =>
    mutation(
      async () => {
        const result = await props.api().agentCapabilities.pluginSetEnabled({
          ...props.location(),
          name: plugin.name,
          enabled,
          requestID: freshControlRequestID(),
        })
        setState("plugins", [...result.data.items])
      },
      t("{{name}} is now {{state}}.", {
        name: plugin.name,
        state: enabled ? t("enabled") : t("disabled"),
      }),
    )
  const inspectPlugin = () =>
    mutation(async () => {
      const result = await props.api().agentCapabilities.pluginInspect({
        ...props.location(),
        source: state.pluginSource.trim(),
      })
      setState({
        pluginInspection: result.data,
        pluginCandidate: result.data.candidates.length === 1 ? result.data.candidates[0].name : "",
      })
    }, t("Plugin package inspected. Review the candidate before applying."))
  const applyPlugin = () =>
    mutation(async () => {
      const inspection = state.pluginInspection
      if (!inspection) return
      const result = await props.api().agentCapabilities.pluginApply({
        ...props.location(),
        token: inspection.token,
        name: state.pluginCandidate || undefined,
        replace: state.plugins.some((item) => item.name === state.pluginCandidate),
        requestID: freshControlRequestID(),
      })
      setState({
        plugins: [...result.data.plugins.items],
        pluginInspection: undefined,
        pluginCandidate: "",
        pluginSource: "",
      })
      const recovery = recoveryFrom(result.data.transaction)
      if (recovery) setState("recoveryID", recovery)
    }, t("Plugin transaction completed. New plugins remain disabled until explicitly enabled."))
  const removePlugin = (plugin: ManagedPlugin) => {
    if (
      !window.confirm(
        t("Remove managed Plugin {{name}}? It will be moved to recoverable local trash.", {
          name: plugin.name,
        }),
      )
    ) {
      return Promise.resolve()
    }
    return mutation(
      async () => {
        const result = await props.api().agentCapabilities.pluginRemove({
          ...props.location(),
          name: plugin.name,
          requestID: freshControlRequestID(),
        })
        setState("plugins", [...result.data.plugins.items])
        const recovery = recoveryFrom(result.data.transaction)
        if (recovery) setState("recoveryID", recovery)
      },
      t("{{name}} moved to recoverable local trash.", { name: plugin.name }),
    )
  }
  const restorePlugin = () =>
    mutation(async () => {
      const result = await props.api().agentCapabilities.pluginRestore({
        ...props.location(),
        recoveryID: state.recoveryID.trim(),
        requestID: freshControlRequestID(),
      })
      setState({
        plugins: [...result.data.plugins.items],
        recoveryID: recoveryFrom(result.data.transaction) ?? "",
      })
    }, t("Plugin restored in disabled state."))
  const selectedPluginCandidate = () =>
    state.pluginInspection?.candidates.find((candidate) => candidate.name === state.pluginCandidate)
  createEffect(
    on(
      [() => props.location().location.directory, () => props.location().location.workspace, () => props.sessionID],
      () => {
        if (hasOperationDirectory(props.location())) void refresh()
      },
    ),
  )
  return (
    <section
      class="flex flex-col gap-4 border-t border-border-weak-base pt-5"
      aria-labelledby="operations-extension-title"
      data-testid="extension-management"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="operations-extension-title" class="text-14-medium text-text-strong">
            {t("Workflow, plugin, and skill management")}
          </h2>
          <p class="max-w-3xl text-12-regular text-text-weak">
            {t(
              "One Server API joins the mature runtime registry with Arforge's local managed extensions. Sources remain visible because npm runtime plugins, declarative local plugins, and prompt skills have different safety and lifecycle contracts.",
            )}
          </p>
        </div>
        <Button
          size="small"
          variant="ghost"
          disabled={props.disabled || state.loading || state.saving}
          onClick={refresh}
        >
          {t("Refresh all")}
        </Button>
      </div>

      <Show when={state.error}>
        <p
          class="rounded-md border border-border-warning p-3 text-12-regular text-text-warning"
          role="alert"
          data-testid="extension-management-error"
        >
          {state.error}
        </p>
      </Show>
      <Show when={state.notice}>
        <p class="rounded-md border border-border-success p-3 text-12-regular text-text-success">{state.notice}</p>
      </Show>

      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3" data-testid="workflow-management">
        <div>
          <h3 class="text-12-medium text-text-strong">{t("Validated workflow graphs")}</h3>
          <p class="text-11-regular text-text-weak">
            {t(
              "Definitions are data-only JSON under .arforge/workflows. Preview never calls a model; execution preserves approval gates, dependency ordering, retry state, and bounded parallelism.",
            )}
          </p>
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label class="flex flex-col gap-1 text-11-medium text-text-strong">
            {t("Permission mode")}
            <select
              class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
              value={state.permissionMode}
              disabled={props.disabled || state.saving}
              onChange={(event) =>
                setState("permissionMode", event.currentTarget.value as "plan" | "acceptEdits" | "fullAccess")
              }
            >
              <option value="plan">{t("Plan / read-only")}</option>
              <option value="acceptEdits">{t("Accept edits")}</option>
              <option value="fullAccess">{t("Full access")}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-11-medium text-text-strong">
            {copy("请求的最大并行节点数", "Requested parallel ceiling")}
            <select
              class="min-h-11 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
              value={state.maxParallel}
              disabled={props.disabled || state.saving}
              onChange={(event) => setState("maxParallel", Number(event.currentTarget.value))}
            >
              <For each={[1, 2, 4, 8]}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
            <span class="text-11-regular text-text-weak">{workflowParallelismHelp(language.locale())}</span>
          </label>
        </div>
        <div class="flex flex-col gap-2">
          <For each={state.workflows}>
            {(workflow) => (
              <article
                class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3"
                data-testid="workflow-definition"
              >
                <div class="min-w-0 flex-1">
                  <div class="text-12-medium text-text-strong">{workflow.name || workflow.path}</div>
                  <Show when={workflow.description}>
                    <p class="mt-0.5 line-clamp-2 text-11-regular text-text-base">{workflow.description}</p>
                  </Show>
                  <div class="text-11-regular text-text-weak">
                    {workflow.valid
                      ? `${t("{{nodes}} nodes · {{edges}} edges", {
                          nodes: workflow.nodes ?? 0,
                          edges: workflow.edges ?? 0,
                        })}${workflow.has_approval ? ` ${t("· approval gate")}` : ""}`
                      : workflow.error
                        ? workflowErrorText(workflow.error)
                        : t("Invalid Workflow")}
                  </div>
                  <details class="mt-1 text-11-regular text-text-weak">
                    <summary class="cursor-pointer select-none">{copy("技术详情", "Technical details")}</summary>
                    <div class="mt-1 break-all font-mono">{workflow.path}</div>
                  </details>
                </div>
                <div class="flex gap-2">
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={state.saving}
                    onClick={() => previewWorkflow(workflow)}
                  >
                    {t("Preview")}
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={state.saving || !workflow.valid}
                    onClick={() => startWorkflow(workflow)}
                  >
                    {t("Start")}
                  </Button>
                </div>
              </article>
            )}
          </For>
          <Show when={!state.loading && state.workflows.length === 0}>
            <p class="text-11-regular text-text-weak">{t("No workflow definitions under .arforge/workflows.")}</p>
          </Show>
        </div>
        <Show when={state.preview}>
          {(preview) => (
            <div class="rounded-md border border-border-weak-base p-3" data-testid="workflow-preview">
              <div class="text-12-medium text-text-strong">{preview().name}</div>
              <p class="text-11-regular text-text-weak">
                {copy("预览结果 · 不会调用模型或执行任何步骤", "Preview only · no model calls or steps will run")}
              </p>
              <For each={preview().steps}>
                {(step) => (
                  <div class="mt-2 rounded-md bg-background-weak p-2 text-11-regular">
                    <div class="text-text-strong">{step.title || step.id}</div>
                    <div class="text-text-weak">
                      {workflowNodeKindLabel(preview().node_kinds[step.id] ?? "agent", language.locale())} ·{" "}
                      {workflowRunStatusLabel(step.status, language.locale())}
                    </div>
                    <Show when={step.output}>
                      <div class="mt-1 whitespace-pre-wrap text-text-base">{step.output}</div>
                    </Show>
                    <Show when={step.error}>
                      <div class="mt-1 whitespace-pre-wrap text-text-warning">{workflowErrorText(step.error)}</div>
                    </Show>
                    <details class="mt-2 text-text-weak">
                      <summary class="cursor-pointer select-none">{copy("步骤约束", "Step constraints")}</summary>
                      <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                        <dt>{copy("访问范围", "Access")}</dt>
                        <dd>{workflowAccessLabel(step.access ?? "read", language.locale())}</dd>
                        <dt>{copy("前置条件", "Prerequisites")}</dt>
                        <dd>{workflowDependencyLabel(step.depends_on ?? [], language.locale())}</dd>
                        <dt>{copy("重试次数", "Attempts")}</dt>
                        <dd>{workflowAttemptLabel(0, step.max_attempts ?? 1, language.locale())}</dd>
                        <dt>{copy("失败后继续", "Continue on failure")}</dt>
                        <dd>{step.continue_on_error ? copy("是", "Yes") : copy("否", "No")}</dd>
                        <dt>{copy("执行条件", "Condition")}</dt>
                        <dd class="break-all">{workflowConditionLabel(step.condition, language.locale())}</dd>
                      </dl>
                    </details>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="flex flex-col gap-2" aria-label={copy("工作流运行记录", "Workflow run history")}>
          <For each={state.workflowRuns}>
            {(run) => (
              <button
                type="button"
                class="rounded-md border border-border-weak-base p-3 text-left transition-colors hover:bg-background-weak focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
                disabled={props.disabled || state.saving}
                onClick={() => void openWorkflowRun(run)}
                data-testid="workflow-run"
                aria-label={`${copy("查看工作流运行", "Open workflow run")}：${run.name}，${workflowRunStatusLabel(run.status, language.locale())}`}
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="text-12-medium text-text-strong">{run.name}</div>
                  <span class="rounded-full bg-background-strong px-2 py-0.5 text-11-medium text-text-base">
                    {workflowRunStatusLabel(run.status, language.locale())}
                  </span>
                </div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {workflowProgressLabel(run.progress, language.locale())} · {copy("更新于", "Updated")}{" "}
                  {workflowDateTime(run.updated_at, { locale: language.locale(), intl: language.intl() })}
                </div>
              </button>
            )}
          </For>
          <Show when={!state.loading && state.workflowRuns.length === 0}>
            <p class="text-11-regular text-text-weak">
              {copy("当前会话还没有工作流运行记录。", "This session has no workflow runs yet.")}
            </p>
          </Show>
        </div>
        <Show when={state.selectedRun}>
          {(run) => (
            <div
              class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
              data-testid="workflow-run-detail"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div class="text-12-medium text-text-strong">{run().name}</div>
                  <div class="text-11-regular text-text-weak">
                    {workflowRunStatusLabel(run().status, language.locale())} ·{" "}
                    {workflowProgressLabel(run().progress, language.locale())}
                    <span class="mt-0.5 block">
                      {workflowProgressBreakdownLabel(run().progress.by_status, language.locale())}
                    </span>
                  </div>
                </div>
                <div class="flex gap-2">
                  <Show when={run().status === "running"}>
                    <Button size="small" variant="ghost" onClick={() => controlWorkflow(run(), "pause")}>
                      {t("Pause")}
                    </Button>
                  </Show>
                  <Show when={["paused", "interrupted", "planned"].includes(run().status)}>
                    <Button size="small" variant="secondary" onClick={() => controlWorkflow(run(), "resume")}>
                      {t("Resume")}
                    </Button>
                  </Show>
                  <Show when={!["completed", "failed", "cancelled"].includes(run().status)}>
                    <Button size="small" variant="ghost" onClick={() => controlWorkflow(run(), "cancel")}>
                      {t("Cancel\u2026")}
                    </Button>
                  </Show>
                </div>
              </div>
              <div
                class="h-1.5 overflow-hidden rounded-full bg-background-strong"
                role="progressbar"
                aria-label={copy("工作流进度", "Workflow progress")}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={Math.round(run().progress.percent)}
              >
                <div
                  class="h-full rounded-full bg-icon-interactive-base transition-[width] duration-200"
                  style={{ width: `${run().progress.percent}%` }}
                />
              </div>
              <Show when={run().description}>
                <p class="text-11-regular text-text-base">{run().description}</p>
              </Show>
              <Show when={run().scheduling}>
                {(scheduling) => (
                  <div
                    class="rounded-md border border-border-weak-base bg-background-weak p-3 text-11-regular"
                    data-testid="workflow-scheduling-summary"
                  >
                    <div class="text-text-strong">{workflowSchedulingSummary(scheduling(), language.locale())}</div>
                    <div class="mt-1 text-text-weak">{workflowParallelismLabel(scheduling(), language.locale())}</div>
                  </div>
                )}
              </Show>
              <Show when={run().last_error}>
                <div class="rounded-md border border-border-warning p-2 text-11-regular text-text-warning" role="alert">
                  <div class="font-medium">{copy("最近一次错误", "Latest error")}</div>
                  <div class="mt-0.5 whitespace-pre-wrap">{workflowErrorText(run().last_error)}</div>
                </div>
              </Show>
              <For each={run().nodes}>
                {(node) => (
                  <div class="flex flex-wrap items-start justify-between gap-2 rounded-md bg-background-weak p-3">
                    <div class="min-w-0 flex-1">
                      <div class="text-12-medium text-text-strong">{node.title || node.node_id}</div>
                      <div class="text-11-regular text-text-weak">
                        {workflowNodeKindLabel(node.kind, language.locale())} ·{" "}
                        {workflowNodeSummary({
                          status: node.status,
                          attempt: node.attempt,
                          maxAttempts: node.max_attempts,
                          locale: language.locale(),
                        })}
                      </div>
                      <Show when={node.output}>
                        <div class="mt-1 line-clamp-3 whitespace-pre-wrap text-11-regular text-text-base">
                          {node.output}
                        </div>
                      </Show>
                      <Show when={node.error}>
                        <div class="mt-1 whitespace-pre-wrap text-11-regular text-text-warning">
                          {workflowErrorText(node.error)}
                        </div>
                      </Show>
                      <details class="mt-1 text-11-regular text-text-weak">
                        <summary class="cursor-pointer select-none">{copy("步骤详情", "Step details")}</summary>
                        <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                          <dt>{copy("步骤 ID", "Step ID")}</dt>
                          <dd class="break-all font-mono">{node.node_id}</dd>
                          <dt>{copy("访问范围", "Access")}</dt>
                          <dd>{workflowAccessLabel(node.access, language.locale())}</dd>
                          <dt>{copy("前置条件", "Prerequisites")}</dt>
                          <dd>{workflowDependencyLabel(node.depends_on, language.locale())}</dd>
                          <dt>{copy("失败后继续", "Continue on failure")}</dt>
                          <dd>{node.continue_on_error ? copy("是", "Yes") : copy("否", "No")}</dd>
                          <dt>{copy("执行条件", "Condition")}</dt>
                          <dd class="break-all">{workflowConditionLabel(node.condition, language.locale())}</dd>
                          <dt>{copy("开始时间", "Started")}</dt>
                          <dd>
                            {workflowDateTime(node.started_at, { locale: language.locale(), intl: language.intl() })}
                          </dd>
                          <dt>{copy("结束时间", "Finished")}</dt>
                          <dd>
                            {workflowDateTime(node.finished_at, { locale: language.locale(), intl: language.intl() })}
                          </dd>
                          <Show when={node.budget_reserved_attempts !== undefined}>
                            <dt>{copy("预留尝试预算", "Reserved attempts")}</dt>
                            <dd>{node.budget_reserved_attempts}</dd>
                          </Show>
                          <Show when={node.child_run_id}>
                            <dt>{copy("子运行 ID", "Child run ID")}</dt>
                            <dd class="break-all font-mono">{node.child_run_id}</dd>
                          </Show>
                        </dl>
                      </details>
                    </div>
                    <div class="flex gap-2">
                      <Show when={node.status === "waiting_approval"}>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => decideWorkflow(run(), node.node_id, true)}
                        >
                          {t("Approve")}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => decideWorkflow(run(), node.node_id, false)}>
                          {t("Reject")}
                        </Button>
                      </Show>
                      <Show when={["failed", "blocked", "rejected"].includes(node.status)}>
                        <Button size="small" variant="ghost" onClick={() => retryWorkflow(run(), node.node_id)}>
                          {t("Retry branch")}
                        </Button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
              <details class="text-11-regular text-text-weak">
                <summary class="cursor-pointer select-none">{copy("运行技术详情", "Run technical details")}</summary>
                <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-background-weak p-2">
                  <dt>{copy("运行 ID", "Run ID")}</dt>
                  <dd class="break-all font-mono">{run().run_id}</dd>
                  <dt>{copy("定义文件", "Definition")}</dt>
                  <dd class="break-all font-mono">{run().source_path}</dd>
                  <dt>{copy("权限", "Permission")}</dt>
                  <dd>{workflowPermissionLabel(run().permission_mode, language.locale())}</dd>
                  <dt>{copy("当前并行上限", "Active parallel limit")}</dt>
                  <dd>{run().max_parallel}</dd>
                  <Show when={run().definition_digest}>
                    <dt>{copy("定义摘要", "Definition digest")}</dt>
                    <dd class="break-all font-mono">{run().definition_digest}</dd>
                  </Show>
                  <Show when={run().budget}>
                    {(budget) => (
                      <>
                        <dt>{copy("预算使用", "Budget used")}</dt>
                        <dd>
                          {budget().used_attempts}/{budget().max_attempts} {copy("次尝试", "attempts")}
                        </dd>
                        <dt>{copy("预算预留", "Budget reserved")}</dt>
                        <dd>{budget().reserved_attempts}</dd>
                        <dt>{copy("最长时长", "Max duration")}</dt>
                        <dd>{workflowDurationLabel(budget().max_duration_ms, language.locale())}</dd>
                      </>
                    )}
                  </Show>
                  <Show when={run().scheduling}>
                    {(scheduling) => (
                      <>
                        <dt>{copy("调度决策", "Scheduling decision")}</dt>
                        <dd>{workflowSchedulingActionLabel(scheduling().action, language.locale())}</dd>
                        <dt>{copy("执行模式", "Execution mode")}</dt>
                        <dd>{workflowExecutionModeLabel(scheduling().execute_mode, language.locale())}</dd>
                        <dt>{copy("请求与实际并行", "Requested and active parallelism")}</dt>
                        <dd>{workflowParallelismLabel(scheduling(), language.locale())}</dd>
                        <Show when={scheduling().reasons.length > 0}>
                          <dt>{copy("安全拆分条件", "Safe split conditions")}</dt>
                          <dd>
                            <ul class="list-disc pl-4">
                              <For each={scheduling().reasons}>
                                {(reason) => <li>{workflowSplitReasonLabel(reason, language.locale())}</li>}
                              </For>
                            </ul>
                          </dd>
                        </Show>
                        <Show when={scheduling().failed_checks.length > 0}>
                          <dt>{copy("未通过的门禁", "Checks not passed")}</dt>
                          <dd>
                            <ul class="list-disc pl-4">
                              <For each={scheduling().failed_checks}>
                                {(failure) => <li>{workflowSchedulingFailureLabel(failure, language.locale())}</li>}
                              </For>
                            </ul>
                          </dd>
                        </Show>
                        <dt>{copy("后端决策详情", "Backend decision detail")}</dt>
                        <dd class="break-all">{scheduling().reason}</dd>
                        <Show when={scheduling().policy_revision}>
                          <dt>{copy("策略版本", "Policy revision")}</dt>
                          <dd class="break-all font-mono">{scheduling().policy_revision}</dd>
                        </Show>
                        <Show when={scheduling().evidence_digest}>
                          <dt>{copy("收益证据摘要", "Benefit evidence digest")}</dt>
                          <dd class="break-all font-mono">{scheduling().evidence_digest}</dd>
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={run().verification}>
                    {(verification) => (
                      <>
                        <dt>{copy("完成验证", "Completion verification")}</dt>
                        <dd>{verification().passed ? copy("已通过", "Passed") : copy("未通过", "Failed")}</dd>
                        <dt>{copy("验证检查", "Verification checks")}</dt>
                        <dd>
                          {verification().passed_count}/{verification().total}
                        </dd>
                        <dt>{copy("验证证据摘要", "Verification evidence digest")}</dt>
                        <dd class="break-all font-mono">{verification().evidence_digest}</dd>
                      </>
                    )}
                  </Show>
                  <dt>{copy("开始时间", "Started")}</dt>
                  <dd>{workflowDateTime(run().started_at, { locale: language.locale(), intl: language.intl() })}</dd>
                  <dt>{copy("结束时间", "Finished")}</dt>
                  <dd>{workflowDateTime(run().finished_at, { locale: language.locale(), intl: language.intl() })}</dd>
                </dl>
              </details>
            </div>
          )}
        </Show>
      </div>

      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3" data-testid="managed-skill-center">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-12-medium text-text-strong">{copy("技能中心", "Skill center")}</h3>
            <p class="text-11-regular text-text-weak">
              {copy(
                "你可以在不改动技能文件的情况下启用或停用技能。下方会分别显示可管理技能和当前运行时实际加载的技能。",
                "Enable or disable skills without changing their files. Managed skills and skills currently loaded by the runtime are shown separately.",
              )}
            </p>
          </div>
          <Button size="small" variant="ghost" disabled={state.saving} onClick={refreshSkills}>
            {t("Rescan")}
          </Button>
        </div>
        <For each={state.skills}>
          {(skill) => (
            <article
              class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3"
              data-testid="managed-skill-card"
              data-skill-id={skill.id}
              data-enabled={String(skill.enabled)}
            >
              <div>
                <div class="text-12-medium text-text-strong">{skill.name}</div>
                <div class="text-11-regular text-text-weak">
                  {copy("受管技能", "Managed skill")} · {extensionSource(skill.source)} ·{" "}
                  {skill.problems.length ? skill.problems.join("; ") : skill.description}
                </div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {copy("状态", "Status")}: {skill.enabled ? copy("已启用", "Enabled") : copy("已停用", "Disabled")}
                </div>
              </div>
              <Button
                size="small"
                variant={skill.enabled ? "ghost" : "secondary"}
                disabled={state.saving || skill.problems.length > 0}
                onClick={() => setSkillEnabled(skill, !skill.enabled)}
              >
                {skill.enabled ? copy("停用", "Disable") : copy("启用", "Enable")}
              </Button>
            </article>
          )}
        </For>
        <Show when={state.skills.length === 0}>
          <p class="text-11-regular text-text-weak">{copy("当前没有可管理的技能。", "No managed skills found.")}</p>
        </Show>
        <Show when={state.nativeSkills.length > 0}>
          <div class="text-11-medium text-text-strong">{copy("当前运行时已加载", "Loaded by the current runtime")}</div>
          <div class="flex flex-wrap gap-2">
            <For each={state.nativeSkills}>
              {(skill) => (
                <span class="rounded-md border border-border-weak-base px-2 py-1 text-11-regular text-text-weak">
                  {skill.name}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div
        class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3"
        data-testid="managed-plugin-center"
      >
        <div>
          <h3 class="text-12-medium text-text-strong">{copy("本地插件中心", "Local plugin center")}</h3>
          <p class="text-11-regular text-text-weak">
            {copy(
              "安装分为两步：先检查本地路径或公开 HTTPS 插件包，核对安全结果后再安装。新安装和恢复的插件默认停用。npm 运行时插件仍通过兼容的 arforge plugin 命令安装。",
              "Installation has two steps: inspect a local path or public HTTPS package, then install after reviewing the security result. New and restored plugins start disabled. npm runtime plugins still use the compatible arforge plugin command.",
            )}
          </p>
          <p class="mt-1 text-11-regular text-text-weak">
            {copy(
              "安装、更新、启停、卸载和恢复都会进入控制操作审批，需要你逐次确认。",
              "Install, update, enable, disable, remove, and restore actions enter control approval and require confirmation each time.",
            )}
          </p>
        </div>
        <For each={state.plugins}>
          {(plugin) => (
            <article
              class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3"
              data-testid="managed-plugin-card"
              data-plugin-name={plugin.name}
              data-enabled={String(plugin.enabled)}
            >
              <div>
                <div class="text-12-medium text-text-strong">
                  {plugin.name} {plugin.version}
                </div>
                <div class="text-11-regular text-text-weak">
                  {plugin.managed ? copy("受管插件", "Managed plugin") : copy("工作区 / 外部", "Workspace / external")}{" "}
                  · {plugin.tools.length} {copy("个工具", "tools")}
                </div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {copy("状态", "Status")}: {plugin.enabled ? copy("已启用", "Enabled") : copy("已停用", "Disabled")} ·{" "}
                  {copy("安全检查", "Security")}: {extensionStatus(plugin.security.status)} ·{" "}
                  {copy("签名", "Signature")}: {extensionStatus(plugin.signature.status)} ·{" "}
                  {copy("接口版本", "API version")}: {plugin.compatibility.api_version}
                </div>
                <div class="text-11-regular text-text-weak">
                  {copy("权限", "Permissions")}: {plugin.permissions.length} · {copy("联网目标", "Egress")}:{" "}
                  {plugin.egress.length} · {copy("密钥", "Secrets")}:{plugin.secrets.length} · SHA-256{" "}
                  {plugin.sha256.slice(0, 12)}
                </div>
                <Show when={plugin.security.findings.length > 0}>
                  <ul class="mt-1 list-disc pl-4 text-11-regular text-text-warning" aria-label={t("Security findings")}>
                    <For each={plugin.security.findings}>{(finding) => <li>{extensionFinding(finding)}</li>}</For>
                  </ul>
                </Show>
                <PluginAccessReview
                  plugin={plugin}
                  source={extensionSource(plugin.source)}
                  copy={copy}
                  problemText={extensionProblem}
                />
              </div>
              <div class="flex gap-2">
                <Button
                  size="small"
                  variant={plugin.enabled ? "ghost" : "secondary"}
                  disabled={state.saving || plugin.problems.length > 0}
                  onClick={() => setPluginEnabled(plugin, !plugin.enabled)}
                >
                  {plugin.enabled ? copy("停用", "Disable") : copy("启用", "Enable")}
                </Button>
                <Show when={plugin.managed}>
                  <Button size="small" variant="ghost" disabled={state.saving} onClick={() => removePlugin(plugin)}>
                    {copy("卸载…", "Remove…")}
                  </Button>
                </Show>
              </div>
            </article>
          )}
        </For>
        <Show when={state.plugins.length === 0}>
          <p class="text-11-regular text-text-weak">
            {copy("当前没有已安装的受管插件。", "No managed plugins installed.")}
          </p>
        </Show>
        <TextField
          label={copy("插件来源（本地路径或公开 HTTPS 地址）", "Plugin source (local path or public HTTPS URL)")}
          value={state.pluginSource}
          onChange={(value) =>
            setState({ pluginSource: value, pluginInspection: undefined, pluginCandidate: "" })
          }
          disabled={state.saving}
        />
        <div>
          <Button
            size="small"
            variant="secondary"
            disabled={state.saving || !state.pluginSource.trim()}
            onClick={inspectPlugin}
          >
            {copy("检查插件包", "Inspect package")}
          </Button>
        </div>
        <Show when={state.pluginInspection}>
          {(inspection) => (
            <div
              class="flex flex-col gap-2 rounded-md border border-border-warning p-3"
              data-testid="plugin-inspection"
            >
              <div class="text-12-medium text-text-strong">
                {copy("请核对", "Review")} {inspection().candidates.length}{" "}
                {copy("个候选插件；检查结果将在", "candidate(s); inspection expires in")}{" "}
                {inspection().expires_in_seconds} {copy("秒后失效。", "seconds.")}
              </div>
              <Show when={selectedPluginCandidate()}>
                {(candidate) => (
                  <div class="rounded-md border border-border-weak-base bg-background-weak p-2 text-11-regular text-text-weak">
                    <div>
                      {copy("安全检查", "Security")}: {extensionStatus(candidate().security.status)} ·{" "}
                      {copy("签名", "Signature")}: {extensionStatus(candidate().signature.status)} ·{" "}
                      {copy("接口版本", "API version")}: {candidate().compatibility.api_version}
                    </div>
                    <div>
                      {copy("权限", "Permissions")}: {candidate().permissions.length} · {copy("联网目标", "Egress")}:{" "}
                      {candidate().egress.length} · {copy("密钥", "Secrets")}:{candidate().secrets.length} · SHA-256{" "}
                      {candidate().sha256}
                    </div>
                    <Show when={candidate().security.findings.length > 0}>
                      <ul class="mt-1 list-disc pl-4 text-text-warning" aria-label={t("Security findings")}>
                        <For each={candidate().security.findings}>
                          {(finding) => <li>{extensionFinding(finding)}</li>}
                        </For>
                      </ul>
                    </Show>
                    <PluginAccessReview
                      plugin={candidate()}
                      source={inspection().source}
                      copy={copy}
                      problemText={extensionProblem}
                    />
                  </div>
                )}
              </Show>
              <label class="flex flex-col gap-1 text-11-medium text-text-strong">
                {copy("候选插件", "Candidate")}
                <select
                  class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
                  value={state.pluginCandidate}
                  onChange={(event) => setState("pluginCandidate", event.currentTarget.value)}
                >
                  <option value="">{copy("请选择…", "Select…")}</option>
                  <For each={inspection().candidates}>
                    {(candidate) => (
                      <option value={candidate.name}>
                        {candidate.name} {candidate.version} · {candidate.sha256.slice(0, 12)}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <div>
                <Button
                  size="small"
                  variant="primary"
                  disabled={
                    state.saving ||
                    !state.pluginCandidate ||
                    selectedPluginCandidate()?.security.status === "blocked" ||
                    (selectedPluginCandidate()?.problems.length ?? 0) > 0
                  }
                  onClick={applyPlugin}
                >
                  {copy("安装已检查的插件…", "Install inspected plugin…")}
                </Button>
                <Show
                  when={
                    selectedPluginCandidate()?.security.status === "blocked" ||
                    (selectedPluginCandidate()?.problems.length ?? 0) > 0
                  }
                >
                  <p class="mt-2 text-11-regular text-text-warning">
                    {copy(
                      "安全或兼容性检查已阻止这个候选插件，无法安装。",
                      "Security or compatibility review blocked this candidate, so it cannot be installed.",
                    )}
                  </p>
                </Show>
              </div>
            </div>
          )}
        </Show>
        <div class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]" data-testid="plugin-recovery-control">
          <TextField
            label={copy("恢复编号", "Recovery ID")}
            value={state.recoveryID}
            onChange={(value) => setState("recoveryID", value)}
            disabled={state.saving}
          />
          <div class="flex items-end">
            <Button
              size="small"
              variant="ghost"
              disabled={state.saving || !state.recoveryID.trim()}
              onClick={restorePlugin}
            >
              {copy("恢复", "Restore")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

function PluginAccessReview(props: {
  plugin: PluginReview
  source: string
  copy: (simplifiedChinese: string, english: string) => string
  problemText: (problem: string) => string
}) {
  const none = () => props.copy("无", "None")
  const platforms = () =>
    props.plugin.compatibility.platforms.length > 0
      ? props.plugin.compatibility.platforms.join(", ")
      : props.copy("全部", "All")
  return (
    <details class="mt-2 rounded-md border border-border-weak-base bg-background-base px-2 py-1.5">
      <summary class="min-h-8 cursor-pointer select-none py-1 text-11-medium text-text-strong">
        {props.copy("查看声明的访问范围与兼容性", "Review declared access and compatibility")}
      </summary>
      <div class="flex flex-col gap-2 pb-1 text-11-regular text-text-weak" data-testid="plugin-declared-access">
        <div>
          {props.copy("检查来源", "Inspected source")}: <code class="break-all">{props.source}</code>
        </div>
        <div>
          {props.copy("兼容性", "Compatibility")}: API {props.plugin.compatibility.api_version} ·{" "}
          {props.copy("平台", "Platforms")}: {platforms()} · {props.copy("运行时", "Runtime")}:{" "}
          {props.plugin.compatibility.runtime || props.copy("未限定", "Not restricted")}
        </div>
        <div>
          <div class="text-11-medium text-text-strong">
            {props.copy("权限", "Permissions")} ({props.plugin.permissions.length})
          </div>
          <Show when={props.plugin.permissions.length > 0} fallback={<div>{none()}</div>}>
            <ul class="list-disc pl-4">
              <For each={props.plugin.permissions}>
                {(permission) => (
                  <li>
                    <code>{permission.action}</code>: {permission.resources.join(", ")}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <div>
          <div class="text-11-medium text-text-strong">
            {props.copy("联网目标", "Egress targets")} ({props.plugin.egress.length})
          </div>
          <Show when={props.plugin.egress.length > 0} fallback={<div>{none()}</div>}>
            <ul class="list-disc pl-4">
              <For each={props.plugin.egress}>{(target) => <li class="break-all">{target}</li>}</For>
            </ul>
          </Show>
        </div>
        <div>
          <div class="text-11-medium text-text-strong">
            {props.copy("密钥名称（不显示密钥值）", "Secret names (values are never shown)")} ({props.plugin.secrets.length})
          </div>
          <Show when={props.plugin.secrets.length > 0} fallback={<div>{none()}</div>}>
            <ul class="list-disc pl-4">
              <For each={props.plugin.secrets}>
                {(secret) => (
                  <li>
                    <code>{secret}</code>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <Show when={props.plugin.problems.length > 0}>
          <div class="text-text-warning" role="alert">
            <div class="text-11-medium">
              {props.copy("清单或兼容性问题", "Manifest or compatibility issues")}
            </div>
            <ul class="list-disc pl-4">
              <For each={props.plugin.problems}>{(problem) => <li>{props.problemText(problem)}</li>}</For>
            </ul>
          </div>
        </Show>
      </div>
    </details>
  )
}

function recoveryFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.recovery)) return undefined
  return typeof value.recovery.recovery_id === "string" ? value.recovery.recovery_id : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
