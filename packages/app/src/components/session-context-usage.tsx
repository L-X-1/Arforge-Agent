import { Match, Show, Switch, createMemo, type ComponentProps, type JSX } from "solid-js"
import { ProgressCircle } from "@arforge-ai/ui/progress-circle"
import { ProgressCircleV2 } from "@arforge-ai/ui/v2/progress-circle-v2"
import { Button } from "@arforge-ai/ui/button"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { createMediaQuery } from "@solid-primitives/media"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { getConfirmedSessionContext } from "@/components/session/session-context-metrics"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { contextCopy, contextServerLabel } from "@/components/session/session-context-copy"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSettings } from "@/context/settings"
import "@/components/session/session-context.css"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  buttonAppearance?: "default" | "v2"
  placement?: ComponentProps<typeof TooltipV2>["placement"]
}

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span data-context-value class="ml-auto min-w-0 text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  args.view.reviewPanel.open(args.view.reviewPanel.opened() ? "other" : "context-button")
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const sdk = useSDK()
  const local = useLocal()
  const copy = createMemo(() => contextCopy(language.locale()))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const settings = useSettings()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const variant = createMemo(() => props.variant ?? "button")
  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
    fileBrowser: () => settings.general.newLayoutDesigns() && isDesktop() && !!params.id,
  })
  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const context = createMemo(() => getConfirmedSessionContext(messages(), [...providers.all().values()]))
  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })
  const contextVisible = createMemo(() => view().reviewPanel.opened() && tabState.activeTab() === "context")
  const hasOtherTabs = createMemo(() =>
    tabs()
      .all()
      .some((tab) => tab !== "context" && tab !== "review"),
  )

  const openContext = () => {
    if (!params.id) return

    const sessionView = view()
    if (contextVisible()) {
      tabs().close("context")
      if (sessionView.reviewPanel.source() === "context-button" && !hasOtherTabs()) sessionView.reviewPanel.close()
      return
    }

    openSessionContext({
      view: sessionView,
      layout,
      tabs: tabs(),
    })
  }

  const circle = () => (
    <div class="flex items-center justify-center" data-usage-known={context()?.usage != null} aria-label={context()?.usage == null ? copy().unknown : `${context()!.usage}%`}>
      <ProgressCircle
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={
          variant() === "indicator"
            ? {
                "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
                "--progress-circle-background-overlay": "var(--v2-overlay-simple-overlay-pressed, transparent)",
                "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
              }
            : undefined
        }
      />
    </div>
  )
  const circleV2 = () => (
    <div class="flex items-center justify-center" data-usage-known={context()?.usage != null} aria-label={context()?.usage == null ? copy().unknown : `${context()!.usage}%`}>
      <ProgressCircleV2 percentage={context()?.usage ?? 0} />
    </div>
  )

  const tooltipValue = () => (
    <div class="arforge-context-tooltip">
      <strong>{copy().confirmed}</strong>
      <ContextTooltipRow name={copy().cost} value={cost()} />
      <ContextTooltipRow name={copy().sampledUsage} value={formatter().percent(context()?.usage)} />
      <ContextTooltipRow
        name={copy().tokens}
        value={formatter().number(context()?.total)}
      />
      <ContextTooltipRow name={copy().sample} value={context()?.message.id ?? copy().unknown} />
      <ContextTooltipRow name={copy().settledAt} value={formatter().time(context()?.message.time.completed)} />
      <ContextTooltipRow name={copy().sampledModel} value={context()
        ? `${context()!.message.providerID} / ${context()!.message.modelID}` : copy().unknown} />
      <ContextTooltipRow name={copy().selectedModel} value={local.model.current()
        ? `${local.model.current()!.provider.id} / ${local.model.current()!.id}` : copy().unknown} />
      <ContextTooltipRow name={copy().context} value={formatter().number((local.model.current()?.limit.context ?? 0) > 0 ? local.model.current()?.limit.context : undefined)} />
      <ContextTooltipRow name={copy().server} value={contextServerLabel(sdk().url)} />
      <ContextTooltipRow name={copy().directory} value={sdk().directory} />
      <ContextTooltipRow name={copy().session} value={params.id ?? copy().unknown} />
      <p class="arforge-context-note">{context() ? copy().accounting : copy().noConfirmed}</p>
    </div>
  )

  return (
    <Show when={params.id}>
      <TooltipV2 value={tooltipValue()} placement={props.placement ?? "top"} shift={-8}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={buttonAppearance() === "v2"}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              icon={circleV2()}
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            />
          </Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </TooltipV2>
    </Show>
  )
}
