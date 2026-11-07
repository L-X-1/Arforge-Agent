import { Component, ErrorBoundary, For, Show, Suspense, createEffect, createUniqueId, lazy, on, onCleanup, onMount, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
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
import { ARFORGE_SETTINGS_GROUPS, ARFORGE_SETTINGS_TABS, arforgeSettingsTab, isArforgeSettingsValue } from "../control-center/navigation"
import { useSessionOperationsText } from "../session/session-operations-text"
import {
  SESSION_SETTINGS_TABS,
  isSessionSettingsValue,
  sessionSettingsTab,
} from "../session/session-settings-navigation"
import { onboardingCopy } from "../onboarding/onboarding-copy"
import { settingsTabValue } from "./navigation"

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
  onReturnToWorkspace?: () => void
  onTabChange?: (value: string) => void
}

const SettingsTabs: Component<SettingsProps> = (props) => {
  const language = useLanguage()
  const controlText = useControlCenterText()
  const sessionText = useSessionOperationsText()
  const dialog = useDialog()
  const [state, setState] = createStore({ tab: settingsTabValue(props.defaultValue), compact: false, navigationOpen: false })
  createEffect(on(() => props.defaultValue, value => setState("tab", settingsTabValue(value)), { defer: true }))
  const tab = () => state.tab
  const navID = createUniqueId()
  let root!: HTMLDivElement
  let navigationToggle!: HTMLButtonElement
  onMount(() => {
    const resize = () => {
      const compact = root.getBoundingClientRect().width < 640
      if (compact === state.compact) return
      const active = root.ownerDocument.activeElement
      const inNavigation = active instanceof Element && !!active.closest(".settings-v2-nav-list")
      setState({ compact, navigationOpen: false })
      if (compact && inNavigation) navigationToggle.focus({ preventScroll: true })
      if (!compact && active === navigationToggle)
        root.querySelector<HTMLButtonElement>('[data-slot="tabs-v2-trigger"][data-selected]')?.focus({ preventScroll: true })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  const setCurrentTab = (value: string) => {
    setState("navigationOpen", false)
    if (state.compact) navigationToggle.focus({ preventScroll: true })
    void startTransition(() => {
      setState("tab", value)
      props.onTabChange?.(value)
    }).then(() => requestAnimationFrame(() => {
      if (!root.isConnected || !state.compact || state.navigationOpen || state.tab !== value) return
      const active = root.ownerDocument.activeElement
      // The tab primitive may focus its trigger after onChange returns.
      // Once the compact list is hidden, restore that focus to its toggle;
      // a later interaction with the content keeps its own focus.
      if (active === root.ownerDocument.body || active === root.ownerDocument.documentElement ||
          (active instanceof Element && active.closest(".settings-v2-nav-list")))
        navigationToggle.focus({ preventScroll: true })
    }))
  }
  const groupedTabs = (id: string) => {
    const values: readonly string[] = ARFORGE_SETTINGS_GROUPS.find(group => group.id === id)?.values ?? []
    return ARFORGE_SETTINGS_TABS.filter(item => values.includes(item.value))
  }
  const groupLabel = (id: string) => {
    const labels: Record<string, readonly [string, string, string]> = {
      basic: ["基础", "基礎", "Basics"], connections: ["连接", "連線", "Connections"],
      agent: ["Agent 能力", "Agent 能力", "Agent capabilities"], security: ["安全", "安全", "Security"],
      data: ["数据", "資料", "Data"], navigation: ["设置导航", "設定導覽", "Settings navigation"],
    }
    return labels[id]?.[language.locale() === "zh" ? 0 : language.locale() === "zht" ? 1 : 2] ?? id
  }
  const copy = () => {
    if (language.locale() === "zh") {
      return {
        returnToWorkspace: "返回工作区",
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
        returnToWorkspace: "返回工作區",
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
      returnToWorkspace: "Back to workspace",
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
    <TabsV2 ref={root} orientation="vertical" variant="settings" value={tab()} onChange={setCurrentTab}
      class="settings-v2" data-compact={state.compact} data-navigation-open={state.navigationOpen}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape" || !state.compact || !state.navigationOpen) return
        event.preventDefault()
        event.stopPropagation()
        setState("navigationOpen", false)
        navigationToggle.focus({ preventScroll: true })
      }}>
      <button ref={navigationToggle} type="button" class="settings-v2-navigation-toggle"
        aria-expanded={state.navigationOpen} aria-controls={navID}
        onClick={() => {
          setState("navigationOpen", !state.navigationOpen)
          if (state.navigationOpen) queueMicrotask(() => root.querySelector<HTMLButtonElement>('[data-slot="tabs-v2-trigger"][data-selected]')?.focus({ preventScroll: true }))
        }}>
        <Icon name={state.navigationOpen ? "close" : "menu"} /><span>{groupLabel("navigation")}</span>
      </button>
      <TabsV2.List id={navID} class="settings-v2-nav-list" aria-label={language.t("sidebar.settings")}
        hidden={state.compact && !state.navigationOpen}>
        <div class="settings-v2-nav">
          <div class="settings-v2-nav-heading">
            <button
              type="button"
              class="settings-v2-return"
              onClick={() => {
                if (props.onReturnToWorkspace) props.onReturnToWorkspace()
                else dialog.close()
              }}
            >
              <Icon name="arrow-left" />
              <span>{copy().returnToWorkspace}</span>
            </button>
            <h1>{language.t("sidebar.settings")}</h1>
          </div>
          <div class="settings-v2-nav-scroll">
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{groupLabel("basic")}</TabsV2.SectionTitle>
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
                <TabsV2.SectionTitle>{groupLabel("connections")}</TabsV2.SectionTitle>
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
                  <For each={groupedTabs("connections")}>
                    {(item) => <TabsV2.Trigger value={item.value} title={controlText(item.label)}>
                      <Icon name={item.icon} />{controlText(item.label)}
                    </TabsV2.Trigger>}
                  </For>
                </div>
              </div>

              <For each={["agent", "security", "data"]}>{(group) => (
                <div class="flex flex-col gap-1.5" data-settings-group={group}>
                  <TabsV2.SectionTitle>{groupLabel(group)}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <For each={groupedTabs(group)}>{(item) => (
                      <TabsV2.Trigger value={item.value} title={controlText(item.label)}>
                        <Icon name={item.icon} />{controlText(item.label)}
                      </TabsV2.Trigger>
                    )}</For>
                  </div>
                </div>
              )}</For>

              <div class="flex flex-col gap-1.5">
                <TabsV2.SectionTitle>{copy().session}</TabsV2.SectionTitle>
                <div class="flex flex-col gap-1.5 w-full">
                  <For each={SESSION_SETTINGS_TABS}>
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
                <details class="settings-v2-nav-help">
                  <summary>{copy().advanced}</summary>
                  <p class="settings-v2-nav-hint">{copy().advancedHint}</p>
                    <div class="settings-v2-nav-hint">
                      <p class="text-11-medium text-text-strong">
                        {onboardingCopy(language.locale()).advancedAudience}
                      </p>
                      <p class="mt-1 text-10-regular leading-4 text-text-weak">
                        {onboardingCopy(language.locale()).advancedHelp}
                      </p>
                    </div>
                </details>
              </div>
            </div>
          </div>
          <div class="settings-v2-nav-footer">
            <span>{language.t("app.name.desktop")}</span>
            <span>{ProductDisplayVersion}</span>
          </div>
        </div>
      </TabsV2.List>
      <div class="settings-v2-main" inert={state.compact && state.navigationOpen} aria-hidden={state.compact && state.navigationOpen ? "true" : undefined}>
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
        <SettingsProvidersV2 onBack={showProviders} onNavigate={setCurrentTab} />
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
                <ManagementStatus loading initialLoading />
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
                <ManagementStatus loading initialLoading />
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
      </div>
    </TabsV2>
  )
}

export const DialogSettings: Component<SettingsProps> = (props) => (
  <Dialog size="x-large" variant="settings" class="settings-v2-dialog settings-v2-surface" containerClass="settings-v2-dialog-container">
    <SettingsTabs {...props} />
  </Dialog>
)

// The settings route is a real workspace page. It shares the same tabs and
// panels as the modal entry point, but does not create a fixed dialog layer.
export const SettingsWorkspace: Component<SettingsProps> = (props) => (
  <div
    data-component="settings-workspace"
    data-settings-navigation="dedicated"
    data-arforge-material="dialog"
    class="settings-v2-workspace settings-v2-surface"
  >
    <SettingsTabs {...props} />
  </div>
)
