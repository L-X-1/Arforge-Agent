import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import createPresence from "solid-presence"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { getFilename } from "@arforge-ai/core/util/path"
import { Button } from "@arforge-ai/ui/button"
import { Collapsible } from "@arforge-ai/ui/collapsible"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { Icon } from "@arforge-ai/ui/icon"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { Spinner } from "@arforge-ai/ui/spinner"
import { Tooltip } from "@arforge-ai/ui/tooltip"
import { type Session } from "@arforge-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { sortedRootSessions } from "./helpers"
import { resolveSessionListPresentation } from "./sidebar-status"
import { workspaceRevealDelta } from "./workspace-scroll"
import { createSidebarScrollbarController } from "./sidebar-scrollbar"
import "./sidebar-scrollbar.css"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  sidebarExpanded: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (project: string, directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (project: string, directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  registerScrollContainer: (el: HTMLDivElement) => () => void
  preserveScrollAnchor: () => void
  suppressScrollAnchor: () => void
}

export const WorkspaceDragOverlay = (props: {
  sidebarProject: Accessor<LocalProject | undefined>
  activeWorkspace: Accessor<string | undefined>
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const label = createMemo(() => {
    const project = props.sidebarProject()
    if (!project) return
    const directory = props.activeWorkspace()
    if (!directory) return

    const [workspaceStore] = serverSync().child(directory, { bootstrap: false })
    const kind =
      directory === project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.workspaceLabel(directory, workspaceStore.vcs?.branch, project.id)
    return `${kind} : ${name}`
  })

  return (
    <Show when={label()}>
      {(value) => <div class="bg-background-base rounded-md px-2 py-1 text-14-medium text-text-strong">{value()}</div>}
    </Show>
  )
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" size="small" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <div class="flex min-w-0 flex-1 flex-col justify-center">
      <div data-sidebar-workspace-primary class="min-w-0 text-text-strong">
        <Show
          when={!props.local()}
          fallback={
            <span class="block min-w-0 truncate text-14-medium">{props.branch() ?? getFilename(props.directory)}</span>
          }
        >
          <props.InlineEditor
            id={`workspace:${props.directory}`}
            value={props.workspaceValue}
            onSave={(next) => {
              const trimmed = next.trim()
              if (!trimmed) return
              props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
              props.setEditor("value", props.workspaceValue())
            }}
            class="w-full min-w-0 truncate text-14-medium"
            displayClass="block w-full min-w-0 truncate text-14-medium"
            editing={props.workspaceEditActive()}
            stopPropagation={false}
            openOnDblClick={false}
          />
        </Show>
      </div>
      <span data-sidebar-workspace-secondary class="block min-w-0 truncate text-12-regular text-text-weak">
        {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")}
      </span>
    </div>
    <div
      data-sidebar-workspace-disclosure-slot
      class="pointer-events-none absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center"
    >
      <div data-sidebar-workspace-disclosure data-open={props.open()} class="flex size-6 items-center justify-center">
        <Icon name="chevron-right" size="small" class="text-icon-base" />
      </div>
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  sidebarHovering: Accessor<boolean>
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  clearHoverProjectSoon: WorkspaceSidebarContext["clearHoverProjectSoon"]
  navigateToNewSession: () => void
}): JSX.Element => (
  <div
    data-sidebar-workspace-actions
    data-menu-open={props.menuOpen()}
    class="absolute right-8 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5"
  >
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButtonV2
          icon={<IconV2 name="edit" size="small" />}
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.clearHoverProjectSoon()
            props.navigateToNewSession()
          }}
        />
      </Tooltip>
    </Show>
    <DropdownMenu
      modal={!props.sidebarHovering()}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
      placement="bottom-end"
      gutter={8}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="size-6 rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-sidebar-workspace-menu
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            data-sidebar-workspace-destructive
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  </div>
)

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  mobile?: boolean
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  loadFailed: Accessor<boolean>
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  retryLoad: () => Promise<void>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
  nested?: boolean
}): JSX.Element => {
  const [state, setState] = createStore<{
    loadingMore: boolean
    loadMoreFailed: boolean
    retryingInitial: boolean
    skeletonElement?: HTMLDivElement
  }>({
    loadingMore: false,
    loadMoreFailed: false,
    retryingInitial: false,
  })
  const presentation = () =>
    resolveSessionListPresentation({
      status: props.loading() ? "loading" : props.loadFailed() ? "error" : "ready",
      retrying: state.retryingInitial,
      count: props.sessions().length,
    })
  const showSkeleton = () => presentation() === "loading"
  const skeletonPresence = createPresence({
    show: showSkeleton,
    element: () => state.skeletonElement ?? null,
  })
  const retryInitial = async () => {
    if (state.retryingInitial) return
    setState("retryingInitial", true)
    try {
      await props.retryLoad()
    } finally {
      setState("retryingInitial", false)
    }
  }
  const loadMore = async (event: MouseEvent) => {
    if (state.loadingMore) return
    const target = event.currentTarget as HTMLButtonElement
    setState("loadMoreFailed", false)
    setState("loadingMore", true)
    target.blur()
    try {
      await props.loadMore()
    } catch {
      setState("loadMoreFailed", true)
    } finally {
      setState("loadingMore", false)
    }
  }

  return (
    <nav class="flex flex-col gap-1">
      <Show when={props.showNew()}>
        <NewSessionItem
          slug={props.slug()}
          mobile={props.mobile}
          baseIndent={props.nested ? 12 : undefined}
          leadingSize={props.nested ? 16 : undefined}
          sidebarExpanded={props.ctx.sidebarExpanded}
          clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
        />
      </Show>
      <div data-sidebar-session-stage>
        <Show when={skeletonPresence.present()}>
          <div
            ref={(element) => setState("skeletonElement", element)}
            data-sidebar-session-skeleton-layer
            data-visible={showSkeleton()}
          >
            <SessionSkeleton baseIndent={props.nested ? 12 : undefined} />
          </div>
        </Show>
        <div data-sidebar-session-results data-visible={!showSkeleton()} class="flex min-w-0 flex-col gap-1">
          <For each={props.sessions()}>
            {(session) => (
              <SessionItem
                session={session}
                list={props.sessions()}
                navList={props.ctx.navList}
                slug={props.slug()}
                mobile={props.mobile}
                showChild
                baseIndent={props.nested ? 12 : undefined}
                sidebarExpanded={props.ctx.sidebarExpanded}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                prefetchSession={props.ctx.prefetchSession}
                archiveSession={props.ctx.archiveSession}
              />
            )}
          </For>
          <Show when={presentation() === "error" || presentation() === "retrying"}>
            <Button
              data-sidebar-session-load-failure
              variant="ghost"
              class="flex w-full text-left justify-start pr-3 text-12-regular text-text-weak"
              style={{ "padding-left": `${props.nested ? 36 : 32}px` }}
              size="large"
              disabled={state.retryingInitial}
              aria-busy={state.retryingInitial}
              data-failed={!state.retryingInitial}
              onClick={retryInitial}
            >
              <span
                data-sidebar-session-initial-status-lane
                aria-hidden="true"
                style={{ left: `${props.nested ? 12 : 8}px` }}
              >
                <Show when={state.retryingInitial} fallback={<span data-sidebar-session-status="error" />}>
                  <Spinner class="size-3" />
                </Show>
              </span>
              <span aria-live="polite">
                {state.retryingInitial
                  ? `${props.language.t("common.loading")}${props.language.t("common.loading.ellipsis")}`
                  : props.language.t("common.loadMoreFailedRetry")}
              </span>
            </Button>
          </Show>
          <Show when={presentation() === "empty"}>
            <p
              data-sidebar-session-empty
              role="status"
              class="min-w-0 truncate pr-3 text-12-regular text-text-weak"
              style={{ "padding-left": `${props.nested ? 36 : 32}px` }}
            >
              {props.language.t("sidebar.session.empty")}
            </p>
          </Show>
        </div>
      </div>
      <Show when={props.hasMore()}>
        <div class="relative w-full py-1">
          <Button
            data-sidebar-load-more
            variant="ghost"
            class="flex w-full text-left justify-start text-14-regular text-text-weak pr-10"
            style={{ "padding-left": `${props.nested ? 36 : 32}px` }}
            size="large"
            disabled={state.loadingMore}
            aria-busy={state.loadingMore}
            data-failed={state.loadMoreFailed}
            onClick={loadMore}
          >
            <Show when={state.loadingMore}>
              <span data-sidebar-load-more-spinner aria-hidden="true" style={{ left: `${props.nested ? 14 : 10}px` }}>
                <Spinner class="size-3" />
              </span>
            </Show>
            <Show when={state.loadMoreFailed && !state.loadingMore}>
              <span data-sidebar-load-more-error aria-hidden="true" style={{ left: `${props.nested ? 15 : 11}px` }} />
            </Show>
            <span aria-live="polite">
              {state.loadingMore
                ? `${props.language.t("common.loading")}${props.language.t("common.loading.ellipsis")}`
                : state.loadMoreFailed
                  ? props.language.t("common.loadMoreFailedRetry")
                  : props.language.t("common.loadMore")}
            </span>
          </Button>
        </div>
      </Show>
    </nav>
  )
}

