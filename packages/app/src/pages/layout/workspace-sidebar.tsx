import { batch, createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Dialog as Drawer } from "@kobalte/core/dialog"
import { useQuery } from "@tanstack/solid-query"
import { ResizeHandle } from "@arforge-ai/ui/resize-handle"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { Mark } from "@arforge-ai/ui/logo"
import { WindowsAppMenu } from "@/components/windows-app-menu"
import { ProjectAvatar } from "@arforge-ai/ui/v2/project-avatar-v2"
import { useLayout, type LocalProject } from "@/context/layout"
import { useTabs, type DraftTab } from "@/context/tabs"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { feedbackUrl } from "@/utils/external-links"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { homeArchivedSessionsKey } from "@/pages/home/home-archived-sessions-controller"
import { buildHomeArchivedSessionRecords } from "@/pages/home/home-archived-sessions-model"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { createHomeSessionsController, HomeSessionStatusController } from "@/pages/home/home-sessions-controller"
import { HomeProjectsView } from "@/pages/home/home-projects-view"
import { SessionNavigationMenu, useSessionNavigation } from "@/pages/home/session-navigation"
import { useControlApprovalLauncher } from "@/components/control-approval/control-approval-center"
import { settingsRoute } from "@/components/settings-dialog-context"
import { pathKey } from "@/utils/path-key"
import { displayName } from "./helpers"
import {
  SHELL_DRAWER_QUERY,
  navigationMatches,
  projectContainsDirectory,
  shouldOpenNavigationSessionInBackground,
  workspaceSidebarSize,
} from "./workspace-shell-state"
import "./workspace-sidebar.css"

