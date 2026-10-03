import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabKey, type Tab } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { usePlatform } from "@/context/platform"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { useTitlebarTabs } from "./titlebar-tabs-controller"
import { useTabShortcut } from "./titlebar-tab-strip"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { useGlobal as useGlobalCtx } from "@/context/global"
import { useServer, ServerConnection as SC } from "@/context/server"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import "./titlebar-vertical-tabs.css"
import { createMediaQuery } from "@solid-primitives/media"
import { SHELL_DRAWER_QUERY } from "@/pages/layout/workspace-shell-state"

function VerticalTabItem(props: {
  tab: Tab
  id: string
  index: () => number
  active: () => boolean
  onNavigate: () => void
  onClose: () => void
  expandedTab: () => string | null
  onExpand: (id: string | null) => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const global = useGlobalCtx()
  const server = useServer()
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")
  const [floatPosition, setFloatPosition] = createSignal({ left: 0, top: 0 })
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  let renameInput!: HTMLInputElement
  let tabButton!: HTMLButtonElement

  const serverCtx = createMemo(() => {
    if (props.tab.type !== "session") return
    const conn = global.servers.list().find((item) => SC.key(item) === props.tab.server)
    if (conn) return global.ensureServerCtx(conn)
  })

  const session = createMemo(() => {
    if (props.tab.type !== "session") return
    const ctx = serverCtx()
    return ctx?.sync.session.peek(props.tab.sessionId)
  })

  const project = createMemo(() => {
    const s = session()
    if (!s) return
    return projectForSession(s, serverCtx()?.projects.list() ?? [])
  })

  const title = createMemo(() => {
    if (props.tab.type === "draft") return language.t("command.session.new")
    return session()?.title ?? language.t("session.tab.unknown")
  })

  const projectName = createMemo(() => {
    const s = session()
    if (!s) return
    return displayName(project() ?? { worktree: s.directory })
  })

  const isExpanded = () => props.expandedTab() === props.id
  const updateFloatPosition = () => {
    if (!tabButton || !isExpanded()) return
    const rect = tabButton.getBoundingClientRect()
    setFloatPosition({ left: rect.right + 8, top: rect.top })
  }
  const copy = createMemo(() => {
    const chinese = language.locale() === "zh" || language.locale() === "zht"
    return chinese
      ? {
          open: "打开",
          closeTab: "关闭标签",
          dismiss: "关闭预览",
          rename: "重命名",
          renameInput: "输入会话名称",
          save: "保存",
          cancel: "取消",
          renameFailed: "重命名失败",
        }
      : {
          open: "Open",
          closeTab: "Close tab",
          dismiss: "Close preview",
          rename: "Rename",
          renameInput: "Enter session name",
          save: "Save",
          cancel: "Cancel",
          renameFailed: "Could not rename the session",
        }
  })

  const handleClick = () => {
    if (sortable.isDragSource()) return
    if (clickTimer) {
      clearTimeout(clickTimer)
      clickTimer = undefined
      // Double click → navigate
      props.onNavigate()
      props.onExpand(null)
      return
    }
    // Single click → show/hide floating panel
    clickTimer = setTimeout(() => {
      clickTimer = undefined
      props.onExpand(isExpanded() ? null : props.id)
    }, 250)
  }

  const closeWithMiddleClick = (event: MouseEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }

  const beginRename = () => {
    const value = session()
    if (!value) return
    setRenameValue(value.title)
    setRenaming(true)
    queueMicrotask(() => {
      renameInput?.focus()
      renameInput?.select()
    })
  }

  const saveRename = async () => {
    const value = session()
    const ctx = serverCtx()
    const next = renameValue().trim()
    if (!value || !ctx || !next) return
    if (next === value.title) {
      setRenaming(false)
      return
    }

    const previous = value.title
    ctx.sync.session.remember({ ...value, title: next })
    setRenaming(false)
    try {
      await ctx.sdk.api.session.rename({ sessionID: value.id, title: next })
    } catch (error) {
      ctx.sync.session.remember({ ...value, title: previous })
      showToast({
        variant: "error",
        title: copy().renameFailed,
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  onCleanup(() => {
    if (clickTimer) clearTimeout(clickTimer)
  })

  createEffect(() => {
    if (!isExpanded()) return
    updateFloatPosition()
    const handleViewportChange = () => updateFloatPosition()
    window.addEventListener("resize", handleViewportChange)
    document.addEventListener("scroll", handleViewportChange, true)
    onCleanup(() => {
      window.removeEventListener("resize", handleViewportChange)
      document.removeEventListener("scroll", handleViewportChange, true)
    })
  })

  useTabShortcut(props.index, props.onNavigate)

  return (
    <div
      ref={sortable.ref}
      data-titlebar-vertical-tab-item
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      data-dragging={sortable.isDragSource()}
      class="relative"
    >
      <button
        type="button"
        ref={tabButton}
        data-titlebar-tab
        data-active={props.active()}
        class="flex h-9 w-full items-center justify-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus"
        onMouseDown={(event) => {
          if (event.button !== 1) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onAuxClick={closeWithMiddleClick}
        onClick={handleClick}
        aria-label={title()}
      >
        <Show
          when={props.tab.type === "session" && session()}
          fallback={
            <span class="flex size-5 items-center justify-center rounded-[4px] border border-v2-border-border-muted">
              <IconV2 name="edit" size="small" class="text-v2-icon-icon-muted" />
            </span>
          }
        >
          {(s) => (
            <SessionTabAvatar
              project={project()}
              directory={s().directory}
              sessionId={s().id}
              server={props.tab.type === "session" ? props.tab.server : server.key}
            />
          )}
        </Show>
      </button>

      {/* Floating panel on click */}
      <Show when={isExpanded()}>
        <Portal>
          <div
            data-vertical-tab-float
            role="dialog"
            aria-label={title()}
            class="fixed z-50 flex min-w-[200px] max-w-[280px] flex-col gap-2 rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3 shadow-[var(--v2-elevation-floating)]"
            style={{ left: `${floatPosition().left}px`, top: `${floatPosition().top}px` }}
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[13px] font-[530] leading-5 text-v2-text-text-base">{title()}</div>
                <Show when={projectName()}>
                  <div class="mt-0.5 truncate text-[11px] leading-4 text-v2-text-text-muted">{projectName()}</div>
                </Show>
              </div>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="shrink-0"
                onClick={() => {
                  setRenaming(false)
                  props.onExpand(null)
                }}
                icon={<IconV2 name="xmark-small" />}
                aria-label={copy().dismiss}
              />
            </div>
            <Show
              when={renaming()}
              fallback={
                <div class="flex gap-2">
                  <button
                    type="button"
                    class="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-v2-icon-icon-accent/10 px-3 text-[12px] font-[530] text-v2-icon-icon-accent transition-colors hover:bg-v2-icon-icon-accent/20"
                    onClick={() => {
                      props.onNavigate()
                      props.onExpand(null)
                    }}
                  >
                    <IconV2 name="edit" size="small" />
                    {copy().open}
                  </button>
                  <Show when={props.tab.type === "session" && session()}>
                    <IconButtonV2
                      type="button"
                      variant="ghost-muted"
                      size="small"
                      onClick={beginRename}
                      icon={<IconV2 name="pencil-line" />}
                      aria-label={copy().rename}
                    />
                  </Show>
                  <button
                    type="button"
                    data-slot="tab-close"
                    class="flex h-7 items-center justify-center rounded-[8px] px-3 text-[12px] font-[530] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                    onClick={() => {
                      props.onClose()
                      props.onExpand(null)
                    }}
                  >
                    {copy().closeTab}
                  </button>
                </div>
              }
            >
              <form
                class="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveRename()
                }}
              >
                <input
                  ref={renameInput}
                  value={renameValue()}
                  onInput={(event) => setRenameValue(event.currentTarget.value)}
                  aria-label={copy().renameInput}
                  class="h-7 min-w-0 flex-1 rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-border-border-focus focus:ring-1 focus:ring-v2-border-border-focus"
                />
                <button
                  type="submit"
                  class="h-7 rounded-[8px] bg-v2-icon-icon-accent/10 px-2.5 text-[12px] font-[530] text-v2-icon-icon-accent transition-colors hover:bg-v2-icon-icon-accent/20"
                >
                  {copy().save}
                </button>
                <button
                  type="button"
                  class="h-7 rounded-[8px] px-2.5 text-[12px] font-[530] text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => setRenaming(false)}
                >
                  {copy().cancel}
                </button>
              </form>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

export function TitlebarVerticalTabs() {
  const platform = usePlatform()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const controller = useTitlebarTabs()
  const desktop = createMemo(() => platform.platform === "desktop")
  const narrow = createMediaQuery(SHELL_DRAWER_QUERY)
  const [expandedTab, setExpandedTab] = createSignal<string | null>(null)
  const sessionsLabel = createMemo(() =>
    language.locale() === "zh" || language.locale() === "zht" ? "会话视图" : "Sessions",
  )

  let listRef!: HTMLDivElement

  // Close floating panel when clicking outside
  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest("[data-titlebar-vertical-tabs]")) {
      setExpandedTab(null)
    }
  }

  createEffect(() => {
    if (expandedTab()) {
      document.addEventListener("click", handleDocumentClick)
      onCleanup(() => document.removeEventListener("click", handleDocumentClick))
    }
  })

  const navigateTab = (tab: Tab) => {
    tabs.select(tab)
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
        data-arforge-material="titlebar"
        class="relative z-10 flex h-full min-h-0 w-[52px] flex-col overflow-visible border-r border-v2-border-border-muted"
      >
        {/* Header: sidebar toggle + new tab */}
        <div data-slot="vertical-tabs-header" class="flex shrink-0 flex-col items-center gap-1 px-1 pt-2 pb-1">
          <TooltipV2 placement="right" value={language.t("command.sidebar.toggle")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="normal"
              class="!size-9 shrink-0"
              icon={<IconV2 name="menu" />}
              onClick={() => narrow() ? layout.mobileSidebar.toggle() : layout.sidebar.toggle()}
              aria-label={language.t("command.sidebar.toggle")}
              aria-controls="workspace-navigation"
              aria-expanded={narrow() ? layout.mobileSidebar.opened() : layout.sidebar.opened()}
            />
          </TooltipV2>
          <TooltipV2 placement="right" value={language.t("command.session.new")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="normal"
              class="!size-9 shrink-0"
              icon={<IconV2 name="plus" />}
              onClick={() => controller.openNewTab()}
              aria-label={language.t("command.session.new")}
            />
          </TooltipV2>
        </div>

        {/* View switch: home / sessions */}
        <div class="flex shrink-0 flex-col items-center gap-1 px-1 pb-2">
          <TooltipV2 placement="right" value={language.t("home.title")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="normal"
              class="!size-9 shrink-0"
              icon={<IconV2 name="grid-plus" />}
              state={layout.route().type === "home" ? "pressed" : undefined}
              onClick={() => {
                if (layout.route().type !== "home") controller.toggleHome()
              }}
              aria-label={language.t("home.title")}
              aria-pressed={layout.route().type === "home"}
            />
          </TooltipV2>
          <TooltipV2 placement="right" value={sessionsLabel()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="normal"
              class="!size-9 shrink-0"
              icon={
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 4.5H13.5M2.5 8H13.5M2.5 11.5H13.5"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              }
              state={layout.route().type !== "home" ? "pressed" : undefined}
              onClick={() => {
                if (layout.route().type === "home") controller.toggleHome()
              }}
              aria-label={sessionsLabel()}
              aria-pressed={layout.route().type !== "home"}
            />
          </TooltipV2>
        </div>

        {/* Session tabs */}
        <div
          data-slot="vertical-tabs-scroll"
          class="min-h-0 flex-1 overflow-y-auto overflow-x-visible no-scrollbar px-1 pb-2"
        >
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
              navigateTab(tab)
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

                  return (
                    <VerticalTabItem
                      tab={tab}
                      id={id}
                      index={index}
                      active={() => controller.currentTab() === tab}
                      onNavigate={() => navigateTab(tab)}
                      onClose={() => closeTab(tab)}
                      expandedTab={expandedTab}
                      onExpand={setExpandedTab}
                    />
                  )
                }}
              </For>
            </div>
          </DragDropProvider>
        </div>
      </div>
    </Show>
  )
}
