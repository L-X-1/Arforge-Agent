import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { Dialog as Drawer } from "@kobalte/core/dialog"
import { useQuery } from "@tanstack/solid-query"
import { ResizeHandle } from "@arforge-ai/ui/resize-handle"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { ProjectAvatar } from "@arforge-ai/ui/v2/project-avatar-v2"
import { useLayout, type LocalProject } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { feedbackUrl } from "@/utils/external-links"
import { sessionTitle } from "@/utils/session-title"
import { homeArchivedSessionsKey } from "@/pages/home/home-archived-sessions-controller"
import { buildHomeArchivedSessionRecords } from "@/pages/home/home-archived-sessions-model"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { createHomeSessionsController, HomeSessionStatusController } from "@/pages/home/home-sessions-controller"
import { HomeProjectsView } from "@/pages/home/home-projects-view"
import { SessionNavigationMenu, useSessionNavigation } from "@/pages/home/session-navigation"
import { useControlApprovalLauncher } from "@/components/control-approval/control-approval-center"
import { settingsRoute } from "@/components/settings-dialog-context"
import { SHELL_DRAWER_QUERY, navigationMatches, projectContainsDirectory, shouldOpenNavigationSessionInBackground, workspaceSidebarWidth } from "./workspace-shell-state"
import "./workspace-sidebar.css"

const SIDEBAR_RAIL_WIDTH = 44

