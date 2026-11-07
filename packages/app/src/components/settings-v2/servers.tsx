import { managementCopy } from "./management-state"
import { Tag } from "@arforge-ai/ui/v2/badge-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServerV2 } from "./dialog-server-v2"
import { SettingsListV2 } from "./parts/list"
import { ManagementStatus } from "./management-status"
import { ManagementDetail } from "../control-center/management-detail"
import { managementServerAddress } from "./server-presentation"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController()
  const [store, setStore] = createStore({ filter: "", selected: "", openRequest: 0 })
  const wslServers = useFilteredWslServers(() => store.filter)

  const showSearch = createMemo(
    () => controller.sortedItems().filter((item) => !isWslServer(item)).length + wslServers().length > 1,
  )

  const filtered = createMemo(() => {
    const items = controller.sortedItems().filter((item) => !isWslServer(item))
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [
          (item) => item.displayName ?? managementServerAddress(item.http.url) ?? "",
          (item) => managementServerAddress(item.http.url) ?? "",
        ],
      })
      .map((result) => result.obj)
  })
  const selected = createMemo(() =>
    controller.sortedItems().find((item) => !isWslServer(item) && ServerConnection.key(item) === store.selected),
  )
  const copy = () =>
    language.locale() === "zh"
      ? {
          address: "服务器地址",
          status: "连接状态",
          connected: "可连接",
          unavailable: "暂不可连接",
          unknown: "尚未检查",
          version: "版本",
          invalid: "地址不可用",
        }
      : language.locale() === "zht"
        ? {
            address: "伺服器位址",
            status: "連線狀態",
            connected: "可連線",
            unavailable: "暫時無法連線",
            unknown: "尚未檢查",
            version: "版本",
            invalid: "位址無法使用",
          }
        : {
            address: "Server address",
            status: "Connection status",
            connected: "Reachable",
            unavailable: "Unavailable",
            unknown: "Not checked",
            version: "Version",
            invalid: "Address unavailable",
          }
  const publicAddress = (server: ServerConnection.Any) => managementServerAddress(server.http.url) ?? copy().invalid
  const name = (server: ServerConnection.Any) => server.displayName || publicAddress(server)

  const openAdd = () => {
    dialog.push(() => <DialogServerV2 mode="add" />)
  }

  const openEdit = (server: ServerConnection.Http) => {
    dialog.push(() => <DialogServerV2 mode="edit" server={server} />)
  }

  return (
    <>
      <div
        class="settings-v2-tab-header settings-v2-servers-header"
        classList={{ "settings-v2-tab-header--stacked": showSearch() }}
      >
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("status.popover.tab.servers")}</h2>
          <AddServerMenu onAddServer={openAdd} />
        </div>
        <Show when={showSearch()}>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("dialog.server.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.server.search.placeholder")}
            />
            <Show when={store.filter}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                aria-label={managementCopy(language.locale()).clearSearch}
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => setStore("filter", "")}
              />
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-servers">
        <Show
          when={filtered().length > 0 || wslServers().length > 0}
          fallback={
            <ManagementStatus
              noResults={!!store.filter}
              empty={!store.filter}
              scope={store.filter || undefined}
              emptyText={language.t("dialog.server.empty")}
              onClearSearch={() => setStore("filter", "")}
            />
          }
        >
          <div class="arforge-management-master-detail settings-v2-connection-layout">
            <div class="arforge-management-master-content">
              <SettingsListV2>
                <WslServerSettings controller={controller} servers={wslServers} />
                <For each={filtered()}>
                  {(item) => {
                    const key = ServerConnection.key(item)
                    const health = () => controller.status()[key]
                    const isDefault = () => controller.defaultKey() === key
                    return (
                      <div class="settings-v2-servers-row">
                        <div class="settings-v2-servers-lead">
                          <ServerHealthIndicator health={health()} />
                          <div class="settings-v2-servers-copy">
                            <button
                              type="button"
                              class="settings-v2-server-select settings-v2-servers-name"
                              data-management-detail-id={key}
                              aria-expanded={selected() === item}
                              onClick={() => setStore({ selected: key, openRequest: store.openRequest + 1 })}
                            >
                              {name(item)}
                            </button>
                            <span class="settings-v2-servers-address" title={publicAddress(item)}>
                              {publicAddress(item)}
                            </span>
                            <span class="settings-v2-servers-meta">
                              <Show when={health()?.version}>v{health()?.version}</Show>
                              <Show when={health()?.version && item.type === "http"}> • </Show>
                              <Show
                                when={item.type === "http" && item.http.username}
                                fallback={
                                  <Show when={item.type === "http"}>{language.t("server.row.noUsername")}</Show>
                                }
                              >
                                {item.http.username}
                              </Show>
                            </span>
                          </div>
                        </div>
                        <div class="settings-v2-servers-actions">
                          <Show when={controller.canDefault() && isDefault()}>
                            <Tag>{language.t("dialog.server.status.default")}</Tag>
                          </Show>
                          <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                        </div>
                      </div>
                    )
                  }}
                </For>
              </SettingsListV2>
            </div>
            <Show when={selected()} keyed>
              {(item) => {
                const key = () => ServerConnection.key(item)
                const health = () => controller.status()[key()]
                return (
                  <ManagementDetail identity={key()} openRequest={store.openRequest} title={name(item)}>
                    <div class="settings-v2-connection-detail">
                      <dl class="arforge-management-definition">
                        <div>
                          <dt>{copy().address}</dt>
                          <dd>
                            <code>{publicAddress(item)}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>{copy().status}</dt>
                          <dd>
                            {health() ? (health()?.healthy ? copy().connected : copy().unavailable) : copy().unknown}
                          </dd>
                        </div>
                        <Show when={health()?.version}>
                          <div>
                            <dt>{copy().version}</dt>
                            <dd>{health()?.version}</dd>
                          </div>
                        </Show>
                        <Show when={item.http.username}>
                          <div>
                            <dt>{language.t("dialog.server.add.username")}</dt>
                            <dd>{item.http.username}</dd>
                          </div>
                        </Show>
                      </dl>
                      <div class="arforge-management-detail-actions">
                        <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                      </div>
                    </div>
                  </ManagementDetail>
                )
              }}
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}
