import { Component, For, Show, Suspense, createSignal, lazy, startTransition } from "solid-js"
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

const ArforgeSettingsPanels = lazy(async () => {
  const module = await import("../control-center")
  return { default: module.ArforgeSettingsPanels }
})

const SessionSettingsPanels = lazy(async () => {
  const module = await import("../session/session-operations-dialog")
  return { default: module.SessionSettingsPanels }
})

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
  sync?: ReturnType<typeof useSync>
  permission: ReturnType<typeof usePermission>
}> = (props) => {
  const language = useLanguage()
  const controlText = useControlCenterText()
  const sessionText = useSessionOperationsText()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  const setCurrentTab = (value: string) => void startTransition(() => setTab(value))

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
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2 orientation="vertical" variant="settings" value={tab()} onChange={setCurrentTab} class="settings-v2">
        <TabsV2.List>
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
                  <TabsV2.SectionTitle>Arforge</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <For each={ARFORGE_SETTINGS_TABS}>
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
                  <TabsV2.SectionTitle>Session</TabsV2.SectionTitle>
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
                      <p class="settings-v2-nav-hint">
                        {language.locale() === "zh"
                          ? "打开一个会话后可用"
                          : language.locale() === "zht"
                            ? "開啟一個 Session 後可用"
                            : "Available inside an open Session"}
                      </p>
                    </Show>
                  </div>
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
            <ArforgeSettingsPanels value={tab()} sessionID={props.sessionID} onNavigate={setCurrentTab} />
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
                        ? "请先打开一个会话，再管理它的 Goal、Task、计划和 Checkpoint。"
                        : language.locale() === "zht"
                          ? "請先開啟一個 Session，再管理它的 Goal、Task、排程與 Checkpoint。"
                          : "Open a Session before managing its Goals, Tasks, schedules, or Checkpoints."}
                    </p>
                  </div>
                </TabsV2.Content>
              }
            >
              {(sessionID) => <SessionSettingsPanels value={tab()} sessionID={sessionID()} sync={props.sync} />}
            </Show>
          </Suspense>
        </Show>
      </TabsV2>
    </Dialog>
  )
}