export function WorkspaceSidebar() {
  const layout = useLayout()
  const tabs = useTabs()
  const command = useCommand()
  const navigate = useNavigate()
  const location = useLocation()
  const language = useLanguage()
  const platform = usePlatform()
  const global = useGlobal()
  const controlApproval = useControlApprovalLauncher()
  const navigation = useSessionNavigation()
  const narrow = createMediaQuery(SHELL_DRAWER_QUERY)
  const [state, setState] = createStore({ query: "" })
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const expanded = createMemo(() => narrow() || layout.sidebar.opened())
  const sessions = createHomeSessionsController(home, {
    navigationOnly: true,
    pins: navigation.targets,
    enabled: () => narrow() ? layout.mobileSidebar.opened() : layout.sidebar.opened(),
  })
  const isBackgroundOpen = (event: MouseEvent) => shouldOpenNavigationSessionInBackground(
    event, typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
  )
  const focusedKey = () => home.selection.value().server
  const closeDrawer = () => layout.mobileSidebar.hide()
  const backToHome = () => {
    if (location.pathname !== "/" || location.search) navigate("/")
    closeDrawer()
  }
  const currentDirectory = createMemo(() => home.selection.value().directory ?? home.project.list()[0]?.worktree)
  createEffect(() => controlApproval.registerLocation(currentDirectory()))
  const project = createMemo<LocalProject | undefined>(() => {
    const dir = currentDirectory()
    return home.project.list().find((item) => item.worktree === dir || item.sandboxes?.includes(dir ?? ""))
  })
  const openSettings = () => {
    const route = layout.route()
    navigate(settingsRoute(route.type === "session" ? route.sessionId : undefined))
    closeDrawer()
  }
  const newSession = () => {
    command.trigger("tab.new")
    closeDrawer()
  }
  const searchCommands = () => {
    closeDrawer()
    command.show()
  }
  const archiveQuery = useQuery(() => ({
    queryKey: homeArchivedSessionsKey(focusedKey()),
    enabled: !!focusedKey(),
    queryFn: async ({ signal }) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === focusedKey())
      if (!conn) return []
      const sdk = global.ensureServerCtx(conn).sdk
      const result = await sdk.client.experimental.session.list({ roots: true, archived: true, limit: 5_000 }, { signal })
      return buildHomeArchivedSessionRecords(result.data ?? [])
    },
    retry: false,
    staleTime: 15_000,
  }))
  const archiveCount = () => archiveQuery.data?.length ?? 0
  const archiveSelected = () => location.pathname === "/" && new URLSearchParams(location.search).get("archived") === "1"
  const openArchive = () => { navigate("/?archived=1"); closeDrawer() }
  const utilityItems = createMemo(() => [
    {
      id: "overview", label: language.t("home.title"), icon: "grid-plus",
      selected: location.pathname === "/" && !archiveSelected(),
      onClick: () => { home.selection.set({ server: focusedKey() }); navigate("/"); closeDrawer() },
    },
    { id: "archive", label: language.t("home.archived"), icon: "archive", onClick: openArchive, count: archiveCount, selected: archiveSelected() },
    { id: "control-approval", label: controlApproval.label(), icon: "warning", onClick: () => { closeDrawer(); controlApproval.open() }, count: controlApproval.count, selected: false },
    { id: "settings", label: language.t("sidebar.settings"), icon: "settings-gear", onClick: openSettings, selected: location.pathname.startsWith("/settings") },
    { id: "help", label: language.t("sidebar.help"), icon: "help", onClick: () => { if (feedbackUrl) platform.openLink(feedbackUrl) }, selected: false },
  ])
  const recordsForProject = (item: LocalProject) => sessions.data.records()
    .filter((record) => projectContainsDirectory(item, record.session.directory))
    .filter((record) => navigationMatches(state.query, record.session.title, item.name ?? "", item.worktree))
    .sort((a, b) => Number(navigation.pinned({ server: focusedKey(), session: b.session })) - Number(navigation.pinned({ server: focusedKey(), session: a.session })))
  const filterProjects = (conn: ServerConnection.Any, items: LocalProject[]) => items.filter((item) =>
    navigationMatches(state.query, item.name ?? "", item.worktree) ||
    (ServerConnection.key(conn) === focusedKey() && recordsForProject(item).length > 0),
  )
  const projectsViewProps = {
    language: projects.copy.language,
    servers: projects.server.list,
    projects: () => {
      const conn = home.server.focused()
      return conn ? filterProjects(conn, projects.project.list()) : []
    },
    recentlyClosed: projects.project.recentlyClosed,
    selection: projects.selection.value,
    homedir: projects.project.homedir,
    serverHealth: projects.server.health,
    projectsForServer: (conn: ServerConnection.Any) => filterProjects(conn, projects.server.projects(conn)),
    collapsed: projects.server.collapsed,
    canDefaultServer: projects.server.canDefault,
    defaultServerKey: projects.server.defaultKey,
    canRevealProject: projects.project.canReveal,
    unseenCount: projects.project.unseenCount,
    archiveSelected,
    archiveCount,
    onWheel: (_event: WheelEvent) => {},
    onChooseProject: (conn: ServerConnection.Any) => { closeDrawer(); projects.project.choose(conn); backToHome() },
    onFocusServer: (conn: ServerConnection.Any) => { projects.server.focus(conn); setState("query", ""); backToHome() },
    onToggleCollapsed: projects.server.toggleCollapsed,
    onEditServer: (conn: ServerConnection.Http) => { closeDrawer(); projects.server.edit(conn) },
    onSetDefaultServer: projects.server.setDefault,
    onRemoveServer: (conn: ServerConnection.Any) => { closeDrawer(); projects.server.remove(conn) },
    onMoveProject: projects.project.move,
    onSelectProject: (conn: ServerConnection.Any, directory: string) => {
      const current = home.selection.value()
      const key = ServerConnection.key(conn)
      if (current.server === key && current.directory === directory) home.selection.set({ server: key })
      else projects.project.select(conn, directory)
      backToHome()
    },
    onAddProjects: projects.project.add,
    onOpenProjectNewSession: (conn: ServerConnection.Any, directory: string) => {
      const ctx = global.ensureServerCtx(conn)
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
      void tabs.newDraft({ server: ServerConnection.key(conn), directory })
      closeDrawer()
    },
    onEditProject: (conn: ServerConnection.Any, item: LocalProject) => { closeDrawer(); projects.project.edit(conn, item) },
    onRevealProject: projects.project.reveal,
    onClearNotifications: projects.project.clearNotifications,
    onCloseProject: projects.project.close,
    onOpenArchive: openArchive,
    onOpenSettings: openSettings,
    onOpenHelp: () => { if (feedbackUrl) platform.openLink(feedbackUrl) },
    renderProjectChildren: (conn: ServerConnection.Any, item: LocalProject) => (
      <Show when={ServerConnection.key(conn) === focusedKey()}>
        <ul class="workspace-sidebar__sessions" aria-label={item.name || item.worktree}>
          <For each={tabs.store.filter((tab) => tab.type === "draft" && tab.server === focusedKey() && projectContainsDirectory(item, tab.directory))}>
            {(tab) => (
              <li>
                <button type="button" class="workspace-sidebar__session" onClick={() => { tabs.select(tab); closeDrawer() }}>
                  <IconV2 name="edit" size="small" />
                  <span>{language.t("command.session.new")}</span>
                </button>
              </li>
            )}
          </For>
          <For each={recordsForProject(item)}>
            {(record) => {
              const active = () => {
                const route = layout.route()
                return route.type === "session" && route.server === focusedKey() && route.sessionId === record.session.id
              }
              const pinned = () => navigation.pinned({ server: focusedKey(), session: record.session })
              return (
                <li class="workspace-sidebar__session-row" data-active={active() ? "" : undefined} data-pinned={pinned() ? "" : undefined}>
                  <button
                    type="button"
                    class="workspace-sidebar__session"
                    title={sessionTitle(record.session.title) + "\n" + record.session.directory}
                    aria-current={active() ? "page" : undefined}
                    onClick={(event) => {
                      const background = isBackgroundOpen(event)
                      sessions.session.open(record.session, { background })
                      if (!background) closeDrawer()
                    }}
                    onAuxClick={(event) => {
                      if (!isBackgroundOpen(event)) return
                      event.preventDefault()
                      sessions.session.open(record.session, { background: true })
                    }}
                    onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
                  >
                    <HomeSessionStatusController
                      server={focusedKey}
                      record={record}
                      isOpenTab={sessions.tab.isOpen}
                      render={(status) => (
                        <span class="workspace-sidebar__status" data-running={status.loading() ? "" : undefined}>
                          <Show when={pinned()} fallback={<Show when={status.unread()}><span class="workspace-sidebar__unseen" /></Show>}>
                            <span aria-label={navigation.copy().pin}>*</span>
                          </Show>
                        </span>
                      )}
                    />
                    <span>{sessionTitle(record.session.title) || record.session.id}</span>
                  </button>
                  <div class="workspace-sidebar__session-actions">
                    <SessionNavigationMenu server={focusedKey()} session={record.session} onAction={closeDrawer} onArchive={() => sessions.session.archive(record.session)} />
                  </div>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    ),
  }

  const Panel = () => (
    <aside
      id="workspace-navigation"
      data-component="workspace-sidebar"
      data-arforge-material="sidebar"
      data-expanded={expanded() ? "" : undefined}
      aria-label={language.t("home.projects")}
      class="relative z-20 flex h-full min-h-0 shrink-0 flex-col"
      style={{ width: narrow() ? "100%" : expanded() ? `${workspaceSidebarWidth(layout.sidebar.width())}px` : `${SIDEBAR_RAIL_WIDTH}px` }}
    >
      <div class="workspace-sidebar__body">
        <Show when={expanded()} fallback={
          <div class="flex h-14 shrink-0 items-center justify-center">
            <TooltipV2 placement="right" value={project()?.name || currentDirectory() || language.t("home.title")}>
              <button type="button" class="workspace-sidebar__rail-btn" onClick={() => layout.sidebar.open()} aria-label={language.t("command.sidebar.toggle")}>
                <Show when={project()} fallback={<IconV2 name="grid-plus" size="small" />}>
                  {(item) => <ProjectAvatar class="!size-7" fallback={item().name || item().worktree} src={item().icon?.url} variant="outline" />}
                </Show>
              </button>
            </TooltipV2>
          </div>
        }>
          <div class="workspace-sidebar__heading">
            <span>ARFORGE</span>
            <button type="button" class="workspace-sidebar__rail-btn" onClick={() => narrow() ? closeDrawer() : layout.sidebar.close()} aria-label={language.t("command.sidebar.toggle")}>
              <IconV2 name="menu" size="small" />
            </button>
          </div>
          <div class="workspace-sidebar__primary">
            <button type="button" class="workspace-sidebar__action" onClick={newSession} disabled={!home.server.list().some((conn) => home.project.forServer(conn).length > 0)}>
              <IconV2 name="edit" size="small" />
              <span>{language.t("command.session.new")}</span>
            </button>
            <button type="button" class="workspace-sidebar__action" onClick={searchCommands}>
              <IconV2 name="magnifying-glass" size="small" />
              <span>{language.t("command.palette")}</span>
            </button>
            <label class="workspace-sidebar__search">
              <IconV2 name="magnifying-glass" size="small" />
              <input type="search" value={state.query} placeholder={language.t("home.sessions.search.placeholder")}
                aria-label={language.t("home.sessions.search.placeholder")} onInput={(event) => setState("query", event.currentTarget.value)} />
            </label>
            <Show when={home.server.focused()}>
              {(conn) => <div class="workspace-sidebar__scope" title={serverName(conn())}>{serverName(conn())}</div>}
            </Show>
          </div>
          <div class="workspace-sidebar__projects min-h-0 flex-1">
            <Show when={!state.query || projects.server.list().some((conn) => filterProjects(conn, projects.server.projects(conn)).length > 0)}
              fallback={<p class="workspace-sidebar__notice" role="status">{language.t("home.sessions.search.noResults", { query: state.query })}</p>}>
              <HomeProjectsView {...projectsViewProps} embedded />
            </Show>
            <Show when={sessions.data.loading()}><p class="workspace-sidebar__notice" role="status">{language.t("common.loading")}</p></Show>
            <Show when={sessions.data.error() || sessions.data.pinFailures() > 0}>
              <div class="workspace-sidebar__notice" role="status">
                <span>{language.t("common.requestFailed")}</span>
                <button type="button" onClick={() => void sessions.data.retry()}>{language.t("common.retry")}</button>
              </div>
            </Show>
          </div>
        </Show>
        <nav class="workspace-sidebar__utilities" aria-label={language.t("common.moreOptions")}>
          <For each={utilityItems()}>
            {(item) => (
              <TooltipV2 placement={expanded() ? "top" : "right"} value={item.label}>
                <button type="button" class={expanded() ? "workspace-sidebar__action" : "workspace-sidebar__rail-btn"}
                  onClick={item.onClick} aria-label={item.label} aria-current={item.selected ? "page" : undefined}>
                  <IconV2 name={item.icon as never} size="small" />
                  <Show when={expanded()}>
                    <span>{item.label}</span>
                    <Show when={(item.count?.() ?? 0) > 0}><span class="workspace-sidebar__count">{item.count?.()}</span></Show>
                  </Show>
                </button>
              </TooltipV2>
            )}
          </For>
        </nav>
      </div>
      <Show when={!narrow() && expanded()}>
        <ResizeHandle direction="horizontal" size={workspaceSidebarWidth(layout.sidebar.width())} min={180} max={480}
          onResize={layout.sidebar.resize} onCollapse={layout.sidebar.close} collapseThreshold={140}
          aria-label={language.t("command.sidebar.toggle")} />
      </Show>
    </aside>
  )

  return (
    <Show when={narrow()} fallback={<Panel />}>
      <Drawer open={layout.mobileSidebar.opened()} onOpenChange={(opened) => opened ? layout.mobileSidebar.show() : closeDrawer()}>
        <Drawer.Portal>
          <Drawer.Overlay class="workspace-sidebar__backdrop" />
          <Drawer.Content
            class="workspace-sidebar__drawer"
            onEscapeKeyDown={(event) => { if (event.isComposing || event.keyCode === 229) event.preventDefault() }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              document.querySelector<HTMLElement>('[data-action="workspace-sidebar-toggle"]')?.focus()
            }}
          >
            <Drawer.Title class="sr-only">{language.t("home.projects")}</Drawer.Title>
            <Drawer.Description class="sr-only">{language.t("home.sessions.search.placeholder")}</Drawer.Description>
            <Panel />
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer>
    </Show>
  )
}
