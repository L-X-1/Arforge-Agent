import { createMemo, For, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { ProjectAvatar } from "@arforge-ai/ui/v2/project-avatar-v2"
import { useLayout, type LocalProject } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useServer, ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { usePlatform } from "@/context/platform"
import { feedbackUrl } from "@/utils/external-links"
import { homeArchivedSessionsKey } from "@/pages/home/home-archived-sessions-controller"
import { buildHomeArchivedSessionRecords } from "@/pages/home/home-archived-sessions-model"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { HomeProjectsView } from "@/pages/home/home-projects-view"
import "./workspace-sidebar.css"

const SIDEBAR_EXPANDED_WIDTH = 264
const SIDEBAR_RAIL_WIDTH = 44

export function WorkspaceSidebar() {
  const layout = useLayout()
  const tabs = useTabs()
  const navigate = useNavigate()
  const location = useLocation()
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const global = useGlobal()

  const backToHome = () => {
    if (location.pathname !== "/") navigate("/")
  }

  const home = createHomeController()
  const projects = createHomeProjectsController(home)

  const expanded = createMemo(() => layout.sidebar.opened())

  const currentDirectory = createMemo(() => {
    const selection = layout.home.selection()
    if (selection.directory) return selection.directory
    return layout.projects.list()[0]?.worktree
  })

  const project = createMemo<LocalProject | undefined>(() => {
    const dir = currentDirectory()
    if (!dir) return
    return layout.projects.list().find((p) => p.worktree === dir || p.sandboxes?.includes(dir))
  })

  const projectRoot = createMemo(() => project()?.worktree ?? currentDirectory())

  const newSession = () => {
    const root = projectRoot()
    if (!root) return
    tabs.newDraft({ server: server.key, directory: root }, "")
  }

  const archiveQuery = useQuery(() => ({
    queryKey: homeArchivedSessionsKey(server.key),
    enabled: !!server.key,
    queryFn: async ({ signal }) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === server.key)
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

  type UtilityItem = {
    id: string
    label: string
    icon: string
    onClick: () => void
    count?: () => number
  }
  const utilityItems: UtilityItem[] = [
    {
      id: "overview",
      label: language.t("home.title"),
      icon: "grid-plus",
      onClick: () => {
        home.selection.set({ server: server.key })
        navigate("/")
      },
    },
    {
      id: "archive",
      label: language.t("home.archived"),
      icon: "archive",
      onClick: () => navigate("/?archived=1"),
      count: archiveCount,
    },
    { id: "settings", label: language.t("sidebar.settings"), icon: "settings-gear", onClick: () => navigate("/settings") },
    {
      id: "help",
      label: language.t("sidebar.help"),
      icon: "help",
      onClick: () => {
        if (feedbackUrl) platform.openLink(feedbackUrl)
      },
    },
  ]

  const projectsViewProps = {
    language: projects.copy.language,
    servers: projects.server.list,
    projects: projects.project.list,
    recentlyClosed: projects.project.recentlyClosed,
    selection: projects.selection.value,
    homedir: projects.project.homedir,
    serverHealth: projects.server.health,
    projectsForServer: projects.server.projects,
    collapsed: projects.server.collapsed,
    canDefaultServer: projects.server.canDefault,
    defaultServerKey: projects.server.defaultKey,
    canRevealProject: projects.project.canReveal,
    unseenCount: projects.project.unseenCount,
    archiveSelected: () => false,
    archiveCount,
    onWheel: () => {},
    onChooseProject: (conn: ServerConnection.Any) => {
      projects.project.choose(conn)
      backToHome()
    },
    onFocusServer: (conn: ServerConnection.Any) => {
      projects.server.focus(conn)
      backToHome()
    },
    onToggleCollapsed: projects.server.toggleCollapsed,
    onEditServer: projects.server.edit,
    onSetDefaultServer: projects.server.setDefault,
    onRemoveServer: projects.server.remove,
    onMoveProject: projects.project.move,
    onSelectProject: (conn: ServerConnection.Any, directory: string) => {
      // Selecting a project filters the home sessions to that project;
      // re-clicking the selected project clears the filter back to all.
      const current = home.selection.value()
      const key = ServerConnection.key(conn)
      if (current.server === key && current.directory === directory) {
        home.selection.set({ server: key })
      } else {
        projects.project.select(conn, directory)
      }
      backToHome()
    },
    onAddProjects: projects.project.add,
    onOpenProjectNewSession: (conn: ServerConnection.Any, directory: string) => {
      const ctx = global.ensureServerCtx(conn)
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
      void tabs.newDraft({ server: ServerConnection.key(conn), directory })
    },
    onEditProject: projects.project.edit,
    onRevealProject: projects.project.reveal,
    onClearNotifications: projects.project.clearNotifications,
    onCloseProject: projects.project.close,
    onOpenArchive: () => navigate("/?archived=1"),
    onOpenSessions: () => {},
    onOpenSettings: () => navigate("/settings"),
    onOpenHelp: () => {
      if (feedbackUrl) platform.openLink(feedbackUrl)
    },
  }

  return (
    <aside
      data-component="workspace-sidebar"
      data-arforge-material="titlebar"
      data-expanded={expanded() ? "" : undefined}
      class="relative z-20 flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
      style={{ width: expanded() ? `${SIDEBAR_EXPANDED_WIDTH}px` : `${SIDEBAR_RAIL_WIDTH}px` }}
    >
      <Show
        when={expanded()}
        fallback={
          <div class="flex h-14 shrink-0 items-center justify-center">
            <TooltipV2 placement="right" value={project() ? project()!.name || project()!.worktree.split(/[\\/]/).pop()! : language.t("home.title")}>
              <button
                type="button"
                class="workspace-sidebar__rail-btn"
                onClick={() => layout.sidebar.open()}
                aria-label={language.t("command.sidebar.toggle")}
              >
                <Show when={project()} fallback={<IconV2 name="grid-plus" size="small" />}>
                  {(p) => (
                    <ProjectAvatar
                      class="!size-7"
                      fallback={p().name || p().worktree.split(/[\\/]/).pop()!}
                      src={p().icon?.url}
                      variant="outline"
                    />
                  )}
                </Show>
              </button>
            </TooltipV2>
          </div>
        }
      >
        {/* New session */}
        <div class="shrink-0 px-2 pb-1 pt-2">
          <button
            type="button"
            class="workspace-sidebar__action"
            onClick={newSession}
            aria-label={language.t("command.session.new")}
          >
            <IconV2 name="edit" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 flex-1 truncate text-left text-[13px] font-[440] text-v2-text-text-muted">
              {language.t("command.session.new")}
            </span>
          </button>
        </div>
      </Show>

      {/* Projects */}
      <Show when={expanded()}>
        <div class="workspace-sidebar__projects min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          <HomeProjectsView {...projectsViewProps} embedded />
        </div>
      </Show>

      {/* Utility nav */}
      <div class="flex shrink-0 flex-col gap-1 px-2 pb-3 pt-2">
        <Show
          when={expanded()}
          fallback={
            <div class="flex flex-col items-center gap-1">
              <For each={utilityItems}>
                {(item) => (
                  <TooltipV2 placement="right" value={item.label}>
                    <button
                      type="button"
                      class="workspace-sidebar__rail-btn"
                      onClick={item.onClick}
                      aria-label={item.label}
                    >
                      <IconV2 name={item.icon as never} size="small" />
                    </button>
                  </TooltipV2>
                )}
              </For>
            </div>
          }
        >
          <For each={utilityItems}>
            {(item) => (
              <button type="button" class="workspace-sidebar__action" onClick={item.onClick}>
                <IconV2 name={item.icon as never} size="small" class="shrink-0 text-v2-icon-icon-muted" />
                <span class="min-w-0 flex-1 truncate text-left text-[13px] font-[440] text-v2-text-text-muted">
                  {item.label}
                </span>
                <Show when={item.count?.() ?? 0 > 0}>
                  <span class="min-w-5 shrink-0 rounded-full bg-v2-background-bg-layer-02 px-1.5 text-center text-[11px] leading-5 text-v2-text-text-faint [font-weight:530]">
                    {item.count?.() ?? 0}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>
    </aside>
  )
}