const SIDEBAR_RAIL_WIDTH = 52

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
  const [state, setState] = createStore({
    query: "",
    availableWidth: undefined as number | undefined,
    projectDisclosure: {} as Record<string, boolean>,
    searchDisclosure: {} as Record<string, boolean>,
    browseServer: undefined as ServerConnection.Key | undefined,
    searchServer: undefined as ServerConnection.Key | undefined,
  })
  const sidebarSize = createMemo(() => workspaceSidebarSize(layout.sidebar.width(), state.availableWidth))
  const home = createHomeController({ browseServer: () => state.searchServer ?? state.browseServer })
  const projects = createHomeProjectsController(home)
  const expanded = createMemo(() => narrow() || layout.sidebar.opened())
  const savedSelection = home.selection.value
  const focusedKey = () => {
    const conn = home.server.focused()
    return conn ? ServerConnection.key(conn) : savedSelection().server
  }
  const initialServer = focusedKey()
  // The Home page can filter to one selected project; the sidebar needs the whole focused server's tree.
  const sessions = createHomeSessionsController(
    {
      ...home,
      selection: { ...home.selection, value: () => ({ server: focusedKey() }) },
      project: { ...home.project, selected: () => undefined },
    },
    {
      navigationOnly: true,
      pins: navigation.targets,
      enabled: () => (narrow() ? layout.mobileSidebar.opened() : layout.sidebar.opened()),
    },
  )
  const isBackgroundOpen = (event: MouseEvent) =>
    shouldOpenNavigationSessionInBackground(
      event,
      typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    )
  const searching = () => !!state.query.trim()
  const resetBrowseServer = () => setState({ browseServer: undefined, searchServer: undefined })
  createEffect(on(() => [savedSelection().server, savedSelection().directory], resetBrowseServer, { defer: true }))
  const setQuery = (query: string) =>
    batch(() => {
      setState("searchDisclosure", reconcile({}))
      setState("query", query)
      if (!query.trim()) setState("searchServer", undefined)
    })
  const projectKey = (server: ServerConnection.Any, directory: string) =>
    JSON.stringify([ServerConnection.key(server), pathKey(directory)])
  const projectExpanded = (server: ServerConnection.Any, directory: string) => {
    const key = projectKey(server, directory)
    const serverKey = ServerConnection.key(server)
    if (serverKey !== focusedKey()) return false
    if (searching()) return state.searchDisclosure[key] ?? true
    return state.projectDisclosure[key] ?? serverKey === initialServer
  }
  const setProjectExpanded = (server: ServerConnection.Any, directory: string, expanded: boolean) =>
    batch(() => {
      setState(searching() ? "searchDisclosure" : "projectDisclosure", projectKey(server, directory), expanded)
      const key = ServerConnection.key(server)
      if (expanded && key !== focusedKey()) setState(searching() ? "searchServer" : "browseServer", key)
    })
  const serverDisclosureKey = (server: ServerConnection.Any) => JSON.stringify([ServerConnection.key(server)])
  const closeDrawer = () => layout.mobileSidebar.hide()
  const backToHome = () => {
    if (location.pathname !== "/" || location.search) navigate("/")
    closeDrawer()
  }
  const currentDirectory = createMemo(() => {
    const saved = savedSelection()
    return (saved.server === focusedKey() ? saved.directory : undefined) ?? home.project.list()[0]?.worktree
  })
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
  const openSettingsTab = (tab: string, section?: string) => {
    const route = layout.route()
    const base = settingsRoute(route.type === "session" ? route.sessionId : undefined)
    const anchor = section ? `#${encodeURIComponent(section)}` : ""
    navigate(`${base}${base.includes("?") ? "&" : "?"}tab=${encodeURIComponent(tab)}${anchor}`)
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
    queryKey: homeArchivedSessionsKey(savedSelection().server),
    enabled: !!savedSelection().server,
    queryFn: async ({ signal }) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === savedSelection().server)
      if (!conn) return []
      const sdk = global.ensureServerCtx(conn).sdk
      const result = await sdk.client.experimental.session.list(
        { roots: true, archived: true, limit: 5_000 },
        { signal },
      )
      return buildHomeArchivedSessionRecords(result.data ?? [])
    },
    retry: false,
    staleTime: 15_000,
  }))
  const archiveCount = () => archiveQuery.data?.length ?? 0
  const archiveSelected = () =>
    location.pathname === "/" && new URLSearchParams(location.search).get("archived") === "1"
  const openArchive = () => {
    navigate("/?archived=1")
    closeDrawer()
  }
  const utilityItems = createMemo(() => [
    {
      id: "overview",
      label: language.t("home.title"),
      icon: "grid-plus",
      selected: location.pathname === "/" && !archiveSelected(),
      onClick: () => {
        resetBrowseServer()
        home.selection.set({ server: savedSelection().server })
        navigate("/")
        closeDrawer()
      },
    },
    {
      id: "archive",
      label: language.t("home.archived"),
      icon: "archive",
      onClick: openArchive,
      count: archiveCount,
      selected: archiveSelected(),
    },
    {
      id: "control-approval",
      label: controlApproval.label(),
      icon: "warning",
      onClick: () => {
        closeDrawer()
        controlApproval.open()
      },
      count: controlApproval.count,
      selected: false,
    },
    {
      id: "settings",
      label: language.t("sidebar.settings"),
      icon: "settings-gear",
      onClick: openSettings,
      selected: location.pathname.startsWith("/settings"),
    },
    {
      id: "help",
      label: language.t("sidebar.help"),
      icon: "help",
      onClick: () => {
        if (feedbackUrl) platform.openLink(feedbackUrl)
      },
      selected: false,
    },
  ])
  const recordsForProject = (item: LocalProject) =>
    sessions.data
      .records()
      .filter((record) => projectContainsDirectory(item, record.session.directory))
      .filter((record) => navigationMatches(state.query, record.session.title, displayName(item), item.worktree))
      .sort(
        (a, b) =>
          Number(navigation.pinned({ server: focusedKey(), session: b.session })) -
          Number(navigation.pinned({ server: focusedKey(), session: a.session })),
      )
  const draftsForProject = (item: LocalProject) =>
    tabs.store.filter(
      (tab): tab is DraftTab =>
        tab.type === "draft" && tab.server === focusedKey() && projectContainsDirectory(item, tab.directory),
    )
  const filterProjects = (conn: ServerConnection.Any, items: LocalProject[]) =>
    items.filter(
      (item) =>
        navigationMatches(state.query, displayName(item), item.worktree) ||
        (ServerConnection.key(conn) === focusedKey() &&
          (recordsForProject(item).length > 0 ||
            (navigationMatches(state.query, language.t("sidebar.session.draft"), displayName(item), item.worktree) &&
              draftsForProject(item).length > 0))),
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
    collapsed: (conn: ServerConnection.Any) =>
      searching() ? state.searchDisclosure[serverDisclosureKey(conn)] === false : projects.server.collapsed(conn),
    canDefaultServer: projects.server.canDefault,
    defaultServerKey: projects.server.defaultKey,
    canRevealProject: projects.project.canReveal,
    unseenCount: projects.project.unseenCount,
    archiveSelected,
    archiveCount,
    onWheel: (_event: WheelEvent) => {},
    onChooseProject: (conn: ServerConnection.Any) => {
      closeDrawer()
      projects.project.choose(conn)
      backToHome()
    },
    onFocusServer: (conn: ServerConnection.Any) => {
      batch(() => {
        resetBrowseServer()
        projects.server.focus(conn)
        setQuery("")
      })
      backToHome()
    },
    onToggleCollapsed: (conn: ServerConnection.Any) => {
      if (!searching()) return projects.server.toggleCollapsed(conn)
      const key = serverDisclosureKey(conn)
      setState("searchDisclosure", key, state.searchDisclosure[key] === false)
    },
    onEditServer: (conn: ServerConnection.Http) => {
      closeDrawer()
      projects.server.edit(conn)
    },
    onSetDefaultServer: projects.server.setDefault,
    onRemoveServer: (conn: ServerConnection.Any) => {
      closeDrawer()
      projects.server.remove(conn)
    },
    onMoveProject: projects.project.move,
    onAddProjects: projects.project.add,
    onOpenProjectNewSession: (conn: ServerConnection.Any, directory: string) => {
      setProjectExpanded(conn, directory, true)
      projects.project.openNewSession(conn, directory)
      closeDrawer()
    },
    onEditProject: (conn: ServerConnection.Any, item: LocalProject) => {
      closeDrawer()
      projects.project.edit(conn, item)
    },
    onRevealProject: projects.project.reveal,
    onClearNotifications: projects.project.clearNotifications,
    onCloseProject: projects.project.close,
    onOpenArchive: openArchive,
    onOpenSettings: openSettings,
    onOpenHelp: () => {
      if (feedbackUrl) platform.openLink(feedbackUrl)
    },
  }

  const projectTree = {
    expanded: projectExpanded,
    toggle: (conn: ServerConnection.Any, directory: string) =>
      setProjectExpanded(conn, directory, !projectExpanded(conn, directory)),
    renderChildren: (_conn: ServerConnection.Any, item: LocalProject) => {
      const drafts = createMemo(() => draftsForProject(item))
      const records = createMemo(() => recordsForProject(item))
      return (
        <ul class="workspace-sidebar__sessions" aria-label={displayName(item)}>
          <For each={drafts()}>
            {(tab, index) => {
              const active = () => {
                const route = layout.route()
                return (route.type === "home" || route.type === "draft") && route.draftID === tab.draftID
              }
              return (
                <li class="workspace-sidebar__session-row" data-active={active() ? "" : undefined}>
                  <button
                    type="button"
                    class="workspace-sidebar__session workspace-sidebar__draft"
                    aria-current={active() ? "page" : undefined}
                    onClick={() => {
                      tabs.select(tab)
                      closeDrawer()
                    }}
                  >
                    <span class="workspace-sidebar__session-title">
                      {drafts().length > 1
                        ? language.t("sidebar.session.draft.numbered", { number: index() + 1 })
                        : language.t("sidebar.session.draft")}
                    </span>
                  </button>
                </li>
              )
            }}
          </For>
          <For each={records()}>
            {(record) => {
              const active = () => {
                const route = layout.route()
                return (
                  route.type === "session" && route.server === focusedKey() && route.sessionId === record.session.id
                )
              }
              const pinned = () => navigation.pinned({ server: focusedKey(), session: record.session })
              return (
                <li
                  class="workspace-sidebar__session-row"
                  data-active={active() ? "" : undefined}
                  data-pinned={pinned() ? "" : undefined}
                >
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
                    onMouseDown={(event) => {
                      if (event.button === 1) event.preventDefault()
                    }}
                  >
                    <HomeSessionStatusController
                      server={focusedKey}
                      record={record}
                      isOpenTab={sessions.tab.isOpen}
                      render={(status) => (
                        <span class="workspace-sidebar__status" data-running={status.loading() ? "" : undefined}>
                          <Show
                            when={pinned()}
                            fallback={
                              <Show when={status.unread()}>
                                <span class="workspace-sidebar__unseen" />
                              </Show>
                            }
                          >
                            <span aria-label={navigation.copy().pin}>*</span>
                          </Show>
                        </span>
                      )}
                    />
                    <span class="workspace-sidebar__session-title">
                      {sessionTitle(record.session.title) || record.session.id}
                    </span>
                    <time
                      class="workspace-sidebar__session-time"
                      dateTime={new Date(record.session.time.updated ?? record.session.time.created).toISOString()}
                      title={new Date(record.session.time.updated ?? record.session.time.created).toLocaleString(
                        language.locale(),
                      )}
                    >
                      {getRelativeTime(
                        new Date(record.session.time.updated ?? record.session.time.created).toISOString(),
                        language.t,
                      )}
                    </time>
                  </button>
                  <div class="workspace-sidebar__session-actions">
                    <SessionNavigationMenu
                      server={focusedKey()}
                      session={record.session}
                      onAction={closeDrawer}
                      onArchive={() => sessions.session.archive(record.session)}
                    />
                  </div>
                </li>
              )
            }}
          </For>
          <Show
            when={drafts().length === 0 && records().length === 0 && !sessions.data.loading() && !sessions.data.error()}
          >
            <li class="workspace-sidebar__project-empty">{language.t("sidebar.session.empty")}</li>
          </Show>
        </ul>
      )
    },
  }

  const Panel = () => (
    <aside
      ref={(panel) => createResizeObserver(() => panel.parentElement, ({ width }) => setState("availableWidth", width))}
      id="workspace-navigation"
      data-component="workspace-sidebar"
      data-arforge-material="sidebar"
      data-expanded={expanded() ? "" : undefined}
      aria-label={language.t("home.projects")}
      class="relative z-20 flex h-full min-h-0 shrink-0 flex-col"
      style={{
        "--workspace-sidebar-max-width": narrow() ? undefined : `${sidebarSize().max}px`,
        width: narrow()
          ? "100%"
          : expanded()
            ? `${sidebarSize().width}px`
            : `${SIDEBAR_RAIL_WIDTH}px`,
      }}
    >
      <div class="workspace-sidebar__body">
        <Show
          when={expanded()}
          fallback={
            <div class="workspace-sidebar__compact-heading">
              <TooltipV2 placement="right" value={project()?.name || currentDirectory() || language.t("home.title")}>
                <button
                  type="button"
                  class="workspace-sidebar__rail-btn"
                  onClick={() => layout.sidebar.open()}
                  aria-label={language.t("command.sidebar.toggle")}
                >
                  <Show
                    when={project()?.icon?.url}
                    fallback={<IconV2 name={project() ? "folder" : "grid-plus"} size="small" />}
                  >
                    {(item) => (
                      <ProjectAvatar
                        class="!size-4"
                        fallback={project()?.name || currentDirectory() || ""}
                        src={item()}
                        variant="outline"
                      />
                    )}
                  </Show>
                </button>
              </TooltipV2>
            </div>
          }
        >
          <div
            class="workspace-sidebar__heading"
            style={{
              "padding-left":
                platform.platform === "desktop" && platform.os === "macos" && !narrow()
                  ? `${84 / (platform.webviewZoom?.() ?? 1)}px`
                  : undefined,
            }}
          >
            <div class="workspace-sidebar__brand">
              <Show
                when={platform.platform === "desktop" && platform.os !== "macos"}
                fallback={<Mark class="size-5" />}
              >
                <WindowsAppMenu command={command} platform={platform} variant="brand" />
              </Show>
              <span>Arforge</span>
            </div>
            <button
              type="button"
              class="workspace-sidebar__rail-btn"
              onClick={() => (narrow() ? closeDrawer() : layout.sidebar.close())}
              aria-label={language.t("command.sidebar.toggle")}
            >
              <IconV2 name="menu" size="small" />
            </button>
          </div>
          <div class="workspace-sidebar__primary">
            <button
              type="button"
              class="workspace-sidebar__action workspace-sidebar__new-session"
              onClick={newSession}
              disabled={!home.server.list().some((conn) => home.project.forServer(conn).length > 0)}
            >
              <IconV2 name="edit" size="small" />
              <span>{language.t("command.session.new")}</span>
            </button>
            <label class="workspace-sidebar__search">
              <IconV2 name="magnifying-glass" size="small" />
              <input
                type="search"
                value={state.query}
                placeholder={language.t("home.sessions.search.placeholder")}
                aria-label={language.t("home.sessions.search.placeholder")}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button
                type="button"
                class="workspace-sidebar__command"
                onClick={searchCommands}
                aria-label={language.t("command.palette")}
              >
                {platform.os === "macos" ? "⌘ K" : "Ctrl K"}
              </button>
            </label>
            <Show when={home.server.focused()}>
              {(conn) => (
                <div class="workspace-sidebar__scope" title={serverName(conn())}>
                  {serverName(conn())}
                </div>
              )}
            </Show>
          </div>
          <div class="workspace-sidebar__projects min-h-0 flex-1">
            <Show
              when={
                !state.query ||
                projects.server.list().some((conn) => filterProjects(conn, projects.server.projects(conn)).length > 0)
              }
              fallback={
                <p class="workspace-sidebar__notice" role="status">
                  {language.t("home.sessions.search.noResults", { query: state.query })}
                </p>
              }
            >
              <HomeProjectsView {...projectsViewProps} embedded projectTree={projectTree} />
            </Show>
            <Show when={sessions.data.loading()}>
              <p class="workspace-sidebar__notice" role="status">
                {language.t("common.loading")}
              </p>
            </Show>
            <Show when={sessions.data.error() || sessions.data.pinFailures() > 0}>
              <div class="workspace-sidebar__notice" role="status">
                <span>{language.t("common.requestFailed")}</span>
                <button type="button" onClick={() => void sessions.data.retry()}>
                  {language.t("common.retry")}
                </button>
              </div>
            </Show>
          </div>
        </Show>
        <nav class="workspace-sidebar__utilities" aria-label={language.t("common.moreOptions")}>
          <TooltipV2
            inactive={expanded()}
            placement="right"
            value={language.locale().startsWith("zh") ? "后台任务" : "Background jobs"}
          >
            <button
              type="button"
              class="workspace-sidebar__action"
              aria-label={language.locale().startsWith("zh") ? "后台任务" : "Background jobs"}
              onClick={() => openSettingsTab("session-automation", "operations-personal-jobs-title")}
            >
              <IconV2 name="clock" size="small" />
              <span>{language.locale().startsWith("zh") ? "后台任务" : "Background jobs"}</span>
            </button>
          </TooltipV2>
          <TooltipV2
            inactive={expanded()}
            placement="right"
            value={language.locale().startsWith("zh") ? "控制中心" : "Control center"}
          >
            <button
              type="button"
              class="workspace-sidebar__action"
              aria-label={language.locale().startsWith("zh") ? "控制中心" : "Control center"}
              onClick={() => openSettingsTab("arforge-overview")}
            >
              <IconV2 name="grid-plus" size="small" />
              <span>{language.locale().startsWith("zh") ? "控制中心" : "Control center"}</span>
            </button>
          </TooltipV2>
          <TooltipV2 inactive={expanded()} placement="right" value={language.t("sidebar.settings")}>
            <button
              type="button"
              class="workspace-sidebar__action"
              aria-label={language.t("sidebar.settings")}
              onClick={openSettings}
            >
              <IconV2 name="settings-gear" size="small" />
              <span>{language.t("sidebar.settings")}</span>
            </button>
          </TooltipV2>
          <div class="workspace-sidebar__connection">
            <Show when={home.server.focused()}>
              {(conn) => (
                <span class="workspace-sidebar__connection-label" title={serverName(conn())}>
                  {serverName(conn())}
                </span>
              )}
            </Show>
            <DropdownMenu gutter={4} placement="top-end" modal={false}>
              <DropdownMenu.Trigger class="workspace-sidebar__rail-btn" aria-label={language.t("common.moreOptions")}>
                <IconV2 name="outline-dots" size="small" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content>
                  <For each={utilityItems()}>
                    {(item) => (
                      <DropdownMenu.Item onSelect={item.onClick}>
                        <DropdownMenu.ItemLabel>{item.label}</DropdownMenu.ItemLabel>
                        <Show when={(item.count?.() ?? 0) > 0}>
                          <span class="workspace-sidebar__count">{item.count?.()}</span>
                        </Show>
                      </DropdownMenu.Item>
                    )}
                  </For>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>
        </nav>
      </div>
      <Show when={!narrow() && expanded()}>
        <ResizeHandle
          direction="horizontal"
          size={sidebarSize().width}
          min={180}
          max={sidebarSize().max}
          onResize={layout.sidebar.resize}
          onCollapse={layout.sidebar.close}
          collapseThreshold={140}
          aria-label={language.t("command.sidebar.toggle")}
        />
      </Show>
    </aside>
  )

  return (
    <Show when={narrow()} fallback={<Panel />}>
      <Drawer
        open={layout.mobileSidebar.opened()}
        onOpenChange={(opened) => (opened ? layout.mobileSidebar.show() : closeDrawer())}
      >
        <Drawer.Portal>
          <Drawer.Overlay class="workspace-sidebar__backdrop" />
          <Drawer.Content
            class="workspace-sidebar__drawer"
            onEscapeKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229) event.preventDefault()
            }}
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
