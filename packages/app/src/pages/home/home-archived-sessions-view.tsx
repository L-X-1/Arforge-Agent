import { Spinner } from "@arforge-ai/ui/spinner"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { DateTime } from "luxon"
import { For, Show } from "solid-js"
import { sessionTitle } from "@/utils/session-title"
import type { HomeArchivedSessionsController } from "./home-archived-sessions-controller"
import type { HomeArchivedSessionRecord } from "./home-archived-sessions-model"

export function HomeArchivedSessionsView(props: { archived: HomeArchivedSessionsController }) {
  const language = props.archived.copy.language
  return (
    <section
      data-component="home-archived-sessions"
      class="min-h-0 min-w-0 flex-1"
      aria-labelledby="home-archived-sessions-title"
      aria-busy={props.archived.data.loading()}
    >
      <div class="sticky top-0 z-30 bg-transparent pb-3 pt-4 lg:pt-6">
        <div class="mb-3 flex h-7 items-center justify-between px-1">
          <h1
            id="home-archived-sessions-title"
            class="text-[15px] tracking-[-0.13px] text-v2-text-text-base [font-weight:600]"
          >
            {language.t("home.archived")}
          </h1>
          <Show when={!props.archived.data.loading()}>
            <span class="text-[12px] text-v2-text-text-faint [font-weight:440]">
              {language.t("home.archived.count", { count: props.archived.data.count() })}
            </span>
          </Show>
        </div>
        <label
          data-arforge-material="floating"
          class={`
            flex h-9 w-full items-center gap-2 rounded-[12px] border border-v2-border-border-muted
            bg-transparent py-1 pl-3 pr-2 text-v2-icon-icon-muted
            shadow-[inset_0_1px_0_var(--arforge-highlight)]
            transition-[background-color,box-shadow,border-color] duration-[150ms] ease-out
            hover:border-v2-border-border-base focus-within:border-v2-border-border-focus motion-reduce:transition-none
          `}
        >
          <IconV2 name="magnifying-glass" />
          <input
            type="search"
            value={props.archived.query.value()}
            placeholder={language.t("home.archived.search")}
            aria-label={language.t("home.archived.search")}
            class={`
              min-w-0 flex-1 border-0 bg-transparent outline-0 text-v2-text-text-base [font-weight:440]
              placeholder:text-v2-text-text-faint
            `}
            onInput={(event) => props.archived.query.set(event.currentTarget.value)}
          />
          <Show when={props.archived.query.value()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              icon={<IconV2 name="close" size="large" />}
              aria-label={language.t("home.archived.search.clear")}
              onClick={() => props.archived.query.set("")}
            />
          </Show>
        </label>
      </div>

      <Show
        when={!props.archived.data.loading()}
        fallback={
          <div class="flex items-center justify-center gap-2 py-16 text-v2-text-text-muted" role="status">
            <Spinner class="size-4" />
            <span>{language.t("common.loading")}</span>
          </div>
        }
      >
        <Show
          when={!props.archived.data.error()}
          fallback={
            <p class="px-4 py-16 text-center text-v2-text-text-muted" role="status">
              {language.t("home.archived.loadFailed")}
            </p>
          }
        >
          <Show
            when={props.archived.data.filtered().length > 0}
            fallback={
              <div class="px-6 py-16 text-center">
                <p class="text-v2-text-text-base [font-weight:530]">
                  {props.archived.query.value()
                    ? language.t("home.archived.noResults")
                    : language.t("home.archived.empty")}
                </p>
                <p class="mt-1 text-[13px] text-v2-text-text-muted [font-weight:440]">
                  {props.archived.query.value()
                    ? language.t("home.archived.noResults.description")
                    : language.t("home.archived.empty.description")}
                </p>
              </div>
            }
          >
            <ul class="flex min-w-0 flex-col gap-1 pb-16 pt-2">
              <For each={props.archived.data.filtered()}>
                {(record) => <HomeArchivedSessionRow archived={props.archived} record={record} />}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

function HomeArchivedSessionRow(props: {
  archived: HomeArchivedSessionsController
  record: HomeArchivedSessionRecord
}) {
  const language = props.archived.copy.language
  const title = () => sessionTitle(props.record.session.title) || props.record.session.id
  const archivedAt = () =>
    DateTime.fromMillis(props.record.session.time.archived ?? props.record.session.time.updated)
      .setLocale(language.intl())
      .toLocaleString(DateTime.DATETIME_MED)
  const restoring = () => props.archived.session.pending(props.record.session, "restore")

  return (
    <li
      data-component="home-archived-session-row"
      class={`
        group/archived flex min-h-12 min-w-0 items-center gap-3 rounded-[10px] px-3 py-2
        bg-v2-background-bg-layer-01/55
        shadow-[inset_0_1px_0_var(--arforge-glass-specular),inset_0_0_0_0.5px_var(--v2-border-border-muted)]
        transition-[background-color,box-shadow] duration-[150ms] ease-out
        hover:bg-v2-background-bg-layer-01 focus-within:bg-v2-background-bg-layer-01 motion-reduce:transition-none
      `}
    >
      <div
        class={`
          flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-v2-background-bg-layer-02
          text-v2-icon-icon-muted shadow-[inset_0_1px_0_var(--arforge-highlight)]
        `}
        aria-hidden="true"
      >
        <IconV2 name="archive" size="small" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530]">
          {title()}
        </p>
        <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-v2-text-text-faint [font-weight:440]">
          <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{props.record.projectName}</span>
          <span aria-hidden="true">·</span>
          <span class="shrink-0">{language.t("home.archived.at", { time: archivedAt() })}</span>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <ButtonV2
          type="button"
          variant="ghost-muted"
          size="large"
          class="min-w-[72px]"
          disabled={restoring()}
          aria-label={language.t("home.archived.restore")}
          onClick={() => void props.archived.session.restore(props.record)}
        >
          <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            <Show when={!restoring()} fallback={<Spinner class="size-3.5" />}>
              <IconV2 name="reset" />
            </Show>
          </span>
          <span>{language.t("home.archived.restore")}</span>
        </ButtonV2>
        <MenuV2 gutter={6} modal={false} placement="bottom-end">
          <MenuV2.Trigger
            as={IconButtonV2}
            type="button"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="outline-dots" />}
            aria-label={language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.archived.session.confirmRemove(props.record)}>
                {language.t("home.archived.delete.button")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    </li>
  )
}
