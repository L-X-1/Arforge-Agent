import { createEffect, createMemo, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { Button } from "@arforge-ai/ui/button"
import { ContextMenu } from "@arforge-ai/ui/context-menu"
import { HoverCard } from "@arforge-ai/ui/hover-card"
import { Icon } from "@arforge-ai/ui/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { createSortable } from "@thisbeyond/solid-dnd"
import { useLayout, type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { ProjectIcon, SessionItem, type ProjectStatus, type SessionItemProps } from "./sidebar-items"
import { displayName, hasProjectPermissions, sortedRootSessions } from "./helpers"
import {
  PROJECT_PREVIEW_POINTER_CLOSE_DELAY_MS,
  PROJECT_PREVIEW_POINTER_OPEN_DELAY_MS,
} from "./sidebar-project-preview-timing"
import { sidebarPrimaryActionLabelIsTruncated } from "./sidebar-primary-action-overflow"
import { createSidebarScrollbarController } from "./sidebar-scrollbar"
import "./sidebar-project.css"

export type ProjectSidebarContext = {
  currentDir: Accessor<string>
  currentProject: Accessor<LocalProject | undefined>
  sidebarOpened: Accessor<boolean>
  sidebarHovering: Accessor<boolean>
  hoverProject: Accessor<string | undefined>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  onHoverOpenChanged: (worktree: string, hovered: boolean) => void
  navigateToProject: (directory: string) => void
  openSidebar: () => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  workspaceIds: (project: LocalProject) => string[]
  workspaceLabel: (directory: string, branch?: string, projectId?: string) => string
  sessionProps: Omit<SessionItemProps, "session" | "list" | "slug" | "mobile" | "dense">
}

export const ProjectDragOverlay = (props: {
  projects: Accessor<LocalProject[]>
  activeProject: Accessor<string | undefined>
}): JSX.Element => {
  const project = createMemo(() => props.projects().find((p) => p.worktree === props.activeProject()))
  return (
    <Show when={project()}>
      {(p) => (
        <div class="bg-background-base rounded-xl p-1">
          <ProjectIcon project={p()} />
        </div>
      )}
    </Show>
  )
}

const ProjectTile = (props: {
  project: LocalProject
  mobile?: boolean
  sidebarHovering: Accessor<boolean>
  selected: Accessor<boolean>
  active: Accessor<boolean>
  isWorking: Accessor<boolean>
  overlay: Accessor<boolean>
  previewEligible: Accessor<boolean>
  suppressHover: Accessor<boolean>
  dirs: Accessor<string[]>
  onProjectMouseEnter: (worktree: string, event: MouseEvent) => void
  onProjectMouseLeave: (worktree: string) => void
  onProjectFocus: (worktree: string) => void
  navigateToProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  toggleProjectWorkspaces: (project: LocalProject) => void
  workspacesEnabled: (project: LocalProject) => boolean
  closeProject: (directory: string) => void
  setMenu: (value: boolean) => void
  setOpen: (value: boolean) => void
  setSuppressHover: (value: boolean) => void
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const layout = useLayout()
  const unseenCount = createMemo(() =>
    props.dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => props.dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    props.dirs().some((directory) =>
      hasProjectPermissions(serverSync().session.data.permission, (item) => {
        if (serverSync().session.get(item.sessionID)?.directory !== directory) return false
        return !permission.autoResponds(item, directory)
      }),
    ),
  )
  const status = createMemo<ProjectStatus | undefined>(() => {
    if (hasPermissions()) return "permission"
    if (unseenCount() === 0) return
    if (hasError()) return "error"
    return "unread"
  })
  const statusLabel = createMemo(() => {
    if (status() === "permission") return props.language.t("notification.permission.title")
    if (status() === "error") return props.language.t("notification.session.error.title")
    if (status() === "unread") {
      return `${props.language.t("sidebar.project.clearNotifications")}: ${unseenCount()}`
    }
  })
  const accessibleLabel = createMemo(() =>
    [displayName(props.project), statusLabel(), props.isWorking() ? props.language.t("common.loading") : undefined]
      .filter(Boolean)
      .join(", "),
  )

  const clear = () =>
    props
      .dirs()
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))

  return (
    <ContextMenu
      modal={!props.sidebarHovering()}
      onOpenChange={(value) => {
        props.setMenu(value)
        props.setSuppressHover(value)
        if (value) props.setOpen(false)
      }}
    >
      <ContextMenu.Trigger
        as="button"
        type="button"
        aria-label={accessibleLabel()}
        data-action="project-switch"
        data-project={base64Encode(props.project.worktree)}
        data-sidebar-project-tile
        data-selected={props.selected()}
        data-preview-active={props.active()}
        class="flex items-center justify-center p-1 rounded-lg overflow-hidden cursor-default"
        onPointerDown={(event) => {
          if (event.button === 0 && !event.ctrlKey) {
            props.setOpen(false)
            props.setSuppressHover(true)
            return
          }
          if (!props.overlay()) return
          if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return
          props.setOpen(false)
          props.setSuppressHover(true)
          event.preventDefault()
        }}
        onMouseEnter={(event: MouseEvent) => {
          if (!props.overlay()) return
          if (props.suppressHover()) return
          props.onProjectMouseEnter(props.project.worktree, event)
        }}
        onMouseLeave={() => {
          if (props.suppressHover()) props.setSuppressHover(false)
          if (!props.overlay()) return
          props.onProjectMouseLeave(props.project.worktree)
        }}
        onFocus={() => {
          if (!props.previewEligible()) return
          if (props.suppressHover()) return
          props.onProjectFocus(props.project.worktree)
        }}
        onClick={() => {
          props.setOpen(false)
          if (props.selected()) {
            layout.sidebar.toggle()
            return
          }
          props.navigateToProject(props.project.worktree)
        }}
        onBlur={() => props.setOpen(false)}
      >
        <ProjectIcon project={props.project} status={status()} working={props.isWorking()} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => props.showEditProjectDialog(props.project)}>
            <ContextMenu.ItemLabel>{props.language.t("common.edit")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-workspaces-toggle"
            data-project={base64Encode(props.project.worktree)}
            disabled={props.project.vcs !== "git" && !props.workspacesEnabled(props.project)}
            onSelect={() => props.toggleProjectWorkspaces(props.project)}
          >
            <ContextMenu.ItemLabel>
              {props.workspacesEnabled(props.project)
                ? props.language.t("sidebar.workspaces.disable")
                : props.language.t("sidebar.workspaces.enable")}
            </ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item
            data-action="project-clear-notifications"
            data-project={base64Encode(props.project.worktree)}
            disabled={unseenCount() === 0}
            onSelect={clear}
          >
            <ContextMenu.ItemLabel>{props.language.t("sidebar.project.clearNotifications")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            data-action="project-close-menu"
            data-project={base64Encode(props.project.worktree)}
            onSelect={() => props.closeProject(props.project.worktree)}
          >
            <ContextMenu.ItemLabel>{props.language.t("common.close")}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}

const ProjectPreviewTruncatedLabel = (props: {
  value: string
  kind: "title" | "workspace" | "section" | "empty"
  class: string
}): JSX.Element => {
  let label: HTMLSpanElement | undefined
  let observer: ResizeObserver | undefined
  const [state, setState] = createStore({ truncated: false })
  const value = () => props.value
  const measure = () => {
    const next = sidebarPrimaryActionLabelIsTruncated(label)
    if (next === state.truncated) return
    setState("truncated", next)
  }
  const setLabel = (element: HTMLSpanElement) => {
    if (label) observer?.unobserve(label)
    label = element
    observer?.observe(element)
    queueMicrotask(measure)
  }

  createEffect(() => {
    value()
    queueMicrotask(measure)
  })

  onMount(() => {
    measure()
    window.addEventListener("resize", measure)

    if (typeof ResizeObserver === "undefined") return
    observer = new ResizeObserver(measure)
    if (label) observer.observe(label)
  })

  onCleanup(() => {
    observer?.disconnect()
    window.removeEventListener("resize", measure)
  })

  return (
    <TooltipV2
      value={value()}
      inactive={!state.truncated}
      placement="top-start"
      flip
      slide
      overflowPadding={8}
      class="min-w-0 grow"
      contentStyle={{
        "max-width": "min(288px, calc(100vw - 16px))",
        "white-space": "normal",
        "overflow-wrap": "anywhere",
        "text-align": "start",
      }}
    >
      <span
        ref={setLabel}
        data-sidebar-project-preview-truncated-label
        data-sidebar-project-preview-title-label={props.kind === "title" ? "" : undefined}
        data-sidebar-project-preview-workspace-label={props.kind === "workspace" ? "" : undefined}
        data-sidebar-project-preview-section-label-text={props.kind === "section" ? "" : undefined}
        data-sidebar-project-preview-empty-label={props.kind === "empty" ? "" : undefined}
        tabIndex={state.truncated ? 0 : undefined}
        class={`min-w-0 grow truncate ${props.class}`}
      >
        {value()}
      </span>
    </TooltipV2>
  )
}

const ProjectPreviewViewAllButton = (props: { label: string; onClick: () => void }): JSX.Element => {
  let label: HTMLSpanElement | undefined
  let observer: ResizeObserver | undefined
  const [state, setState] = createStore({ truncated: false })
  const value = () => props.label
  const measure = () => {
    const next = sidebarPrimaryActionLabelIsTruncated(label)
    if (next === state.truncated) return
    setState("truncated", next)
  }
  const setLabel = (element: HTMLSpanElement) => {
    if (label) observer?.unobserve(label)
    label = element
    observer?.observe(element)
    queueMicrotask(measure)
  }

  createEffect(() => {
    value()
    queueMicrotask(measure)
  })

  onMount(() => {
    measure()
    window.addEventListener("resize", measure)

    if (typeof ResizeObserver === "undefined") return
    observer = new ResizeObserver(measure)
    if (label) observer.observe(label)
  })

  onCleanup(() => {
    observer?.disconnect()
    window.removeEventListener("resize", measure)
  })

  return (
    <TooltipV2
      value={value()}
      inactive={!state.truncated}
      placement="top-start"
      flip
      slide
      overflowPadding={8}
      class="min-w-0 w-full"
      contentStyle={{
        "max-width": "min(288px, calc(100vw - 16px))",
        "white-space": "normal",
        "overflow-wrap": "anywhere",
        "text-align": "start",
      }}
    >
      <Button
        variant="ghost"
        data-sidebar-project-preview-view-all
        class="flex w-full min-w-0 text-left justify-start text-text-base px-2"
        onClick={props.onClick}
      >
        <span ref={setLabel} data-sidebar-project-preview-view-all-label class="min-w-0 grow truncate">
          {value()}
        </span>
        <span data-sidebar-project-preview-view-all-icon aria-hidden="true">
          <Icon name="chevron-right" size="small" />
        </span>
      </Button>
    </TooltipV2>
  )
}

const ProjectPreviewPanel = (props: {
  project: LocalProject
  mobile?: boolean
  selected: Accessor<boolean>
  workspaceEnabled: Accessor<boolean>
  workspaces: Accessor<string[]>
  label: (directory: string) => string
  projectSessions: Accessor<ReturnType<typeof sortedRootSessions>>
  workspaceSessions: (directory: string) => ReturnType<typeof sortedRootSessions>
  ctx: ProjectSidebarContext
  language: ReturnType<typeof useLanguage>
}): JSX.Element => {
  const previewScrollEdges = createSidebarScrollbarController()
  const previewWorkspaces = createMemo(() => {
    if (!props.workspaceEnabled()) return []
    return props
      .workspaces()
      .map((directory) => ({
        directory,
        sessions: props.workspaceSessions(directory),
      }))
      .filter((workspace) => workspace.sessions.length > 0)
  })
  const hasRecentSessions = createMemo(() => {
    if (!props.workspaceEnabled()) return props.projectSessions().length > 0
    return previewWorkspaces().length > 0
  })
  onCleanup(previewScrollEdges.dispose)

  return (
    <div data-sidebar-project-preview class="-m-3 p-2 flex flex-col">
      <div data-sidebar-project-preview-title class="px-4 flex items-center gap-2">
        <ProjectPreviewTruncatedLabel
          kind="title"
          value={displayName(props.project)}
          class="text-14-medium text-text-strong"
        />
      </div>
      <div
        ref={previewScrollEdges.observe}
        data-sidebar-project-preview-scroll-region
        onScroll={(event) => previewScrollEdges.update(event.currentTarget)}
      >
        <div data-sidebar-project-preview-section-label class="px-4 flex min-w-0">
          <ProjectPreviewTruncatedLabel
            kind="section"
            value={props.language.t("sidebar.project.recentSessions")}
            class="text-12-medium text-text-weak"
          />
        </div>
        <div class="px-2 pb-2">
          <Show
            when={hasRecentSessions()}
            fallback={
              <div data-sidebar-project-preview-empty role="status" aria-live="polite" aria-atomic="true">
                <ProjectPreviewTruncatedLabel kind="empty" value={props.language.t("sidebar.session.empty")} class="" />
              </div>
            }
          >
            <Show
              when={props.workspaceEnabled()}
              fallback={
                <div data-sidebar-project-preview-session-list class="flex flex-col gap-2">
                  <For each={props.projectSessions().slice(0, 2)}>
                    {(session) => (
                      <SessionItem
                        {...props.ctx.sessionProps}
                        session={session}
                        list={props.projectSessions()}
                        slug={base64Encode(props.project.worktree)}
                        dense
                        showTooltip
                        tooltipOverflowOnly
                        mobile={props.mobile}
                      />
                    )}
                  </For>
                </div>
              }
            >
              <div data-sidebar-project-preview-workspace-list>
                <For each={previewWorkspaces()}>
                  {(workspace) => (
                    <div data-sidebar-project-preview-workspace-group>
                      <div data-sidebar-project-preview-workspace-header>
                        <span data-sidebar-project-preview-workspace-icon aria-hidden="true">
                          <Icon name="branch" size="small" />
                        </span>
                        <ProjectPreviewTruncatedLabel
                          kind="workspace"
                          value={props.label(workspace.directory)}
                          class="text-14-medium text-text-base"
                        />
                      </div>
                      <For each={workspace.sessions.slice(0, 2)}>
                        {(session) => (
                          <SessionItem
                            {...props.ctx.sessionProps}
                            session={session}
                            list={workspace.sessions}
                            slug={base64Encode(workspace.directory)}
                            baseIndent={12}
                            dense
                            showTooltip
                            tooltipOverflowOnly
                            mobile={props.mobile}
                          />
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
      <div data-sidebar-project-preview-footer class="px-2 py-2">
        <ProjectPreviewViewAllButton
          label={props.language.t("sidebar.project.viewAllSessions")}
          onClick={() => {
            props.ctx.openSidebar()
            props.ctx.onHoverOpenChanged(props.project.worktree, false)
            if (props.selected()) return
            props.ctx.navigateToProject(props.project.worktree)
          }}
        />
      </div>
    </div>
  )
}

export const SortableProject = (props: {
  project: LocalProject
  mobile?: boolean
  ctx: ProjectSidebarContext
  sortNow: Accessor<number>
}): JSX.Element => {
  const serverSync = useServerSync()
  const language = useLanguage()
  const sortable = createSortable(props.project.worktree)
  const selected = createMemo(() => props.ctx.currentProject()?.worktree === props.project.worktree)
  const workspaces = createMemo(() => props.ctx.workspaceIds(props.project).slice(0, 2))
  const workspaceEnabled = createMemo(() => props.ctx.workspacesEnabled(props.project))
  const dirs = createMemo(() => props.ctx.workspaceIds(props.project))
  const [state, setState] = createStore({
    menu: false,
    suppressHover: false,
  })

  const isHoverProject = () => props.ctx.hoverProject() === props.project.worktree
  const preview = createMemo(() => !props.mobile && props.ctx.sidebarOpened())
  const overlay = createMemo(() => !props.mobile && !props.ctx.sidebarOpened())
  const active = createMemo(() => state.menu || (preview() ? isHoverProject() : overlay() && isHoverProject()))

  const hoverOpen = () => isHoverProject() && preview() && !selected() && !state.menu

  const label = (directory: string) => {
    const [data] = serverSync().child(directory, { bootstrap: false })
    const kind =
      directory === props.project.worktree ? language.t("workspace.type.local") : language.t("workspace.type.sandbox")
    const name = props.ctx.workspaceLabel(directory, data.vcs?.branch, props.project.id)
    return `${kind} : ${name}`
  }

  const projectStore = createMemo(() => serverSync().child(props.project.worktree, { bootstrap: false })[0])
  const isWorking = createMemo(() =>
    dirs().some((directory) => {
      return Object.keys(serverSync().session.data.session_status).some((id) => {
        if (serverSync().session.get(id)?.directory !== directory) return false
        return serverSync().session.data.session_working(id)
      })
    }),
  )
  const projectSessions = createMemo(() => sortedRootSessions(projectStore(), props.sortNow()))
  const workspaceSessions = (directory: string) => {
    const [data] = serverSync().child(directory, { bootstrap: false })
    return sortedRootSessions(data, props.sortNow())
  }
  const tile = () => (
    <ProjectTile
      project={props.project}
      mobile={props.mobile}
      sidebarHovering={props.ctx.sidebarHovering}
      selected={selected}
      active={active}
      isWorking={isWorking}
      overlay={overlay}
      previewEligible={() => overlay() || (preview() && !selected())}
      suppressHover={() => state.suppressHover}
      dirs={dirs}
      onProjectMouseEnter={props.ctx.onProjectMouseEnter}
      onProjectMouseLeave={props.ctx.onProjectMouseLeave}
      onProjectFocus={props.ctx.onProjectFocus}
      navigateToProject={props.ctx.navigateToProject}
      showEditProjectDialog={props.ctx.showEditProjectDialog}
      toggleProjectWorkspaces={props.ctx.toggleProjectWorkspaces}
      workspacesEnabled={props.ctx.workspacesEnabled}
      closeProject={props.ctx.closeProject}
      setMenu={(value) => setState("menu", value)}
      setOpen={(value) => props.ctx.onHoverOpenChanged(props.project.worktree, value)}
      setSuppressHover={(value) => setState("suppressHover", value)}
      language={language}
    />
  )

  return (
    // @ts-ignore
    <div use:sortable classList={{ "opacity-30": sortable.isActiveDraggable }}>
      <Show when={preview() && !selected()} fallback={tile()}>
        <HoverCard
          class="sidebar-project-preview-surface"
          open={!state.suppressHover && hoverOpen() && !state.menu}
          openDelay={PROJECT_PREVIEW_POINTER_OPEN_DELAY_MS}
          closeDelay={PROJECT_PREVIEW_POINTER_CLOSE_DELAY_MS}
          placement="right-start"
          gutter={8}
          overflowPadding={8}
          fitViewport
          trigger={tile()}
          onOpenChange={(value) => {
            if (state.menu) return
            if (value && state.suppressHover) return
            props.ctx.onHoverOpenChanged(props.project.worktree, value)
          }}
        >
          <ProjectPreviewPanel
            project={props.project}
            mobile={props.mobile}
            selected={selected}
            workspaceEnabled={workspaceEnabled}
            workspaces={workspaces}
            label={label}
            projectSessions={projectSessions}
            workspaceSessions={workspaceSessions}
            ctx={props.ctx}
            language={language}
          />
        </HoverCard>
      </Show>
    </div>
  )
}
