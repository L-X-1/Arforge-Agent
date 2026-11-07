import { managementCopy } from "./management-state"
import { useFilteredList } from "@arforge-ai/ui/hooks"
import { ProviderIcon } from "@arforge-ai/ui/provider-icon"
import { Switch } from "@arforge-ai/ui/v2/switch-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { ManagementDetail } from "../control-center/management-detail"
import { ManagementStatus } from "./management-status"
import { ModelTooltip } from "../model-tooltip"
import { useServerSDK } from "@/context/server-sdk"
import "./settings-v2.css"
import "./model-configuration.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

export const SettingsModelsV2: Component = () => {
  const source = useServerSDK()
  return <Show when={source()} keyed>{(_source) => <SettingsModelsContent />}</Show>
}

const SettingsModelsContent: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const sdk = useServerSDK()
  const [selection, setSelection] = createStore({ provider: "", key: "", openRequest: 0, current: (): boolean => false })
  const selected = createMemo(() => selection.current()
    ? models.list().find(item => `${item.provider.id}:${item.id}` === selection.key) : undefined)
  const select = (item: ModelItem) => {
    const source = sdk()
    setSelection({ provider: item.provider.id, key: `${item.provider.id}:${item.id}`, openRequest: selection.openRequest + 1, current: () => sdk() === source })
  }
  const searchableModels = createMemo(() => models.list().map(item => {
    const inputs = Object.entries(item.capabilities.input).filter(([, enabled]) => enabled).map(([name]) => name)
    const capabilityText = [
      ...inputs,
      ...(inputs.includes("image") ? ["vision", "图像", "图像输入"] : []),
      ...(inputs.includes("text") ? ["文字", "文本"] : []),
      ...(item.capabilities.reasoning ? ["reasoning", "推理"] : []),
      ...(item.capabilities.toolcall ? ["tool", "tools", "工具"] : []),
    ].join(" ")
    return { ...item, capabilityText }
  }))

  const list = useFilteredList<ModelItem & { capabilityText: string }>({
    items: (_filter) => searchableModels(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id", "capabilityText"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })
  const activeProvider = createMemo(() => {
    const groups = list.grouped.latest ?? []
    return groups.find(group => group.category === selection.provider)?.category ?? groups[0]?.category
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={list.filter()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              aria-label={managementCopy(language.locale()).clearSearch}
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => list.clear()}
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <div class="settings-v2-model-configuration">
          <Show when={list.flat().length > 0}>
            <nav class="settings-v2-model-provider-nav" aria-label={language.t("settings.providers.title")}>
              <h3>{language.t("settings.providers.title")}</h3>
              <For each={list.grouped.latest}>{group => (
                <button type="button" aria-current={activeProvider() === group.category ? "page" : undefined}
                  onClick={() => setSelection("provider", group.category)}>
                  <ProviderIcon id={group.category} width={PROVIDER_ICON_SIZE} height={PROVIDER_ICON_SIZE} />
                  <span>{group.items[0].provider.name}</span><span class="settings-v2-provider-model-count">{group.items.length}</span>
                </button>
              )}</For>
            </nav>
          </Show>
        <div class="arforge-management-master-detail settings-v2-connection-layout settings-v2-model-config-detail">
        <div class="arforge-management-master-content">
        <ManagementStatus loading={list.grouped.loading} initialLoading={!list.grouped.latest?.length} />
        <Show
          when={!list.grouped.loading || list.grouped.latest?.length}
          fallback={
            <></>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <ManagementStatus noResults={!!list.filter()} empty={!list.filter()}
                emptyText={language.t("dialog.model.empty")} onClearSearch={() => list.clear()} />
            }
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <Show when={activeProvider() === group.category}>
                <div class="settings-v2-section" data-component="settings-models-provider">
                  <div class="settings-v2-models-group-header">
                    <ProviderIcon
                      id={group.category}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-models-provider-icon shrink-0"
                    />
                    <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
                  </div>
                  <SettingsListV2>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <SettingsRowV2 title={<button type="button" class="settings-v2-model-select"
                            data-management-detail-id={`${item.provider.id}:${item.id}`}
                            onClick={() => select(item)}>{item.name}</button>} description={item.id} density="double">
                            <div>
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </SettingsRowV2>
                        )
                      }}
                    </For>
                  </SettingsListV2>
                </div>
                </Show>
              )}
            </For>
          </Show>
        </Show>
        </div>
        <Show when={selected()?.provider.id === activeProvider() ? selected() : undefined}>{item => (
          <ManagementDetail identity={`${item().provider.id}:${item().id}`} openRequest={selection.openRequest} title={item().name}>
            <div class="settings-v2-connection-detail settings-v2-model-inspector">
              <ModelTooltip model={item()} v2 />
              <Switch checked={models.visible({ providerID: item().provider.id, modelID: item().id })}
                onChange={checked => models.setVisibility({ providerID: item().provider.id, modelID: item().id }, checked)}>
                {item().name}
              </Switch>
            </div>
          </ManagementDetail>
        )}</Show>
        </div>
        </div>
      </div>
    </>
  )
}
