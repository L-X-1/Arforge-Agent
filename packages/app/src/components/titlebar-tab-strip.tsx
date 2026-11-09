import { createEffect, createMemo, createResource, createRoot, For, Show, onCleanup, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { preloadNewSessionRoute } from "@/utils/new-session-route"

export function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  serverCtx: () => ServerCtx | undefined
  onNavigate: () => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  let prefetched = false

  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
  })

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class="relative flex"
      classList={{
        hidden: !session() && !missingSession() && !persisted()?.title,
      }}
    >
      <TabNavItem
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={session}
        fallbackTitle={persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined)}
        onTitleChange={(title) => {
          const value = session()
          const ctx = props.serverCtx()
          if (value && ctx) ctx.sync.session.remember({ ...value, title })
        }}
        onTitleChangeFailed={(title) => {
          const value = session()
          const ctx = props.serverCtx()
          if (value && ctx) ctx.sync.session.remember({ ...value, title })
        }}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  onNavigate: () => void
  onClose: () => void
}) {
  const preload = preloadNewSessionRoute()
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      data-tab-kind="draft"
      class="relative flex"
    >
      <DraftTabItem
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => {
          void preload.then(props.onNavigate, props.onNavigate)
        }}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  onNavigate: (tab: Tab) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  newTabAction?: JSX.Element
}) {
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const tabTitle = (tab: Tab) => {
    if (tab.type !== "session") return language.t("command.session.new")
    const conn = global.servers.list().find((value) => ServerConnection.key(value) === tab.server)
    return (
      (conn ? global.ensureServerCtx(conn).sync.session.peek(tab.sessionId)?.title.trim() : undefined) ||
      tabs.info[tabKey(tab)]?.title?.trim() ||
      language.t("session.tab.unknown")
    )
  }
  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let revealFrame: number | undefined
  let dragging = false

  const tabIds = () => props.tabs.map(tabKey)

  function scheduleActiveReveal() {
    if (revealFrame !== undefined) return
    revealFrame = requestAnimationFrame(() => {
      revealFrame = undefined
      if (dragging) return
      const active = listRef?.querySelector<HTMLElement>('[data-titlebar-tab-slot][data-active="true"]')
      if (!active?.getClientRects().length || !scrollRef) return
      const tab = active.getBoundingClientRect()
      const viewport = scrollRef.getBoundingClientRect()
      if (tab.left < viewport.left || tab.right > viewport.right)
        active.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
    })
  }

  const navigate = (tab: Tab) => {
    props.onNavigate(tab)
    scheduleActiveReveal()
  }

  createResizeObserver(() => [scrollRef, listRef], scheduleActiveReveal)

  onCleanup(() => {
    if (revealFrame !== undefined) cancelAnimationFrame(revealFrame)
  })

  createEffect(() => {
    tabIds()
    props.currentTab()
    scheduleActiveReveal()
  })

  return (
    <div data-slot="titlebar-tabs" class="flex min-w-0 flex-1 items-center gap-1">
      <div class="relative flex min-w-0 flex-1">
        <div
          data-slot="titlebar-tabs-scroll"
          class="flex min-w-0 flex-1 items-center overflow-x-auto no-scrollbar"
          ref={scrollRef}
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
            modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragStart={(event) => {
              const source = event.operation.source
              if (!source) return
              const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())
              if (!tab) return
              dragging = true
              navigate(tab)
            }}
            onDragEnd={(event) => {
              dragging = false
              scheduleActiveReveal()
              const current = tabIds()
              const source = event.operation.source
              if (event.canceled || !isSortable(source)) return

              const { initialIndex, index } = source
              if (initialIndex !== index) {
                props.onReorder(arrayMove(current, source.initialIndex, source.index))
              }
            }}
          >
            <div data-titlebar-tab-list class="flex w-max shrink-0 items-center [app-region:no-drag]" ref={listRef}>
              <For each={props.tabs}>
                {(tab, index) => {
                  const id = tabKey(tab)
                  useTabShortcut(index, () => navigate(tab))
                  const serverCtx = createMemo(() => {
                    if (tab.type !== "session") return
                    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                    if (conn) return global.ensureServerCtx(conn)
                  })

                  if (tab.type === "session") {
                    return (
                      <SessionTabSlot
                        tab={tab}
                        id={id}
                        index={index}
                        active={() => props.currentTab() === tab}
                        serverCtx={serverCtx}
                        onNavigate={() => navigate(tab)}
                        onClose={() => props.onClose(tab)}
                      />
                    )
                  }

                  return (
                    <DraftTabSlot
                      tab={tab}
                      id={id}
                      index={index}
                      active={() => props.currentTab() === tab}
                      title={language.t("command.session.new")}
                      onNavigate={() => navigate(tab)}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }}
              </For>
            </div>
          </DragDropProvider>
        </div>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-2.5 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-2.5 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </div>
      <div data-slot="titlebar-tab-actions" class="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        <Show when={props.tabs.length > 1}>
          <MenuV2 placement="bottom-end" gutter={4} modal={false}>
            <MenuV2.Trigger
              as={IconButtonV2}
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="chevron-down" />}
              aria-label={language.locale().startsWith("zh") ? "全部会话标签" : "All session tabs"}
            />
            <MenuV2.Portal>
              <MenuV2.Content>
                <For each={props.tabs}>
                  {(tab) => (
                    <MenuV2.Item
                      onSelect={() => navigate(tab)}
                      classList={{ "bg-v2-background-bg-layer-02": props.currentTab() === tab }}
                    >
                      <span class="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
                      <Show when={props.currentTab() === tab}>
                        <IconV2 name="check" size="small" />
                      </Show>
                    </MenuV2.Item>
                  )}
                </For>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </Show>
        {props.newTabAction}
      </div>
    </div>
  )
}

export function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "标签页",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
