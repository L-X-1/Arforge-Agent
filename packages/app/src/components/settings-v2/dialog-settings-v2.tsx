import { Component, ErrorBoundary, For, Show, Suspense, createSignal, lazy, startTransition } from "solid-js"
import { Dialog } from "@arforge-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { Icon } from "@arforge-ai/ui/icon"
import { ProductDisplayVersion } from "@arforge-ai/core/installation/version"
import { useLanguage } from "@/context/language"
import type { usePermission } from "@/context/permission"
import type { useSync } from "@/context/sync"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import "./management-review.css"
import { ManagementStatus } from "./management-status"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { useControlCenterText } from "../control-center/control-center-text"
import { ARFORGE_SETTINGS_TABS, arforgeSettingsTab, isArforgeSettingsValue } from "../control-center/navigation"
import { useSessionOperationsText } from "../session/session-operations-text"
import {
  SESSION_SETTINGS_TABS,
  isSessionSettingsValue,
  sessionSettingsTab,
} from "../session/session-settings-navigation"
import { onboardingCopy } from "../onboarding/onboarding-copy"

const ArforgeSettingsPanels = lazy(async () => {
  const module = await import("../control-center")
  return { default: module.ArforgeSettingsPanels }
})

const SessionSettingsPanels = lazy(async () => {
  const module = await import("../session/session-operations-dialog")
  return { default: module.SessionSettingsPanels }
})

type SettingsProps = {
  sessionID?: string
  defaultValue?: string
  sync?: ReturnType<typeof useSync>
  permission: ReturnType<typeof usePermission>
}

