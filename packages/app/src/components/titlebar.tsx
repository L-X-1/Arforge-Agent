import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  onMount,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { Icon } from "@arforge-ai/ui/icon"
import { Button } from "@arforge-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@arforge-ai/ui/tooltip"
import { useTheme } from "@arforge-ai/ui/theme/context"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { KeybindV2 } from "@arforge-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"

import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { WebSessionActionsMenu } from "./web-session-actions"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "@/components/titlebar-tab-strip"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt"
import "./titlebar.css"
import { SHELL_DRAWER_QUERY } from "@/pages/layout/workspace-shell-state"
import { newTabTooltipKeybind } from "./command-tooltip-keybind"
import { useTitlebarTabs } from "./titlebar-tabs-controller"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()
const legacyTitlebarHeight = 44
const v2TitlebarHeight = 44
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function useTitlebarRightMount() {
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  onMount(() => setMount(document.getElementById("arforge-titlebar-right")))
  return mount
}

export function useTitlebarSessionMount() {
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  onMount(() => {
    const find = () => {
      const element = document.getElementById("arforge-titlebar-session-toolbar")
      if (element) setMount(element)
      return !!element
    }
    if (find()) return
    const observer = new MutationObserver(() => {
      if (find()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })
  return mount
}

export function Titlebar(props: { update?: TitlebarUpdate; debugTools?: { visible: boolean; toggle: () => void } }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const theme = useTheme()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())
  const mobile = createMediaQuery("(max-width: 767px)")
  const narrow = createMediaQuery(SHELL_DRAWER_QUERY)
  const bottom = createMemo(() => useV2Titlebar() && mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = useV2Titlebar() ? v2TitlebarHeight : legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft" || route.type === "dir-new-sesssion") return true
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))
  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable=''], [data-titlebar-tab-slot]"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      data-slot={useV2Titlebar() ? "titlebar-v2" : undefined}
      data-arforge-material="titlebar"
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-11 overflow-visible": useV2Titlebar(),
        "h-11 overflow-hidden": !useV2Titlebar(),
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": mac()
          ? `${Math.max(0, 84 / zoom() - (useV2Titlebar() && !narrow() && !location.pathname.startsWith("/settings") ? (layout.sidebar.opened() ? layout.sidebar.width() : 52) : 0))}px`
          : 0,
        width: electronWindows()
          ? useV2Titlebar()
            ? `calc(100% - ${windowsControlsWidth()})`
            : `min(100%, env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()})))`
          : undefined,
        "max-width": electronWindows()
          ? useV2Titlebar()
            ? `calc(100% - ${windowsControlsWidth()})`
            : `min(100%, env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()})))`
          : undefined,
        "align-self": electronWindows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      <Switch>
        <Match when={useV2Titlebar()}>
          {(_) => {
            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const { currentTab, openNewTab } = useTitlebarTabs()

            return (
              <div
                data-component="workspace-titlebar-content"
                class="h-full min-w-0 flex-1 flex flex-row items-center gap-2 px-3"
              >
                <Show when={narrow()}>
                  <TooltipV2 placement="bottom" value={language.t("command.sidebar.toggle")}>
                    <IconButtonV2
                      type="button"
                      data-action="workspace-sidebar-toggle"
                      variant="ghost-muted"
                      size="large"
                      class="shrink-0"
                      icon={<IconV2 name="menu" />}
                      onClick={() => (narrow() ? layout.mobileSidebar.toggle() : layout.sidebar.toggle())}
                      aria-label={language.t("command.sidebar.toggle")}
                      aria-controls="workspace-navigation"
                      aria-expanded={narrow() ? layout.mobileSidebar.opened() : layout.sidebar.opened()}
                    />
                  </TooltipV2>
                </Show>
                <Show when={(windows() || linux()) && (narrow() || !layout.sidebar.opened())}>
                  <WindowsAppMenu command={command} platform={platform} variant="brand" />
                </Show>
                <TitlebarTabStrip
                  tabs={tabsStore}
                  currentTab={currentTab}
                  onNavigate={(tab) => tabs.select(tab)}
                  onClose={(tab) => {
                    const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                    if (index !== -1) tabsStoreActions.closeTab(index)
                  }}
                  onReorder={(keys) => tabsStoreActions.reorder(keys)}
                  newTabAction={
                    <Show when={!creating() && (tabsStore.length > 1 || narrow() || !layout.sidebar.opened())}>
                      <TooltipV2
                        placement="bottom"
                        value={
                          <>
                            {language.t("command.session.new")}
                            <KeybindV2 keys={newTabTooltipKeybind(command)} variant="neutral" />
                          </>
                        }
                      >
                        <IconButtonV2
                          type="button"
                          variant="ghost-muted"
                          size="small"
                          icon={<IconV2 name="plus" />}
                          onClick={openNewTab}
                          aria-label={language.t("command.session.new")}
                        />
                      </TooltipV2>
                    </Show>
                  }
                />
                <Show when={narrow() || !layout.sidebar.opened()}>
                  <TooltipV2 placement="bottom" value={language.t("controlCenter.m001")}>
                    <IconButtonV2
                      type="button"
                      variant="ghost-muted"
                      size="large"
                      class="shrink-0"
                      icon={<IconV2 name="settings-gear" />}
                      onClick={() => command.trigger("control-center.open")}
                      data-action="workspace-settings"
                      aria-label={language.t("controlCenter.m001")}
                    />
                  </TooltipV2>
                </Show>
                <TitlebarV2Right state={v2RightState()} />
                <Show when={windows() && !electronWindows()}>
                  <div data-tauri-decorum-tb class="flex flex-row" />
                </Show>
              </div>
            )
          }}
        </Match>
        <Match when>
          <div
            class="grid h-full min-h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
            style={{ zoom: counterZoom() }}
          >
            <div
              classList={{
                "flex items-center min-w-0": true,
                "pl-2": !mac(),
              }}
            >
              <Show when={windows() || linux()}>
                <WindowsAppMenu command={command} platform={platform} />
              </Show>
              <Show when={mac()}>
                {/*<div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />*/}
                <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <Show when={!mac()}>
                <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <div class="flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
                <div class="hidden xl:flex items-center shrink-0">
                  <Show when={params.dir}>
                    <div
                      class="flex items-center shrink-0 w-8 mr-1"
                      aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                    >
                      <div
                        class="transition-opacity"
                        classList={{
                          "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                          "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                        }}
                      >
                        <TooltipKeybind
                          placement="bottom"
                          title={language.t("command.session.new")}
                          keybind={command.keybind("session.new")}
                          openDelay={800}
                        >
                          <Button
                            variant="ghost"
                            class="titlebar-icon w-8 h-6 p-0 box-border"
                            disabled={layout.sidebar.opened()}
                            tabIndex={layout.sidebar.opened() ? -1 : undefined}
                            onClick={() => {
                              if (!params.dir) return
                              navigate(`/${params.dir}/session`)
                            }}
                            aria-label={language.t("command.session.new")}
                            aria-current={creating() ? "page" : undefined}
                          >
                            <IconV2 name="edit" size="small" />
                          </Button>
                        </TooltipKeybind>
                      </div>
                    </div>
                  </Show>
                  <div
                    class="flex items-center shrink-0"
                    classList={{
                      "-translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                      "duration-180 ease-out": !layout.sidebar.opened(),
                      "duration-180 ease-in": layout.sidebar.opened(),
                    }}
                  >
                    <Show when={hasProjects() && nav()}>
                      <div class="flex items-center gap-0 transition-transform">
                        <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-left"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canBack()}
                            onClick={back}
                            aria-label={language.t("common.goBack")}
                          />
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-right"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canForward()}
                            onClick={forward}
                            aria-label={language.t("common.goForward")}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                    <div id="arforge-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                  </div>
                </div>
                <ChannelIndicator debugTools={props.debugTools} />
              </div>
            </div>

            <div class="min-w-0 flex items-center justify-center pointer-events-none">
              <div
                id="arforge-titlebar-center"
                class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full"
              />
            </div>

            <div
              classList={{
                "flex items-center min-w-0 justify-end": true,
                "pr-2": !windows(),
              }}
              data-tauri-drag-region
              onMouseDown={drag}
            >
              <div id="arforge-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
              <Show when={windows()}>
                {!tauriApi() && <div class="shrink-0" style={{ width: windowsControlsWidth() }} />}
                <div data-tauri-decorum-tb class="flex flex-row" />
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="arforge-titlebar-session-toolbar" class="flex min-w-0 shrink-0 items-center" />
      <div id="arforge-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
      <WebSessionActionsMenu />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        class="absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out group-hover:w-[68px] group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:w-[68px] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

function ChannelIndicator(props: { debugTools?: { visible: boolean; toggle: () => void } }) {
  const channel = import.meta.env.VITE_ARFORGE_CHANNEL
  if (channel === "dev" && props.debugTools) {
    return (
      <button
        type="button"
        class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono cursor-pointer"
        onClick={props.debugTools.toggle}
        aria-label="切换性能诊断"
        aria-pressed={props.debugTools.visible}
      >
        TEST
      </button>
    )
  }

  const label = channel === "dev" ? "TEST" : channel?.toUpperCase()
  return (
    <>
      {channel && ["beta", "dev"].includes(channel) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">{label}</div>
      )}
    </>
  )
}
