import { ScrollView } from "@arforge-ai/ui/scroll-view"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { createEffect, createMemo, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useSearchParams, type RouteSectionProps } from "@solidjs/router"
import { createHomeArchivedSessionsController } from "./home/home-archived-sessions-controller"
import { HomeArchivedSessionsView } from "./home/home-archived-sessions-view"
import { createHomeController, type HomeController } from "./home/home-controller"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { useSessionNavigation } from "./home/session-navigation"
import { HomeFirstRunGuide } from "@/components/onboarding/home-first-run-guide"
import { serverName } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"
import { HomeRecentSessions } from "./home/home-recent-sessions"
import { HomeProjectPicker } from "./home/home-project-picker"
import { homeCopy } from "./home/home-copy"
import { managementCopy } from "@/components/settings-v2/management-state"
import "./home/home-launchpad.css"

export type NewHomeProps = Partial<RouteSectionProps> & {
  home?: HomeController
  /** The app route supplies HomeCompose beneath its real, source-bound draft providers. */
  compose?: (home: HomeController) => JSX.Element
}

export function NewHome(props: NewHomeProps = {}) {
  const home = props.home ?? createHomeController()
  const [searchParams, setSearchParams] = useSearchParams<{ archived?: string; history?: string }>()
  // The archived view is driven by the URL so sidebar navigation can switch
  // between overview and archive without remounting this route.
  const page = createMemo(() =>
    searchParams.archived === "1" ? "archived" : searchParams.history === "1" ? "history" : "start",
  )
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
  const openHistory = () => setSearchParams({ archived: undefined, history: "1" })
  const search = createHomeSessionSearchController(home, sessions, { onFocus: openHistory })
  const scroll = createHomeScrollController(sessions.data.groups)
  const language = sessions.copy.language
  const copy = () => homeCopy(language.locale(), language.t("session.new.title"))
  const recoveryCopy = () => managementCopy(language.locale())
  const offline = () => {
    const conn = home.server.focused()
    return !!conn && home.server.health(conn)?.healthy === false
  }
  const guideConnection = (): "loading" | "ready" | "offline" => {
    const conn = home.server.focused()
    const healthy = conn ? home.server.health(conn)?.healthy : undefined
    return healthy === undefined ? "loading" : healthy ? "ready" : "offline"
  }
  const guideScope = () => `${home.selection.value().server}\u0000${home.server.healthScope()}\u0000${home.selection.value().directory ?? home.project.newSession()?.worktree ?? ""}`
  const [connectionRetry, setConnectionRetry] = createStore({ scope: "", pending: false, error: undefined as unknown })
  let connectionRequest: { scope: string; promise: Promise<void> } | undefined
  const retryingConnection = () => connectionRetry.scope === guideScope() && connectionRetry.pending
  const connectionRetryError = () => connectionRetry.scope === guideScope() ? connectionRetry.error : undefined
  const retryConnection = () => {
    const scope = guideScope()
    if (connectionRequest?.scope === scope) return connectionRequest.promise
    setConnectionRetry({ scope, pending: true, error: undefined })
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await home.server.refreshHealth()
        if (scope !== guideScope() || !result?.healthy) return
        await sessions.data.retry()
      } catch (error) {
        if (scope === guideScope()) setConnectionRetry("error", error ?? language.t("common.requestFailed"))
      }
    }).finally(() => {
      if (connectionRequest?.promise !== promise) return
      connectionRequest = undefined
      setConnectionRetry("pending", false)
    })
    connectionRequest = { scope, promise }
    return promise
  }
  const openStart = () => setSearchParams({ archived: undefined, history: undefined })
  const openArchived = () => setSearchParams({ archived: "1", history: undefined })
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
        thumbContainer={() => (page() === "history" ? scroll.viewport.thumbTrack() : undefined)}
        thumbHoverTarget={() => (page() === "history" ? scroll.viewport.hoverTarget() : undefined)}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div class="home-launchpad__content" data-view={page()}>
          <nav class="home-launchpad__navigation" aria-label={language.t("home.title")}>
            <Show when={page() !== "start"}>
              <button type="button" class="home-launchpad__action" onClick={openStart}>
                {copy().back || language.t("home.title")}
              </button>
            </Show>
            <Show when={page() !== "history"}>
              <button type="button" class="home-launchpad__action" onClick={openHistory}>
                {copy().history || language.t("sidebar.project.viewAllSessions")}
              </button>
            </Show>
            <Show when={page() !== "archived"}>
              <button type="button" class="home-launchpad__action" onClick={openArchived}>
                {language.t("home.archived")}
              </button>
            </Show>
          </nav>
          <div class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] text-v2-text-text-muted">
            <Show when={home.server.focused()}>{(conn) => <span>{serverName(conn())}</span>}</Show>
            <Show when={home.project.selected()}>
              {(project) => <span title={project().worktree}>{displayName(project())}</span>}
            </Show>
          </div>
          <Show when={offline() || retryingConnection() || connectionRetryError()}>
            <div class="workspace-sidebar__notice" role={offline() || connectionRetryError() ? "alert" : "status"} aria-busy={retryingConnection()}>
              <span>{offline() ? language.t("session.error.serverConnection") : connectionRetryError() ? language.t("common.requestFailed") : language.t("common.loading")}</span>
              <button data-action="home-health-retry" type="button" disabled={retryingConnection()} onClick={() => void retryConnection()}>
                {retryingConnection() ? language.t("common.loading") : recoveryCopy().retryRead}
              </button>
            </div>
          </Show>
          <Show
            when={page() === "archived"}
            fallback={
              <>
                <Show when={sessions.data.pinFailures() > 0}>
                  <div class="workspace-sidebar__notice" role="status">
                    <span>{sessions.copy.language.t("common.requestFailed")}</span>
                    <button type="button" onClick={() => void sessions.data.retry()}>
                      {recoveryCopy().retryRead}
                    </button>
                  </div>
                </Show>
                <Show
                  when={page() === "history"}
                  fallback={
                    <>
                      <Show
                        when={props.compose}
                        fallback={
                          <section data-component="home-start-session" class="flex flex-col items-center gap-6">
                            <HomeProjectPicker home={home} />
                            <h1 class="home-launchpad__title">{copy().start}</h1>
                            <ButtonV2
                              data-action="home-new-session"
                              variant="neutral"
                              icon="edit"
                              disabled={!sessions.session.canCreate() || guideConnection() !== "ready"}
                              onClick={sessions.session.create}
                            >
                              {language.t("command.session.new")}
                            </ButtonV2>
                          </section>
                        }
                      >
                        {(compose) => compose()(home)}
                      </Show>
                      <HomeRecentSessions sessions={sessions} onViewAll={openHistory} />
                      <HomeFirstRunGuide
                        canStart={sessions.session.canCreate()}
                        connection={guideConnection()}
                        scope={guideScope()}
                        onRetry={retryConnection}
                        onStart={sessions.session.create}
                      />
                    </>
                  }
                >
                  <HomeSessions sessions={sessions} search={search} scroll={scroll} />
                </Show>
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