const SettingsTabs: Component<SettingsProps> = (props) => {
  const language = useLanguage()
  const controlText = useControlCenterText()
  const sessionText = useSessionOperationsText()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  const advancedValues = new Set([
    "arforge-memory",
    "arforge-evolution",
    "arforge-runtime",
    "arforge-extensions",
    "arforge-diagnostics",
    "arforge-operations",
    "arforge-coverage",
    "session-automation",
    "session-team",
    "session-feedback",
  ])
  const [advancedOpen, setAdvancedOpen] = createSignal(true)
  const setCurrentTab = (value: string) => {
    if (advancedValues.has(value)) setAdvancedOpen(true)
    void startTransition(() => setTab(value))
  }
  const primaryArforgeTabs = () => ARFORGE_SETTINGS_TABS.filter((item) => !advancedValues.has(item.value))
  const advancedArforgeTabs = () => ARFORGE_SETTINGS_TABS.filter((item) => advancedValues.has(item.value))
  const primarySessionTabs = () => SESSION_SETTINGS_TABS.filter((item) => !advancedValues.has(item.value))
  const advancedSessionTabs = () => SESSION_SETTINGS_TABS.filter((item) => advancedValues.has(item.value))
  const copy = () => {
    if (language.locale() === "zh") {
      return {
        arforge: "Arforge 工作台",
        session: "当前会话",
        advanced: "高级工具",
        advancedHint: "面向自动化、扩展、诊断和治理场景",
        showAdvanced: "显示高级工具",
        hideAdvanced: "收起高级工具",
        sessionUnavailable: "请先打开会话，再点击会话顶部的“会话控制中心”。",
      }
    }
    if (language.locale() === "zht") {
      return {
        arforge: "Arforge 工作台",
        session: "目前 Session",
        advanced: "進階工具",
        advancedHint: "適用於自動化、擴充、診斷與治理場景",
        showAdvanced: "顯示進階工具",
        hideAdvanced: "收合進階工具",
        sessionUnavailable: "請先開啟 Session，再點擊 Session 頂部的「Session 控制中心」。",
      }
    }
    return {
      arforge: "Arforge workspace",
      session: "Current session",
      advanced: "Advanced tools",
      advancedHint: "Automation, extensions, diagnostics, and governance",
      showAdvanced: "Show advanced tools",
      hideAdvanced: "Hide advanced tools",
      sessionUnavailable: "Open a Session, then choose Session control center in its header.",
    }
  }

  const showProviders = () => {
    void dialog.show(() => (
      <DialogSettings
        sessionID={props.sessionID}
        defaultValue="providers"
        sync={props.sync}
        permission={props.permission}
      />
    ))
  }

  return (
    <TabsV2 orientation="vertical" variant="settings" value={tab()} onChange={setCurrentTab} class="settings-v2">
      <TabsV2.List aria-label={language.t("sidebar.settings")}>
        <div class="settings-v2-nav">
          <div class="settings-v2-nav-heading">
            <h1>{language.t("sidebar.settings")}</h1>
          </div>
          <div class="settings-v2-nav-scroll">
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <TabsV2.Trigger value="general">
                    <Icon name="sliders" />
                    {language.t("settings.tab.general")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="shortcuts">
                    <Icon name="keyboard" />
                    {language.t("settings.tab.shortcuts")}
                  </TabsV2.Trigger>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <TabsV2.Trigger value="servers">
                    <Icon name="server" />
                    {language.t("status.popover.tab.servers")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="providers">
                    <Icon name="providers" />
                    {language.t("settings.providers.title")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="models">
                    <Icon name="models" />
                    {language.t("settings.models.title")}
                  </TabsV2.Trigger>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{copy().arforge}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <For each={primaryArforgeTabs()}>
                    {(item) => (
                      <TabsV2.Trigger value={item.value} title={controlText(item.label)}>
                        <Icon name={item.icon} />
                        {controlText(item.label)}
                      </TabsV2.Trigger>
                    )}
                  </For>
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{copy().session}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <For each={primarySessionTabs()}>
                    {(item) => (
                      <TabsV2.Trigger value={item.value} disabled={!props.sessionID}>
                        <Icon name={item.icon} />
                        {sessionText()[item.label]}
                      </TabsV2.Trigger>
                    )}
                  </For>
                  <Show when={!props.sessionID}>
                    <p class="settings-v2-nav-hint">{copy().sessionUnavailable}</p>
                  </Show>
                </div>
              </div>

              <div class="flex flex-col gap-1.5 border-t border-border-weak-base pt-3">
                <button
                  type="button"
                  class="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-12-medium text-text-strong transition-colors hover:bg-surface-raised-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
                  aria-expanded={advancedOpen()}
                  aria-controls="arforge-advanced-settings"
                  onClick={() => setAdvancedOpen((value) => !value)}
                >
                  <Icon name={advancedOpen() ? "chevron-down" : "chevron-right"} />
                  {advancedOpen() ? copy().hideAdvanced : copy().showAdvanced}
                </button>
                <p class="settings-v2-nav-hint">{copy().advancedHint}</p>
                <Show when={advancedOpen()}>
                  <div id="arforge-advanced-settings" class="flex flex-col gap-3 pt-1">
                    <div class="mx-1 rounded-lg border border-border-weak-base bg-surface-base px-3 py-2.5">
                      <p class="text-11-medium text-text-strong">
                        {onboardingCopy(language.locale()).advancedAudience}
                      </p>
                      <p class="mt-1 text-10-regular leading-4 text-text-weak">
                        {onboardingCopy(language.locale()).advancedHelp}
                      </p>
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <TabsV2.SectionTitle>{copy().advanced}</TabsV2.SectionTitle>
                      <For each={advancedArforgeTabs()}>
                        {(item) => (
                          <TabsV2.Trigger value={item.value} title={controlText(item.label)}>
                            <Icon name={item.icon} />
                            {controlText(item.label)}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                    <div class="flex flex-col gap-1.5">
                      <TabsV2.SectionTitle>{copy().session}</TabsV2.SectionTitle>
                      <For each={advancedSessionTabs()}>
                        {(item) => (
                          <TabsV2.Trigger value={item.value} disabled={!props.sessionID}>
                            <Icon name={item.icon} />
                            {sessionText()[item.label]}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </div>
          <div class="settings-v2-nav-footer">
            <span>{language.t("app.name.desktop")}</span>
            <span>{ProductDisplayVersion}</span>
          </div>
        </div>
      </TabsV2.List>
      <TabsV2.Content value="general" class="settings-v2-panel">
        <SettingsGeneralV2 sessionID={props.sessionID} permission={props.permission} />
      </TabsV2.Content>
      <TabsV2.Content value="shortcuts" class="settings-v2-panel">
        <SettingsKeybinds v2 />
      </TabsV2.Content>
      <TabsV2.Content value="servers" class="settings-v2-panel">
        <SettingsServersV2 />
      </TabsV2.Content>
      <TabsV2.Content value="providers" class="settings-v2-panel">
        <SettingsProvidersV2 onBack={showProviders} />
      </TabsV2.Content>
      <TabsV2.Content value="models" class="settings-v2-panel">
        <SettingsModelsV2 />
      </TabsV2.Content>
      <Show when={isArforgeSettingsValue(tab())}>
        <Suspense
          fallback={
            <TabsV2.Content value={tab()} class="settings-v2-panel">
              <header class="settings-v2-tab-header">
                <h2 class="settings-v2-tab-title">
                  {arforgeSettingsTab(tab()) ? controlText(arforgeSettingsTab(tab())!.label) : "Arforge"}
                </h2>
              </header>
              <div class="settings-v2-tab-body">
                <div class="settings-v2-loading" role="status" aria-live="polite">
                  {controlText("正在解析工作区…")}
                </div>
              </div>
            </TabsV2.Content>
          }
        >
          <ErrorBoundary fallback={(error, reset) => (
            <TabsV2.Content value={tab()} class="settings-v2-panel">
              <div class="settings-v2-tab-body arforge-management-recovery">
                <ManagementStatus error={error} onRetry={reset} />
              </div>
            </TabsV2.Content>
          )}>
            <ArforgeSettingsPanels value={tab()} sessionID={props.sessionID} onNavigate={setCurrentTab} />
          </ErrorBoundary>
        </Suspense>
      </Show>
      <Show when={isSessionSettingsValue(tab())}>
        <Suspense
          fallback={
            <TabsV2.Content value={tab()} class="settings-v2-panel">
              <header class="settings-v2-tab-header">
                <h2 class="settings-v2-tab-title">
                  {sessionSettingsTab(tab()) ? sessionText()[sessionSettingsTab(tab())!.label] : "Session"}
                </h2>
              </header>
              <div class="settings-v2-tab-body">
                <div class="settings-v2-loading" role="status" aria-live="polite">
                  {sessionText().loading}
                </div>
              </div>
            </TabsV2.Content>
          }
        >
          <Show
            when={props.sessionID}
            fallback={
              <TabsV2.Content value={tab()} class="settings-v2-panel">
                <header class="settings-v2-tab-header">
                  <h2 class="settings-v2-tab-title">Session</h2>
                </header>
                <div class="settings-v2-tab-body">
                  <p class="settings-v2-empty-state" role="status">
                    {language.locale() === "zh"
                      ? "请先打开一个会话，再管理它的目标、任务、定时安排和检查点。"
                      : language.locale() === "zht"
                        ? "請先開啟一個 Session，再管理它的目標、任務、排程與檢查點。"
                        : "Open a Session before managing its Goals, Tasks, schedules, or Checkpoints."}
                  </p>
                </div>
              </TabsV2.Content>
            }
          >
            {(sessionID) => (
              <ErrorBoundary fallback={(error, reset) => (
                <TabsV2.Content value={tab()} class="settings-v2-panel">
                  <div class="settings-v2-tab-body arforge-management-recovery">
                    <ManagementStatus error={error} onRetry={reset} />
                  </div>
                </TabsV2.Content>
              )}>
                <SessionSettingsPanels value={tab()} sessionID={sessionID()} sync={props.sync} />
              </ErrorBoundary>
            )}
          </Show>
        </Suspense>
      </Show>
    </TabsV2>
  )
}

export const DialogSettings: Component<SettingsProps> = (props) => (
  <Dialog size="x-large" variant="settings" class="settings-v2-dialog settings-v2-surface">
    <SettingsTabs {...props} />
  </Dialog>
)

// The settings route is a real workspace page. It shares the same tabs and
// panels as the modal entry point, but does not create a fixed dialog layer.
export const SettingsWorkspace: Component<SettingsProps> = (props) => (
  <div
    data-component="settings-workspace"
    data-arforge-material="dialog"
    class="settings-v2-workspace settings-v2-surface"
  >
    <SettingsTabs {...props} />
  </div>
)
