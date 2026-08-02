import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { For, Show, createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"
import { hasOperationDirectory } from "./session-operation-boundary"
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
export function SessionExtensionControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  sessionID?: string
  disabled?: boolean
}) {
  const t = useControlCenterText()
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
    setState({ error: publicError(error, t("Extension management failed. Refresh and try again.")), notice: "" })
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
      t("Workflow {{action}} request accepted.", { action }),
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
        pluginCandidate: result.data.candidates.length === 1 ? result.data.candidates[0]!.name : "",
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
      })
      setState({
        plugins: [...result.data.plugins.items],
        pluginInspection: undefined,
        pluginCandidate: "",
        pluginSource: "",
      })
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
      })
      setState({ plugins: [...result.data.plugins.items], recoveryID: "" })
    }, t("Plugin restored in disabled state."))
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
        <p class="rounded-md border border-border-warning p-3 text-12-regular text-text-warning">{state.error}</p>
      </Show>
      <Show when={state.notice}>
        <p class="rounded-md border border-border-success p-3 text-12-regular text-text-success">{state.notice}</p>
      </Show>

      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
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
              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
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
            {t("Maximum parallel nodes")}
            <select
              class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
              value={state.maxParallel}
              disabled={props.disabled || state.saving}
              onChange={(event) => setState("maxParallel", Number(event.currentTarget.value))}
            >
              <For each={[1, 2, 4, 8]}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </label>
        </div>
        <div class="flex flex-col gap-2">
          <For each={state.workflows}>
            {(workflow) => (
              <article class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3">
                <div class="min-w-0">
                  <div class="text-12-medium text-text-strong">{workflow.name || workflow.path}</div>
                  <div class="text-11-regular text-text-weak">
                    {workflow.valid
                      ? `${t("{{nodes}} nodes · {{edges}} edges", {
                          nodes: workflow.nodes ?? 0,
                          edges: workflow.edges ?? 0,
                        })}${workflow.has_approval ? ` ${t("· approval gate")}` : ""}`
                      : workflow.error || t("Invalid Workflow")}
                  </div>
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
            <div class="rounded-md border border-border-weak-base p-3">
              <div class="text-12-medium text-text-strong">
                {preview().name}
                {t("preview")}
              </div>
              <For each={preview().steps}>
                {(step) => (
                  <div class="text-11-regular text-text-weak">
                    {step.id} · {step.status} · {step.output}
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="flex flex-col gap-2">
          <For each={state.workflowRuns}>
            {(run) => (
              <button
                type="button"
                class="rounded-md border border-border-weak-base p-3 text-left"
                disabled={props.disabled || state.saving}
                onClick={() => void openWorkflowRun(run)}
              >
                <div class="text-12-medium text-text-strong">{run.name}</div>
                <div class="text-11-regular text-text-weak">
                  {run.status} · {run.progress.percent}
                  {t("% \u00B7")}
                  {run.run_id}
                </div>
              </button>
            )}
          </For>
        </div>
        <Show when={state.selectedRun}>
          {(run) => (
            <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-12-medium text-text-strong">
                  {run().name} · {run().status}
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
              <For each={run().nodes}>
                {(node) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-weak p-2">
                    <div class="text-11-regular text-text-weak">
                      {node.node_id} · {node.kind} · {node.status}
                      {t("\u00B7 attempt")}
                      {node.attempt}/{node.max_attempts}
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
            </div>
          )}
        </Show>
      </div>

      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="text-12-medium text-text-strong">{t("Skills")}</h3>
            <p class="text-11-regular text-text-weak">
              {t(
                "Managed skills can be enabled or disabled without changing files. Runtime-loaded skills are shown separately so effective model context is visible.",
              )}
            </p>
          </div>
          <Button size="small" variant="ghost" disabled={state.saving} onClick={refreshSkills}>
            {t("Rescan")}
          </Button>
        </div>
        <For each={state.skills}>
          {(skill) => (
            <article class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3">
              <div>
                <div class="text-12-medium text-text-strong">{skill.name}</div>
                <div class="text-11-regular text-text-weak">
                  {t("managed \u00B7")}
                  {skill.source} · {skill.problems.length ? skill.problems.join("; ") : skill.description}
                </div>
              </div>
              <Button
                size="small"
                variant={skill.enabled ? "ghost" : "secondary"}
                disabled={state.saving || skill.problems.length > 0}
                onClick={() => setSkillEnabled(skill, !skill.enabled)}
              >
                {skill.enabled ? "Disable" : "Enable"}
              </Button>
            </article>
          )}
        </For>
        <Show when={state.nativeSkills.length > 0}>
          <div class="text-11-medium text-text-strong">{t("Effective mature runtime registry")}</div>
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

      <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
        <div>
          <h3 class="text-12-medium text-text-strong">{t("Local declarative plugins")}</h3>
          <p class="text-11-regular text-text-weak">
            {t(
              "Installation is two-phase: inspect a local path or public HTTPS package, then explicitly apply. Installed plugins start disabled. npm runtime plugins continue to use the compatible `arforge plugin` CLI installer.",
            )}
          </p>
        </div>
        <For each={state.plugins}>
          {(plugin) => (
            <article class="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background-weak p-3">
              <div>
                <div class="text-12-medium text-text-strong">
                  {plugin.name} {plugin.version}
                </div>
                <div class="text-11-regular text-text-weak">
                  {plugin.managed ? t("managed profile") : "workspace/external"} · {plugin.tools.length}
                  {t("tools")}
                  {plugin.problems.length ? ` · ${plugin.problems.join("; ")}` : ""}
                </div>
              </div>
              <div class="flex gap-2">
                <Button
                  size="small"
                  variant={plugin.enabled ? "ghost" : "secondary"}
                  disabled={state.saving || plugin.problems.length > 0}
                  onClick={() => setPluginEnabled(plugin, !plugin.enabled)}
                >
                  {plugin.enabled ? t("disabled") : t("enabled")}
                </Button>
                <Show when={plugin.managed}>
                  <Button size="small" variant="ghost" disabled={state.saving} onClick={() => removePlugin(plugin)}>
                    {t("Remove\u2026")}
                  </Button>
                </Show>
              </div>
            </article>
          )}
        </For>
        <TextField
          label={t("Plugin source (local path or public HTTPS URL)")}
          value={state.pluginSource}
          onChange={(value) => setState("pluginSource", value)}
          disabled={state.saving}
        />
        <div>
          <Button
            size="small"
            variant="secondary"
            disabled={state.saving || !state.pluginSource.trim()}
            onClick={inspectPlugin}
          >
            {t("Inspect package")}
          </Button>
        </div>
        <Show when={state.pluginInspection}>
          {(inspection) => (
            <div class="flex flex-col gap-2 rounded-md border border-border-warning p-3">
              <div class="text-12-medium text-text-strong">
                {t("Review")}
                {inspection().candidates.length}
                {t("candidate(s); inspection expires in")} {inspection().expires_in_seconds}
                {t("seconds.")}
              </div>
              <label class="flex flex-col gap-1 text-11-medium text-text-strong">
                {t("Candidate")}
                <select
                  class="h-8 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular"
                  value={state.pluginCandidate}
                  onChange={(event) => setState("pluginCandidate", event.currentTarget.value)}
                >
                  <option value="">{t("Select\u2026")}</option>
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
                  disabled={state.saving || !state.pluginCandidate}
                  onClick={applyPlugin}
                >
                  {t("Apply inspected plugin\u2026")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <div class="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
          <TextField
            label={t("Recovery ID")}
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
              {t("Restore")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
function recoveryFrom(value: unknown) {
  if (!isRecord(value) || !isRecord(value.recovery)) return
  return typeof value.recovery.recovery_id === "string" ? value.recovery.recovery_id : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function publicError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error.message === "string") return error.message
  return fallback
}