export const SortableWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  directory: string
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
}): JSX.Element => {
  const navigate = useNavigate()
  const params = useParams()
  const serverSync = useServerSync()
  const language = useLanguage()
  const sortable = createSortable(props.directory)
  const [workspaceStore, setWorkspaceStore] = serverSync().child(props.directory, { bootstrap: false })
  const [menu, setMenu] = createStore({
    open: false,
    pendingRename: false,
  })
  const slug = createMemo(() => base64Encode(props.directory))
  const sessions = createMemo(() => {
    const now = props.sortNow()
    props.ctx.preserveScrollAnchor()
    return sortedRootSessions(workspaceStore, now)
  })
  const local = createMemo(() => props.directory === props.project.worktree)
  const active = createMemo(() => pathKey(props.ctx.currentDir()) === pathKey(props.directory))
  const workspaceValue = createMemo(() => {
    const branch = workspaceStore.vcs?.branch
    const name = branch ?? getFilename(props.directory)
    return props.ctx.workspaceName(props.directory, props.project.id, branch) ?? name
  })
  const open = createMemo(() => props.ctx.workspaceExpanded(props.project.worktree, props.directory, local()))
  const boot = createMemo(() => open() || active())
  const count = createMemo(() => sessions()?.length ?? 0)
  const hasMore = createMemo(() => workspaceStore.sessionTotal > count())
  const busy = createMemo(() => props.ctx.isBusy(props.directory))
  const loading = () => workspaceStore.session_list_status === "loading" && count() === 0
  const loadFailed = () => workspaceStore.session_list_status === "error" && count() === 0
  const touch = createMediaQuery("(hover: none), (pointer: coarse)")
  const showNew = createMemo(() => !loading() && (touch() || count() === 0 || (active() && !params.id)))
  const retryLoad = () => serverSync().project.loadSessions(props.directory)
  const loadMore = async () => {
    setWorkspaceStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.directory)
    if (workspaceStore.session_list_status === "error") throw new Error("Failed to load sessions")
  }

  const workspaceEditActive = createMemo(() => props.ctx.editorOpen(`workspace:${props.directory}`))
  let workspaceElement: HTMLDivElement | undefined
  let workspaceContent: HTMLDivElement | undefined
  let revealFrame: number | undefined

  const cancelWorkspaceReveal = () => {
    if (revealFrame === undefined) return
    window.cancelAnimationFrame(revealFrame)
    revealFrame = undefined
  }

  const queueWorkspaceReveal = () => {
    cancelWorkspaceReveal()
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = undefined
      if (!open()) return
      const workspace = workspaceElement
      const content = workspaceContent
      if (!workspace || !content) return
      const container = workspace.closest("[data-sidebar-workspace-scroll]") as HTMLDivElement | null
      const header = workspace.querySelector<HTMLElement>("[data-sidebar-workspace-header]")
      if (!container || !header) return

      const rows = content.querySelectorAll<HTMLElement>(
        [
          "[data-sidebar-session-row]",
          "[data-sidebar-session-skeleton-row]",
          "[data-sidebar-session-empty]",
          "[data-sidebar-session-load-failure]",
        ].join(","),
      )
      const target = rows.item(rows.length - 1)
      if (!target) return

      const containerRect = container.getBoundingClientRect()
      const delta = workspaceRevealDelta({
        containerTop: containerRect.top,
        containerBottom: containerRect.bottom,
        headerTop: header.getBoundingClientRect().top,
        targetBottom: target.getBoundingClientRect().bottom,
        inset: 8,
      })
      if (delta <= 0) return
      container.scrollBy({
        top: delta,
        left: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      })
    })
  }

  onCleanup(cancelWorkspaceReveal)
  const header = () => (
    <WorkspaceHeader
      local={local}
      busy={busy}
      open={open}
      directory={props.directory}
      language={language}
      branch={() => workspaceStore.vcs?.branch}
      workspaceValue={workspaceValue}
      workspaceEditActive={workspaceEditActive}
      InlineEditor={props.ctx.InlineEditor}
      renameWorkspace={props.ctx.renameWorkspace}
      setEditor={props.ctx.setEditor}
      projectId={props.project.id}
    />
  )

  const openWrapper = (value: boolean) => {
    props.ctx.suppressScrollAnchor()
    props.ctx.setWorkspaceExpanded(props.project.worktree, props.directory, value)
    if (value) {
      queueWorkspaceReveal()
      return
    }
    cancelWorkspaceReveal()
    if (props.ctx.editorOpen(`workspace:${props.directory}`)) props.ctx.closeEditor()
  }

  let wasActive = false
  createEffect(() => {
    const next = active()
    if (next && !wasActive) {
      props.ctx.setWorkspaceExpanded(props.project.worktree, props.directory, true)
    }
    wasActive = next
  })

  createEffect(() => {
    if (!boot()) return
    serverSync().child(props.directory, { bootstrap: true })
  })

  return (
    <div
      ref={(element) => {
        workspaceElement = element
      }}
      // @ts-ignore
      use:sortable
      classList={{
        "opacity-30": sortable.isActiveDraggable,
        "opacity-50 pointer-events-none": busy(),
      }}
    >
      <Collapsible variant="ghost" open={open()} class="shrink-0" onOpenChange={openWrapper}>
        <div class="py-1">
          <div
            class="group/workspace relative"
            data-component="workspace-item"
            data-workspace={base64Encode(props.directory)}
          >
            <div class="flex items-center gap-1">
              <Show
                when={workspaceEditActive()}
                fallback={
                  <Collapsible.Trigger
                    class="flex w-full items-center justify-between pl-2"
                    data-sidebar-workspace-header
                    data-active={active()}
                    data-action="workspace-toggle"
                    data-workspace={base64Encode(props.directory)}
                  >
                    {header()}
                  </Collapsible.Trigger>
                }
              >
                <div
                  class="flex w-full items-center justify-between pl-2"
                  data-sidebar-workspace-header
                  data-active={active()}
                >
                  {header()}
                </div>
              </Show>
              <WorkspaceActions
                directory={props.directory}
                local={local}
                busy={busy}
                menuOpen={() => menu.open}
                pendingRename={() => menu.pendingRename}
                setMenuOpen={(open) => setMenu("open", open)}
                setPendingRename={(value) => setMenu("pendingRename", value)}
                sidebarHovering={props.ctx.sidebarHovering}
                touch={touch}
                language={language}
                workspaceValue={workspaceValue}
                openEditor={props.ctx.openEditor}
                showResetWorkspaceDialog={props.ctx.showResetWorkspaceDialog}
                showDeleteWorkspaceDialog={props.ctx.showDeleteWorkspaceDialog}
                root={props.project.worktree}
                clearHoverProjectSoon={props.ctx.clearHoverProjectSoon}
                navigateToNewSession={() => navigate(`/${slug()}/session`)}
              />
            </div>
          </div>
        </div>

        <Collapsible.Content
          ref={(element: HTMLDivElement) => {
            workspaceContent = element
          }}
          data-sidebar-workspace-content
        >
          <WorkspaceSessionList
            slug={slug}
            mobile={props.mobile}
            ctx={props.ctx}
            showNew={showNew}
            loading={loading}
            loadFailed={loadFailed}
            sessions={sessions}
            hasMore={hasMore}
            retryLoad={retryLoad}
            loadMore={loadMore}
            language={language}
            nested
          />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

export const LocalWorkspace = (props: {
  ctx: WorkspaceSidebarContext
  project: LocalProject
  sortNow: Accessor<number>
  mobile?: boolean
  onScrollTopChange?: (scrollTop: number) => void
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const sidebarScrollbar = createSidebarScrollbarController()
  onCleanup(sidebarScrollbar.dispose)
  const workspace = createMemo(() => {
    const [store, setStore] = serverSync().child(props.project.worktree)
    return { store, setStore }
  })
  const slug = createMemo(() => base64Encode(props.project.worktree))
  const sessions = createMemo(() => {
    const current = workspace()
    const now = props.sortNow()
    props.ctx.preserveScrollAnchor()
    return sortedRootSessions(current.store, now)
  })
  const count = createMemo(() => sessions()?.length ?? 0)
  const hasMore = createMemo(() => workspace().store.sessionTotal > count())
  const loading = () => workspace().store.session_list_status === "loading" && count() === 0
  const loadFailed = () => workspace().store.session_list_status === "error" && count() === 0
  const retryLoad = () => serverSync().project.loadSessions(props.project.worktree)
  const loadMore = async () => {
    workspace().setStore("limit", (limit) => (limit ?? 0) + 5)
    await serverSync().project.loadSessions(props.project.worktree)
    if (workspace().store.session_list_status === "error") throw new Error("Failed to load sessions")
  }

  return (
    <div
      ref={(el) => {
        onCleanup(props.ctx.registerScrollContainer(el))
        sidebarScrollbar.observe(el)
        onCleanup(() => sidebarScrollbar.unobserve(el))
      }}
      data-sidebar-scrollbar
      class="size-full flex flex-col py-2 overflow-y-auto [overflow-anchor:none]"
      onScroll={(event) => {
        if (
          !event.currentTarget.hasAttribute("data-sidebar-scroll-restoring") &&
          !event.currentTarget.hasAttribute("data-sidebar-scroll-anchoring")
        ) {
          sidebarScrollbar.showScrolling(event.currentTarget)
        }
        props.onScrollTopChange?.(event.currentTarget.scrollTop)
      }}
    >
      <WorkspaceSessionList
        slug={slug}
        mobile={props.mobile}
        ctx={props.ctx}
        showNew={() => false}
        loading={loading}
        loadFailed={loadFailed}
        sessions={sessions}
        hasMore={hasMore}
        retryLoad={retryLoad}
        loadMore={loadMore}
        language={language}
      />
    </div>
  )
}
