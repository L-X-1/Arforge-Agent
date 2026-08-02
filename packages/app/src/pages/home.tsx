import { ScrollView } from "@arforge-ai/ui/scroll-view"
import { createSignal, Show } from "solid-js"
import { createHomeArchivedSessionsController } from "./home/home-archived-sessions-controller"
import { HomeArchivedSessionsView } from "./home/home-archived-sessions-view"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

export function NewHome() {
  const home = createHomeController()
  const [page, setPage] = createSignal<"sessions" | "archived">("sessions")
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const archived = createHomeArchivedSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const openSessions = () => setPage("sessions")
  const openArchived = () => setPage("archived")
  return (
    <div
      data-component="home-launchpad"
      data-arforge-material="main"
      class={`
        m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[16px]
        border border-v2-border-border-muted bg-transparent
        shadow-[inset_0_1px_0_var(--arforge-highlight),var(--v2-elevation-raised)]
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
        <div
          class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
        >
          <HomeProjects
            projects={projects}
            scroll={scroll}
            archiveSelected={() => page() === "archived"}
            archiveCount={archived.data.count}
            onOpenArchive={openArchived}
            onOpenSessions={openSessions}
          />
          <Show
            when={page() === "archived"}
            fallback={<HomeSessions sessions={sessions} search={search} scroll={scroll} />}
          >
            <HomeArchivedSessionsView archived={archived} />
          </Show>
          <HomeUtilityNav
            class="flex lg:hidden"
            archiveSelected={() => page() === "archived"}
            archiveCount={archived.data.count}
            onOpenArchive={openArchived}
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
