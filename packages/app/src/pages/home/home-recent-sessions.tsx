import { For, Show, createMemo } from "solid-js"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { Spinner } from "@arforge-ai/ui/spinner"
import type { HomeSessionsController } from "./home-sessions-controller"
import { HomeSessionRow } from "./home-sessions-view"

export function HomeRecentSessions(props: { sessions: HomeSessionsController; onViewAll: () => void }) {
  const language = props.sessions.copy.language
  // searchRecords is sorted by last activity by the existing data owner. Only
  // this presentation is limited; the index, search and history remain intact.
  const recent = createMemo(() => props.sessions.data.searchRecords().slice(0, 3))

  return (
    <section
      data-component="home-recent-sessions"
      aria-labelledby="home-recent-title"
      aria-busy={props.sessions.data.loading()}
    >
      <div class="flex min-h-11 items-center justify-between gap-4 px-3">
        <h2 id="home-recent-title" class="text-[13px] font-medium text-v2-text-text-muted">
          {language.t("sidebar.project.recentSessions")}
        </h2>
        <button type="button" class="home-launchpad__action" onClick={props.onViewAll}>
          {language.t("sidebar.project.viewAllSessions")}
          <IconV2 name="chevron-down" size="small" class="-rotate-90" />
        </button>
      </div>
      <Show
        when={!props.sessions.data.error()}
        fallback={
          <div class="workspace-sidebar__notice" role="alert">
            <span>{language.t("common.requestFailed")}</span>
            <button type="button" onClick={() => void props.sessions.data.retry()}>
              {language.t("common.retry")}
            </button>
          </div>
        }
      >
        <Show
          when={!props.sessions.data.loading()}
          fallback={
            <div class="flex min-h-11 items-center gap-2 px-3 text-[13px] text-v2-text-text-muted" role="status">
              <Spinner class="size-4" />
              {language.t("common.loading")}
            </div>
          }
        >
          <Show
            when={recent().length > 0}
            fallback={
              <p class="px-3 py-3 text-[13px] text-v2-text-text-muted">
                {language.t("home.sessions.empty.description")}
              </p>
            }
          >
            <For each={recent()}>
              {(record) => (
                <HomeSessionRow
                  record={record}
                  language={language}
                  showProjectName={props.sessions.session.showProjectName}
                  server={props.sessions.session.server}
                  isOpenTab={props.sessions.tab.isOpen}
                  onOpenSession={props.sessions.session.open}
                  onArchiveSession={props.sessions.session.archive}
                />
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
