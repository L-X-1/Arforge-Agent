import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  For,
  JSX,
  onCleanup,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@arforge-ai/ui/button"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { ScrollView } from "@arforge-ai/ui/scroll-view"
import { Tag } from "@arforge-ai/ui/tag"
import { Dialog } from "@arforge-ai/ui/dialog"
import { List } from "@arforge-ai/ui/list"
import { Tooltip } from "@arforge-ai/ui/tooltip"
import { Icon } from "@arforge-ai/ui/v2/icon"
import { Tag as TagV2 } from "@arforge-ai/ui/v2/badge-v2"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { decode64 } from "@/utils/base64"
import { handleDocumentSearchKeydown } from "@/utils/search-keydown"
import { createEventListener } from "@solid-primitives/event-listener"
import { matchesModelSearch } from "./dialog-select-model-search"
import { afterModelMenuClose } from "./dialog-select-model-dismissal"
import type { ModelSelectionBinding } from "./dialog-select-model-binding"
import { createModelDialogSelection } from "./dialog-select-model-controller"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "arforge" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const modelKey = (model: ModelItem) => `${model.provider.id}:${model.id}`
const manageKey = "action:manage"

const sortModelGroups = (a: { category: string; items: ModelItem[] }, b: { category: string; items: ModelItem[] }) => {
  const aIndex = popularProviders.indexOf(a.category)
  const bIndex = popularProviders.indexOf(b.category)
  const aPopular = aIndex >= 0
  const bPopular = bIndex >= 0

  if (aPopular && !bPopular) return -1
  if (!aPopular && bPopular) return 1
  if (aPopular && bPopular) return aIndex - bIndex
  return a.items[0].provider.name.localeCompare(b.items[0].provider.name)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
  binding?: ModelSelectionBinding
}> = (props) => {
  const selection = createModelDialogSelection({
    get model() { return props.model },
    get binding() { return props.binding },
    onSelect: () => props.onSelect(),
  })
  const model = selection.model
  const language = useLanguage()
  const current = createMemo(() => {
    const choice = selection.currentChoice()
    return choice ? model().list().find((item) => item.provider.id === choice.providerID && item.id === choice.modelID) : undefined
  })

  const models = createMemo(() =>
    model()
      .list()
      .filter((m) => model().visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <>
    <Show when={selection.unavailable()}>{(reason) => <div class="px-3 pb-2 text-13-regular text-text-base" role="status">
      <div>{selection.copy()[reason()]}</div>
      <div class="break-all font-mono">{selection.currentChoice()?.providerID} / {selection.currentChoice()?.modelID}</div>
    </div>}</Show>
    <Show when={selection.state.error || selection.state.catalogError}>
      <div class="px-3 pb-2 text-13-regular text-text-base" role="alert">{selection.state.error || selection.copy().stale}</div>
    </Show>
    <Show when={!selection.ready() && !selection.state.stale}>
      <div class="px-3 pb-2 text-13-regular text-text-base" role="status">{language.t("common.loading")}</div>
    </Show>
    <Show when={selection.unavailable() || selection.state.error || selection.state.catalogError}>
      <Button variant="ghost" class="self-start" disabled={selection.busy() || selection.state.stale} onClick={() => void selection.refresh()}>
        {selection.state.refreshing ? language.t("common.loading") : selection.copy().retry}
      </Button>
    </Show>
    <List
      class={`flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          openDelay={0}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        if (x) void selection.select(x)
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular" aria-disabled={!selection.ready() || selection.busy()}>
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
    </>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  binding?: ModelSelectionBinding
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            binding={props.binding}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export { ModelSelectorPopoverV2, type ModelSelectionBinding } from "./dialog-select-model-v2"

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState; binding?: ModelSelectionBinding }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const directory = () => decode64(local.slug())

  const provider = () => {
    void import("./dialog-connect-provider").then((x) => {
      void dialog.show(() => <x.DialogConnectProvider directory={directory} />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={props.model} binding={props.binding} onSelect={() => dialog.close()} />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
