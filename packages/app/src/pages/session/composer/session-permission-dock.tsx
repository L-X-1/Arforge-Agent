import { For, Show } from "solid-js"
import type { PermissionRequest } from "@arforge-ai/sdk/v2"
import { Button } from "@arforge-ai/ui/button"
import { DockPrompt } from "@arforge-ai/session-ui/dock-prompt"
import { Icon } from "@arforge-ai/ui/icon"
import { useLanguage } from "@/context/language"

type TrustedConfirmationRequest = PermissionRequest & { readonly requiresHumanConfirmation?: boolean }
type DelegatedTaskCapability = {
  readonly action: string
  readonly resources: readonly string[]
  readonly access: "read" | "write"
}
type DelegatedTaskBudget = {
  readonly maxAttempts: number
  readonly maxDurationMs: number
  readonly maxCostMicros: number
  readonly maxTokens: number
}

export function requiresHumanConfirmation(request: PermissionRequest) {
  return (request as TrustedConfirmationRequest).requiresHumanConfirmation === true
}

function opaqueDirectShellDetails(request: PermissionRequest) {
  if (request.metadata?.scope !== "opaque-user-shell") return
  return {
    cwd: typeof request.metadata.cwd === "string" ? request.metadata.cwd : undefined,
    shell: typeof request.metadata.shell === "string" ? request.metadata.shell : undefined,
  }
}

export function delegatedTaskDetails(request: PermissionRequest) {
  if (request.permission !== "task") return
  const metadata = request.metadata
  const mode = metadata?.capability_mode
  const raw = metadata?.capabilities
  if ((mode !== "default-read-only" && mode !== "explicit") || !Array.isArray(raw) || raw.length === 0) return
  if (raw.length > 64) return

  const capabilities: DelegatedTaskCapability[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return
    const candidate = item as Record<string, unknown>
    if (typeof candidate.action !== "string" || candidate.action.length === 0 || candidate.action.length > 256)
      return
    if (candidate.access !== "read" && candidate.access !== "write") return
    if (!Array.isArray(candidate.resources) || candidate.resources.length === 0 || candidate.resources.length > 128)
      return
    if (
      !candidate.resources.every(
        (resource) => typeof resource === "string" && resource.length > 0 && resource.length <= 1_024,
      )
    )
      return
    capabilities.push({
      action: candidate.action,
      access: candidate.access,
      resources: candidate.resources as string[],
    })
  }

  const budgetMode = metadata?.budget_mode
  let budget: DelegatedTaskBudget | undefined
  if (budgetMode === "durable") {
    const rawBudget = metadata?.budget
    if (!rawBudget || typeof rawBudget !== "object" || Array.isArray(rawBudget)) return
    const candidate = rawBudget as Record<string, unknown>
    const values = [candidate.maxAttempts, candidate.maxDurationMs, candidate.maxCostMicros, candidate.maxTokens]
    if (!values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) return
    budget = {
      maxAttempts: candidate.maxAttempts as number,
      maxDurationMs: candidate.maxDurationMs as number,
      maxCostMicros: candidate.maxCostMicros as number,
      maxTokens: candidate.maxTokens as number,
    }
  } else if (budgetMode !== "legacy-unmetered" && budgetMode !== undefined) {
    return
  }

  return {
    mode,
    capabilities,
    writeCapable: capabilities.some((capability) => capability.access === "write"),
    budgetMode,
    budget,
  } as const
}

const taskBudgetSummary = (budget: DelegatedTaskBudget) => ({
  attempts: budget.maxAttempts.toLocaleString(),
  duration: Math.ceil(budget.maxDurationMs / 60_000).toLocaleString(),
  cost: `$${(budget.maxCostMicros / 1_000_000).toFixed(2)}`,
  tokens: budget.maxTokens.toLocaleString(),
})

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const humanConfirmation = () => requiresHumanConfirmation(props.request)
  const directShell = () => opaqueDirectShellDetails(props.request)
  const taskDelegation = () => delegatedTaskDetails(props.request)

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={!humanConfirmation()}>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {language.t("ui.permission.allowAlways")}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={humanConfirmation()}>
        <div data-slot="permission-row" data-variant="human-confirmation">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{language.t("ui.permission.humanConfirmation")}</div>
        </div>
      </Show>

      <Show when={directShell()} keyed>
        {(details) => (
          <div data-slot="permission-row" data-variant="opaque-direct-shell">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">
              <div>{language.t("ui.permission.opaqueShell.summary")}</div>
              <Show when={details.cwd}>
                {(cwd) => <div>{language.t("ui.permission.opaqueShell.cwd", { cwd: cwd() })}</div>}
              </Show>
              <Show when={details.shell}>
                {(shell) => <div>{language.t("ui.permission.opaqueShell.shell", { shell: shell() })}</div>}
              </Show>
              <div>{language.t("ui.permission.opaqueShell.environment")}</div>
            </div>
          </div>
        )}
      </Show>

      <Show when={taskDelegation()} keyed>
        {(details) => (
          <div data-slot="permission-row" data-variant="task-delegation">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint" class="flex min-w-0 flex-col gap-2">
              <div class="text-12-medium text-text-strong">{language.t("ui.permission.taskCapabilities.title")}</div>
              <div class={details.writeCapable ? "text-text-warning" : "text-text-weak"}>
                {details.writeCapable
                  ? language.t("ui.permission.taskCapabilities.writeWarning")
                  : details.mode === "default-read-only"
                    ? language.t("ui.permission.taskCapabilities.defaultReadOnly")
                    : language.t("ui.permission.taskCapabilities.readOnly")}
              </div>
              <ul class="flex flex-col gap-1">
                <For each={details.capabilities}>
                  {(capability) => (
                    <li class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-10-medium uppercase text-text-weak">
                          {language.t(`ui.permission.taskCapabilities.access.${capability.access}`)}
                        </span>
                        <code class="break-all text-11-regular text-text-base">{capability.action}</code>
                      </div>
                      <div class="mt-1 break-all text-10-regular text-text-weak">
                        {language.t("ui.permission.taskCapabilities.resources", {
                          resources: capability.resources.join(", "),
                        })}
                      </div>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={details.budget} keyed>
                {(budget) => (
                  <div class="rounded-md border border-border-weak-base bg-background-base px-2 py-1.5">
                    <div class="text-10-medium uppercase text-text-weak">
                      {language.t("ui.permission.taskBudget.title")}
                    </div>
                    <div class="mt-1 text-11-regular text-text-base">
                      {language.t("ui.permission.taskBudget.summary", taskBudgetSummary(budget))}
                    </div>
                    <div class="mt-1 text-10-regular text-text-weak">
                      {language.t("ui.permission.taskBudget.enforced")}
                    </div>
                  </div>
                )}
              </Show>
              <Show when={details.budgetMode === "legacy-unmetered"}>
                <div class="text-text-warning">{language.t("ui.permission.taskBudget.legacyWarning")}</div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
