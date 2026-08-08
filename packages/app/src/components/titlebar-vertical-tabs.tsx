import { createMemo, For, Show } from "solid-js"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabKey, type Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useTabs } from "@/context/tabs"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { usePlatform } from "@/context/platform"
import { useTitlebarTabs } from "./titlebar-tabs-controller"
import { DraftTabSlot, SessionTabSlot, useTabShortcut } from "./titlebar-tab-strip"
import "./titlebar-vertical-tabs.css"

const COLLAPSE_KEY = "arforge.vertical-tabs.collapsed.v1"

export function TitlebarVerticalTabs() {
  const platform = usePlatform()
  const language = useLanguage()
  const tabs = useTabs()
  const global = useGlobal()
  const controller = useTitlebarTabs()
  const desktop = createMemo(() => platform.platform === "desktop")
  const collapsed = createMemo(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1"
    } catch {
      return false
    }
  })
  const setCollapsed = (value: boolean) => {
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0")
    } catch {}
  }
  let listRef!: HTMLDivElement

  const navigateTab = (tab: Tab, el?: HTMLDivElement) => {
    tabs.select(tab)
    el?.scrollIntoView({ behavior: "instant", block: "nearest" })
  }

  const closeTab = (tab: Tab) => {
    const index = tabs.store.findIndex((item) => tabKey(item) === tabKey(tab))
    if (index !== -1) tabs.closeTab(index)
  }

  const tabIds = () => tabs.store.map(tabKey)

  return (
    <Show when={desktop()}>
      <div
        data-titlebar-vertical-tabs
        data-collapsed={collapsed()}
        data-arforge-material="titlebar"
        class="relative z-10 flex h-full min-h-0 flex-col overflow-hidden border-r border-v2-border-border-muted transition-[width] duration-240 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width: collapsed() ? "52px" : "208px" }}
      >
        <div data-slot="vertical-tabs-header" class="flex h-11 shrink-0 items-center justify-between pl-3 pr-1.5">
          <Show when={!collapsed()}>
            <span
              data-slot="vertical-tabs-header-label"
              class="truncate text-[13px] font-[530] leading-5 text-v2-text-text-base"
            >
              {language.t("command.category.session")}
            </span>
          </Show>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            class="shrink-0"
            onClick={() => setCollapsed(!collapsed())}
            aria-label={
              collapsed() ? language.t("command.tab.expand") : language.t("command.tab.collapse")
            }
            icon={
              collapsed() ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6.5 4L10.5 8L6.5 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M9.5 4L5.5 8L9.5 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              )
            }
          />
        </div>

        <div data-slot="vertical-tabs-scroll" class="min-h-0 flex-1 overflow-y-auto no-scrollbar px-2 pb-2">
          <DragDropProvider
            sensors={[
              PointerSensor.configure({
                activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                preventActivation: (event) =>
                  !canStartTabDrag(event.pointerType) ||
                  isTabCloseTarget(event.target) ||
                  (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
              }),
            ]}
            modifiers={[RestrictToVerticalAxis, RestrictToElement.configure({ element: () => listRef })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0, y: 0.05 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragStart={(event) => {
              const source = event.operation.source
              if (!source) return
              const tab = tabs.store.find((item) => tabKey(item) === source.id.toString())
              if (!tab) return
              const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
              navigateTab(tab, tabEl ?? undefined)
            }}
            onDragEnd={(event) => {
              const current = tabIds()
              const source = event.operation.source
              if (event.canceled || !isSortable(source)) return

              const { initialIndex, index } = source
              if (initialIndex !== index) {
                tabs.reorder(arrayMove(current, source.initialIndex, source.index))
              }
            }}
          >
            <div data-titlebar-vertical-tab-list class="flex flex-col items-stretch gap-1" ref={listRef}>
              <For each={tabs.store}>
                {(tab, index) => {
                  const id = tabKey(tab)
                  let ref!: HTMLDivElement
                  useTabShortcut(index, () => navigateTab(tab, ref))
                  const serverCtx = createMemo(() => {
                    if (tab.type !== "session") return
                    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                    if (conn) return global.ensureServerCtx(conn)
                  })

                  if (tab.type === "session") {
                    return (
                      <SessionTabSlot
                        vertical
                        tab={tab}
                        id={id}
                        index={index}
                        active={() => controller.currentTab() === tab}
                        forceTruncate
                        serverCtx={serverCtx}
                        onNavigate={(element) => {
                          ref = element
                          navigateTab(tab, element)
                        }}
                        onClose={() => closeTab(tab)}
                      />
                    )
                  }

                  return (
                    <DraftTabSlot
                      vertical
                      tab={tab}
                      id={id}
                      index={index}
                      active={() => controller.currentTab() === tab}
                      title={language.t("command.session.new")}
                      onNavigate={(element) => {
                        ref = element
                        navigateTab(tab, element)
                      }}
                      onClose={() => closeTab(tab)}
                    />
                  )
                }}
              </For>
            </div>
          </DragDropProvider>
        </div>

        <div data-slot="vertical-tabs-footer" class="shrink-0 border-t border-v2-border-border-muted p-2">
          <button
            type="button"
            data-slot="vertical-tabs-new"
            class="flex h-9 w-full items-center justify-center gap-2 rounded-[10px] text-[13px] font-[530] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus"
            onClick={() => controller.openNewTab()}
            aria-label={language.t("command.session.new")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-linecap="round" />
            </svg>
            <Show when={!collapsed()}>
              <span data-slot="vertical-tabs-new-label">{language.t("command.session.new")}</span>
            </Show>
          </button>
        </div>
      </div>
    </Show>
  )
}
