import { For, Show } from "solid-js"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import "./file-tabs.css"

/** This menu activates existing tab IDs; it never promotes or recreates a preview tab. */
export function FileTabsMenu(props: {
  tabs: readonly string[]
  active?: string
  label: (tab: string) => string
  dirty: (tab: string) => boolean
  temporary: (tab: string) => boolean
  onSelect: (tab: string) => void
}) {
  const language = useLanguage()
  const t = (zh: string, en: string) => language.locale().startsWith("zh") ? zh : en
  return (
    <div
      class="session-file-tabs-overflow-slot"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="chevron-down"
          variant="ghost"
          aria-label={t("全部标签", "All tabs")}
          title={t("全部标签", "All tabs")}
        />
        <DropdownMenu.Portal>
<DropdownMenu.Content data-workbench-file-tabs-menu="">
            <For each={props.tabs}>{(tab) => (
              <DropdownMenu.Item
                aria-current={props.active === tab ? "page" : undefined}
                onSelect={() => props.onSelect(tab)}
              >
                <DropdownMenu.ItemLabel>
                  <span data-slot="file-tabs-menu-label" title={props.label(tab)}>{props.label(tab)}</span>
                  <Show when={props.temporary(tab)}>
                    <span data-slot="file-tabs-menu-meta">{t("临时预览", "Preview")}</span>
                  </Show>
                  <Show when={props.dirty(tab)}>
                    <span data-slot="file-tab-dirty" role="img" aria-label={t("未保存的修改", "Unsaved changes")} />
                  </Show>
                  <Show when={props.active === tab}>
                    <span data-slot="file-tabs-menu-meta">{t("当前", "Current")}</span>
                  </Show>
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            )}</For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}
