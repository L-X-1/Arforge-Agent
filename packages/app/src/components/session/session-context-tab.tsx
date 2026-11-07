import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@arforge-ai/core/util/encode"
import { findLast } from "@arforge-ai/core/util/array"
import { same } from "@/utils/same"
import { Icon } from "@arforge-ai/ui/icon"
import { Accordion } from "@arforge-ai/ui/accordion"
import { StickyAccordionHeader } from "@arforge-ai/ui/sticky-accordion-header"
import { File } from "@arforge-ai/session-ui/file"
import { Markdown } from "@arforge-ai/session-ui/markdown"
import { ScrollView } from "@arforge-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@arforge-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useLocal } from "@/context/local"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getConfirmedSessionContext } from "./session-context-metrics"
import { contextCopy, contextServerLabel } from "./session-context-copy"
import { ContextPreviewChanged, contextReadRevision, createContextPreviewController, type ContextPreviewState } from "./session-context-preview"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"
import { managementErrorText } from "@/components/settings-v2/management-state"
import "@/components/preview/workbench-review.css"
import "./session-context.css"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div data-slot="context-stat" class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServerSDK()
  const local = useLocal()
  const copy = createMemo(() => contextCopy(language.locale()))
  const providers = useProviders(() => sdk().directory)
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getConfirmedSessionContext(messages(), [...providers.all().values()]))
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const capacity = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
  const sampledLimit = createMemo(() => capacity(ctx()?.limit))
  const sampledUsage = createMemo(() => {
    const usage = ctx()?.usage
    return sampledLimit() !== undefined && typeof usage === "number" && Number.isFinite(usage) ? usage : undefined
  })
  const selectedModel = createMemo(() => local.model.current())
  const busy = createMemo(() => {
    const status = params.id ? sync().data.session_status[params.id] : undefined
    return !!status && status.type !== "idle"
  })
  const scope = createMemo(() => JSON.stringify([
    sdk().scope, sdk().directory, params.id, selectedModel()?.provider.id, selectedModel()?.id,
    selectedModel()?.limit.context, selectedModel()?.limit.input, selectedModel()?.limit.output,
    local.model.variant.current(), info()?.time.updated, info()?.revert?.messageID, busy(),
    sync().data.config.compaction, messages().map(message => [message.id, message.time.created,
      message.role === "assistant" ? message.time.completed : undefined]),
  ]))
  const [preview, setPreview] = createStore<ContextPreviewState>({ phase: "closed" })
  const previewController = createContextPreviewController({
    update: next => setPreview({ phase: next.phase, snapshot: next.snapshot, error: next.error }),
    capture: () => {
      const id = params.id
      if (!id) return
      const sessionID = id as Parameters<ReturnType<typeof server>["operationsApi"]["sessions"]["get"]>[0]["sessionID"]
      const origin = scope(), source = server(), bound = sdk(), model = selectedModel()
      const directory = bound.directory
      return {
        key: origin,
        isCurrent: () => scope() === origin && server() === source && sdk() === bound,
        read: async () => {
          const [session, context] = await Promise.all([
            source.operationsApi.sessions.get({ sessionID }),
            source.operationsApi.sessions.context({ sessionID }),
          ])
          if (session.id !== sessionID || session.location.directory !== directory) throw new ContextPreviewChanged()
          return {
            sessionID: session.id, directory: session.location.directory, projectID: session.projectID,
            updatedAt: session.time.updated, sampledAt: Date.now(),
            revision: await contextReadRevision({ session, context }),
            contextJSON: JSON.stringify(context, null, 2),
            candidates: context.map(message => ({ id: message.id, type: message.type, createdAt: message.time.created })),
          }
        },
        compact: async (snapshot) => {
          if (!model || busy()) throw new ContextPreviewChanged()
          return bound.api.session.compact({ sessionID, model: { providerID: model.provider.id, modelID: model.id, variant: local.model.variant.current() }, expectedContext: snapshot.contextJSON, expectedDirectory: snapshot.directory })
        },
      }
    },
  })
  createEffect(on(() => [scope(), server(), sdk()], () => previewController.invalidate(), { defer: true }))
  onCleanup(() => previewController.dispose())
  const previewWorking = () => ["loading", "checking", "submitting"].includes(preview.phase)
  const previewError = () => {
    const error = preview.error
    if (error instanceof ContextPreviewChanged) return copy().stale
    if (!error) return ""
    const nested = typeof error === "object" && "data" in error ? error.data : undefined
    return managementErrorText(nested ?? error, copy().readError).slice(0, 500)
  }

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length, systemPrompt()],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.input,
          systemPrompt: systemPrompt(),
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(sampledLimit()) },
    { label: "context.stats.totalTokens", value: () => formatter().number(ctx()?.total) },
    { label: "context.stats.usage", value: () => formatter().percent(sampledUsage()) },
    { label: "context.stats.inputTokens", value: () => formatter().number(ctx()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(ctx()?.message.tokens.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(ctx()?.message.tokens.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () =>
        `${formatter().number(ctx()?.message.tokens.cache.read)} / ${formatter().number(ctx()?.message.tokens.cache.write)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="arforge-review-workbench @container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="arforge-context-panel" data-component="session-context-accounting">
        <section class="arforge-context-section arforge-context-summary" aria-label={copy().confirmed}>
          <h2>{copy().confirmed}</h2>
          <p class="arforge-context-note">{ctx() ? copy().accounting : copy().noConfirmed}</p>
          <div class="arforge-context-summary-grid">
            <Stat label={copy().sampledUsage} value={formatter().percent(sampledUsage())} />
            <Stat label={copy().tokens} value={formatter().number(ctx()?.total)} />
            <Stat label={copy().cost} value={cost()} />
          </div>
        </section>
        <div class="arforge-context-owner-budget">
        <section class="arforge-context-section" aria-label={copy().source}>
          <h2>{copy().source}</h2>
          <div class="arforge-context-source">
            <Stat label={copy().server} value={contextServerLabel(sdk().url)} />
            <Stat label={copy().directory} value={sdk().directory} />
            <Stat label={copy().session} value={params.id ?? "—"} />
          </div>
        </section>
        <section class="arforge-context-section" aria-label={copy().budget}>
          <h2>{copy().budget}</h2>
          <Stat label={copy().selectedModel} value={selectedModel()
            ? `${selectedModel()!.provider.id} / ${selectedModel()!.id}` : copy().unknown} />
          <div class="arforge-context-grid">
            <Stat label={copy().context} value={formatter().number(capacity(selectedModel()?.limit.context))} />
            <Stat label={copy().input} value={formatter().number(selectedModel()?.limit.input)} />
            <Stat label={copy().output} value={formatter().number(selectedModel()?.limit.output)} />
          </div>
        </section>
        </div>
        <details class="arforge-context-section arforge-context-accounting-detail" open>
          <summary><h2>{copy().details}</h2></summary>
          <div class="arforge-context-accounting-body">
          <div class="arforge-context-grid">
            <Stat label={copy().sample} value={ctx()?.message.id ?? copy().unknown} />
            <Stat label={copy().settledAt} value={formatter().time(ctx()?.message.time.completed)} />
            <Stat label={copy().sampledModel} value={ctx()
              ? `${ctx()!.message.providerID} / ${ctx()!.message.modelID}` : copy().unknown} />
          </div>
        <div data-slot="context-stats" class="arforge-context-grid">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>
          </div>
        </details>

        <section class="arforge-context-section" aria-label={copy().estimate}>
          <h2>{copy().estimate}</h2>
          <p class="arforge-context-note">{copy().estimateBasis}</p>
          <p class="arforge-context-note">{copy().loaded}: {counts().all} · {messages()[0]?.id ?? "—"} → {messages().at(-1)?.id ?? "—"}</p>
          <Show when={!ctx()?.input}><p class="arforge-context-note">{copy().noEstimate}</p></Show>
        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>
        </section>

        <section class="arforge-context-section" aria-label={copy().preview} data-component="context-compression-preview">
          <h2>{copy().preview}</h2>
          <p class="arforge-context-note">{copy().readonly}</p>
          <div class="arforge-context-actions">
            <button class="arforge-context-action" type="button" disabled={!params.id || previewWorking()}
              onClick={() => void previewController.open()}>{preview.phase === "closed" ? copy().open : copy().refresh}</button>
            <Show when={preview.phase !== "closed"}>
              <button class="arforge-context-action" type="button" disabled={previewWorking()}
                onClick={() => previewController.close()}>{copy().close}</button>
            </Show>
          </div>
          <Show when={previewWorking()}><p class="arforge-context-note" role="status">{preview.phase === "loading" ? copy().loading : preview.phase === "checking" ? copy().checking : copy().submitting}</p></Show>
          <Show when={previewError()}><p class="arforge-context-note" role="alert">{previewError()}</p></Show>
          <Show when={preview.snapshot}>{snapshot => <>
            <div class="arforge-context-grid">
              <Stat label={copy().recordedAt} value={formatter().time(snapshot().sampledAt)} />
              <Stat label={copy().revision} value={snapshot().revision} />
              <Stat label={copy().keep} value={copy().unknownRange} />
              <Stat label={copy().compact} value={copy().unknownRange} />
              <Stat label={copy().existing} value={snapshot().candidates.filter(message => message.type === "compaction").length} />
            </div>
            <p class="arforge-context-note">{copy().candidates}: {snapshot().candidates.length}</p>
            <ul class="arforge-context-candidates" aria-label={copy().candidates}>
              <For each={snapshot().candidates}>{message => <li><span>{message.type} · {message.id}</span><span>{formatter().time(message.createdAt)}</span></li>}</For>
            </ul>
            <Show when={!snapshot().candidates.length}><p class="arforge-context-note">{copy().none}</p></Show>
            <details class="arforge-context-input-json">
              <summary>{copy().inputJSON}</summary>
              <pre>{snapshot().contextJSON}</pre>
            </details>
            <p class="arforge-context-note">{copy().unknownResult}</p>
            <p class="arforge-context-note">{copy().rangeCaveat}</p>
            <p class="arforge-context-note">{copy().confirmNote}</p>
            <Show when={!selectedModel() || busy()}><p class="arforge-context-note" role="status">{busy() ? copy().busy : copy().modelMissing}</p></Show>
            <button class="arforge-context-action" type="button" disabled={!selectedModel() || busy() || !snapshot().candidates.length || !["ready", "error"].includes(preview.phase)}
              onClick={() => void previewController.confirm()}>{copy().confirm}</button>
          </>}</Show>
          <Show when={preview.phase === "admitted"}><p class="arforge-context-note" role="status">{copy().admitted}</p></Show>
        </section>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{language.t("context.systemPrompt.title")}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
