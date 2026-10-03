import { ScrollView } from "@arforge-ai/ui/scroll-view"
import { Mark } from "@arforge-ai/ui/logo"
import { createEffect, createSignal, Show } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { createHomeArchivedSessionsController } from "./home/home-archived-sessions-controller"
import { HomeArchivedSessionsView } from "./home/home-archived-sessions-view"
import { createHomeController } from "./home/home-controller"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { useSessionNavigation } from "./home/session-navigation"
import { HomeFirstRunGuide } from "@/components/onboarding/home-first-run-guide"
import { serverName } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"

export function NewHome() {
  const home = createHomeController()
  const [searchParams, setSearchParams] = useSearchParams<{ archived?: string }>()
  const [page, setPage] = createSignal<"sessions" | "archived">("sessions")
  // The archived view is driven by the URL so sidebar navigation can switch
  // between overview and archive without remounting this route.
  createEffect(() => {
    setPage(searchParams.archived === "1" ? "archived" : "sessions")
  })
  // Selecting a project (e.g. from the sidebar) while on the archived view
  // returns to that project's session overview. Only reacts to an actual
  // directory change, never to the archived query itself.
  let lastSelectionDir: string | undefined
  let selectionInitialized = false
  createEffect(() => {
    const directory = home.selection.value().directory
    if (!selectionInitialized) {
      selectionInitialized = true
      lastSelectionDir = directory
      return
    }
    if (directory === lastSelectionDir) return
    lastSelectionDir = directory
    if (searchParams.archived === "1" && directory) {
      setSearchParams({ archived: undefined })
    }
  })
  const navigation = useSessionNavigation()
  const sessions = createHomeSessionsController(home, { pins: navigation.targets })
  const archived = createHomeArchivedSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const openSessions = () => setPage("sessions")
  const openArchived = () => setPage("archived")
  const channel = import.meta.env.VITE_ARFORGE_CHANNEL
  return (
    <div
      data-component="home-launchpad"
      data-arforge-material="main"
      class={`
        relative min-h-0 flex-1 self-stretch overflow-hidden rounded-tl-[16px] rounded-bl-[16px]
      `}
    >
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div class="workspace-home__brand mx-auto flex w-full items-center gap-2.5">
          <Mark class="size-5" />
          <span class="font-mono text-[15px] font-bold leading-none tracking-[0.14em] text-v2-text-text-base">
            ARFORGE
          </span>
          <Show when={channel && ["beta", "dev"].includes(channel)}>
            <span class="rounded-[6px] bg-v2-background-bg-accent/12 px-1.5 py-0.5 text-[10px] font-[530] leading-none uppercase tracking-wide text-v2-text-text-accent">
              {channel}
            </span>
          </Show>
        </div>
        <div class="workspace-home__content mx-auto min-h-full w-full pb-16">
          <div class="workspace-home__scope">
            <Show when={home.server.focused()}>{(conn) => <span>{serverName(conn())}</span>}</Show>
            <Show when={home.project.selected()}>
              {(project) => <span title={project().worktree}>{displayName(project())}</span>}
            </Show>
          </div>
          <Show
            when={page() === "archived"}
            fallback={
              <>
                <Show when={sessions.data.pinFailures() > 0}>
                  <div class="workspace-sidebar__notice" role="status">
                    <span>{sessions.copy.language.t("common.requestFailed")}</span>
                    <button type="button" onClick={() => void sessions.data.retry()}>
                      {sessions.copy.language.t("common.retry")}
                    </button>
                  </div>
                </Show>
                <HomeFirstRunGuide canStart={sessions.session.canCreate()} onStart={sessions.session.create} />
                <HomeSessions sessions={sessions} search={search} scroll={scroll} />
              </>
            }
          >
            <HomeArchivedSessionsView archived={archived} />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
