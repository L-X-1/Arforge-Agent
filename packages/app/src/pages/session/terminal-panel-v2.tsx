import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { Tabs } from "@arforge-ai/ui/tabs"
import { ResizeHandle } from "@arforge-ai/ui/resize-handle"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { TooltipKeybind } from "@arforge-ai/ui/tooltip"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { KeybindV2 } from "@arforge-ai/ui/v2/keybind-v2"

import { SortableTerminalTabV2 } from "@/components/session/session-sortable-terminal-tab-v2"
import { Terminal } from "@/components/terminal"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSettings } from "@/context/settings"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { terminalPanelOperationPending, terminalPanelOperationText, type TerminalPanelAction, type TerminalPanelOperation } from "./terminal-panel-operations"
import { createSizing, focusTerminalById } from "@/pages/session/helpers"
import { getTerminalHandoff, setTerminalHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import "@/components/preview/workbench-review.css"

export function TerminalPanelV2(props: { stacked?: boolean } = {}) {
  const layout = useLayout()
  const terminal = useTerminal()
  const sdk = useSDK()
  const language = useLanguage()
  const command = useCommand()
  const settings = useSettings()
  const { workspaceKey, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const newLayout = createMemo(() => settings.general.newLayoutDesigns())
  const opened = createMemo(() => view().terminal.opened())
  const size = createSizing()
  const height = createMemo(() => layout.terminal.height())
  const close = () => view().terminal.close()
  let root: HTMLDivElement | undefined
  let tabList: HTMLDivElement | undefined

  onCleanup(() => terminal.cancelFocus())

  const [store, setStore] = createStore({
    autoCreated: false,
    recovered: {} as Record<string, boolean>,
    errors: {} as Record<string, string>,
    connections: {} as Record<string, number>,
    view: typeof window === "undefined" ? 1000 : (window.visualViewport?.height ?? window.innerHeight),
  })

  const max = () => store.view * 0.6
  const pane = () => Math.min(height(), max())
  const stacked = createMemo(() => isDesktop() && props.stacked)
  const panelHeight = createMemo(() =>
    isDesktop() ? (stacked() ? `${pane()}px` : "100%") : opened() ? `${pane()}px` : "0px",
  )
  const contentHeight = createMemo(() => (isDesktop() ? (stacked() ? `${pane()}px` : "100%") : `${pane()}px`))
  const newTerminalKeybind = createMemo(() => command.keybindParts("terminal.new"))
  const operationBusy = (action: TerminalPanelAction, id = terminal.active()) => terminalPanelOperationPending(terminal.pending, action, id)
  const activeOperation = createMemo(() => {
    const id = terminal.active()
    return (["create", "close", "clone", "update"] as const).find((operation) =>
      operation === "create" ? terminal.pending(operation) : !!id && terminal.pending(operation, id))
  })

  onMount(() => {
    if (typeof window === "undefined") return

    const sync = () => setStore("view", window.visualViewport?.height ?? window.innerHeight)
    const port = window.visualViewport

    sync()
    makeEventListener(window, "resize", sync)
    if (port) makeEventListener(port, "resize", sync)
  })

  createEffect(() => {
    if (!opened()) {
      setStore("autoCreated", false)
      return
    }

    if (!terminal.ready() || store.autoCreated) return
    // Opening an existing PTY also consumes this one-shot creation opportunity.
    // Closing its final tab must not automatically start a replacement process.
    setStore("autoCreated", true)
    if (terminal.all().length === 0 && !terminal.pending("create")) void terminal.new()
  })

  createEffect(
    on(
      () => terminal.all().length,
      (count, prevCount) => {
        if (prevCount === undefined || prevCount <= 0 || count !== 0) return
        if (!opened()) return
        close()
      },
    ),
  )

  createEffect(
    on(
      () => [opened(), terminal.active(), terminal.focusRequested(terminal.active())] as const,
      ([next, id, requested]) => {
        if (!next || !id || !requested) return
        focusTerminalById(id)
      },
    ),
  )

  createEffect(() => {
    if (opened()) return
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    if (!root?.contains(active)) return
    active.blur()
  })

  createEffect(() => {
    const dir = sdk().directory
    if (!dir) return
    if (!terminal.ready()) return
    language.locale()

    setTerminalHandoff(
      workspaceKey(),
      terminal.all().map((pty) =>
        terminalTabLabel({
          title: pty.title,
          titleNumber: pty.titleNumber,
          t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
        }),
      ),
    )
  })

  const handoff = createMemo(() => {
    const dir = sdk().directory
    if (!dir) return []
    return getTerminalHandoff(workspaceKey()) ?? []
  })

  const all = terminal.all
  const ids = createMemo(() => all().map((pty) => pty.id))

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key] || operationBusy("reconnect", id)) return
    setStore("recovered", key, true)
    void clone(id)
  }

  const terminalRecoveryKey = (pty: { id: string; title: string; titleNumber: number }) => {
    return workspaceKey() + "\u0000" + String(pty.titleNumber || pty.title || pty.id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    setStore("errors", key, "")
    trim(id)
  }

  const handleTerminalDragEnd = () => {
    const activeId = terminal.active()
    if (!activeId) return
    requestAnimationFrame(() => {
      if (terminal.active() !== activeId) return
      focusTerminalById(activeId)
    })
  }

  return (
    <aside
      ref={root}
      id="terminal-panel"
      role="region"
      aria-label={language.t("terminal.title")}
      aria-hidden={!opened()}
      inert={!opened()}
      class="arforge-review-workbench relative shrink-0 overflow-hidden bg-v2-background-bg-base"
      classList={{
        "w-full": !isDesktop() || stacked(),
        "min-w-0 h-full flex-1": isDesktop() && opened() && !stacked(),
        "w-0 h-full pointer-events-none": isDesktop() && !opened(),
        "transition-[height] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[height] motion-reduce:transition-none":
          !isDesktop() && !size.active(),
      }}
      style={{ height: panelHeight() }}
    >
      <div classList={{ "md:hidden": !stacked(), hidden: stacked() }} onPointerDown={() => size.start()}>
        <ResizeHandle
          classList={{
            "-top-1": newLayout(),
          }}
          direction="vertical"
          size={pane()}
          min={100}
          max={max()}
          collapseThreshold={50}
          onResize={(next) => {
            size.touch()
            layout.terminal.resize(next)
          }}
          onCollapse={close}
        />
      </div>
      <div
        class="absolute inset-0 flex flex-col overflow-hidden"
        classList={{
          "border-t border-border-weak-base": opened() && !isDesktop(),
          "border-t border-border-weaker-base": opened() && stacked() && !newLayout(),
          "border-l border-border-weaker-base": opened() && isDesktop() && !newLayout(),
          "border-t border-v2-border-border-muted": opened() && stacked() && newLayout(),
          "border-l border-v2-border-border-muted": opened() && isDesktop() && !stacked() && newLayout(),
          "pointer-events-none": !opened(),
        }}
        style={{ height: contentHeight() }}
      >
        <Show
          when={terminal.ready()}
          fallback={
            <div class="flex flex-col h-full pointer-events-none">
              <div class="h-10 flex items-center gap-2 px-2 border-b border-border-weaker-base bg-v2-background-bg-base overflow-hidden">
                <For each={handoff()}>
                  {(title) => (
                    <div class="px-2 py-1 rounded-md bg-surface-base text-14-regular text-text-weak truncate max-w-40">
                      {title}
                    </div>
                  )}
                </For>
                <div class="flex-1" />
                <div class="text-text-weak pr-2">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              </div>
              <div class="flex-1 flex items-center justify-center text-text-weak">{language.t("terminal.loading")}</div>
            </div>
          }
        >
          <DragDropProvider
            sensors={[
              PointerSensor.configure({
                activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                preventActivation: (event) =>
                  event.target instanceof Element &&
                  !!event.target.closest('[data-slot="tabs-trigger-close-button"], input, [contenteditable="true"]'),
              }),
            ]}
            modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => tabList ?? null })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragEnd={(event) => {
              const source = event.operation.source
              if (!event.canceled && isSortable(source) && source.initialIndex !== source.index) {
                terminal.move(source.id.toString(), source.index)
              }
              handleTerminalDragEnd()
            }}
          >
            <div class="flex flex-col h-full">
              <Tabs
                variant={newLayout() ? "normal" : "alt"}
                value={terminal.active()}
                onChange={(id) => terminal.open(id)}
                class={newLayout() ? "!h-12 !flex-none" : "!h-auto !flex-none"}
              >
                <Tabs.List
                  ref={tabList}
                  class={newLayout() ? "border-b border-v2-border-border-muted" : "h-10 border-b border-border-weaker-base"}
                  onPointerDown={(event: PointerEvent & { currentTarget: HTMLDivElement }) => {
                    const active = document.activeElement
                    if (event.target === active) return
                    if (active instanceof HTMLInputElement && event.currentTarget.contains(active)) active.blur()
                  }}
                >
                  <For each={all()}>
                    {(pty, index) => (
                      <SortableTerminalTabV2 terminal={pty} index={index} newLayout={newLayout()} onClose={close} />
                    )}
                  </For>
                  <div class="h-full flex items-center justify-center">
                    <Show
                      when={newLayout()}
                      fallback={
                        <TooltipKeybind
                          title={language.t("command.terminal.new")}
                          keybind={command.keybind("terminal.new")}
                          class="flex items-center"
                        >
                          <IconButton
                            icon="plus-small"
                            variant="ghost"
                            iconSize="large"
                            disabled={operationBusy("create")}
                            onClick={() => { if (!operationBusy("create")) void terminal.new({ focus: true }) }}
                            aria-label={language.t("command.terminal.new")}
                          />
                        </TooltipKeybind>
                      }
                    >
                      <TooltipV2
                        value={
                          <>
                            {language.t("command.terminal.new")}
                            <Show when={newTerminalKeybind().length > 0}>
                              <KeybindV2 keys={newTerminalKeybind()} variant="neutral" />
                            </Show>
                          </>
                        }
                        placement="bottom"
                        class="flex items-center"
                      >
                        <IconButton
                          icon="plus-small"
                          variant="ghost"
                          iconSize="large"
                          disabled={operationBusy("create")}
                            onClick={() => { if (!operationBusy("create")) void terminal.new({ focus: true }) }}
                          aria-label={language.t("command.terminal.new")}
                        />
                      </TooltipV2>
                    </Show>
                  </div>
                </Tabs.List>
              </Tabs>
              <Show when={terminal.operationError()}>
                {(error) => (
                  <div role="alert" data-slot="terminal-operation-error" class="flex shrink-0 items-center gap-2 border-b border-border-weaker-base px-3 py-2 text-12-regular text-text-strong">
                    <span class="min-w-0 flex-1">{terminalPanelOperationText(error().operation, language.locale().startsWith("zh"))}</span>
                    <button type="button" onClick={() => terminal.dismissOperationError()}>{language.t("common.close")}</button>
                  </div>
                )}
              </Show>
              <Show when={activeOperation()}>
                {(operation) => <div role="status" aria-live="polite" class="shrink-0 px-3 py-1 text-12-regular text-text-weak">{terminalPanelOperationText(operation() as TerminalPanelOperation, language.locale().startsWith("zh"), false)}</div>}
              </Show>
              <div data-slot="terminal-workbench-actions">
                <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak" title={sdk().directory}>{sdk().directory}</span>
                <button type="button" disabled={operationBusy("reconnect")} onClick={() => {
                  const id = terminal.active()
                  if (!id || operationBusy("reconnect", id)) return
                  setStore("connections", id, (store.connections[id] ?? 0) + 1)
                  terminal.requestFocus(id)
                }}>{language.locale().startsWith("zh") ? "重新连接" : "Reconnect"}</button>
                <button type="button" disabled={operationBusy("close")} onClick={() => {
                  const id = terminal.active()
                  if (!id || operationBusy("close", id) || !window.confirm(language.locale().startsWith("zh") ? "停止并关闭当前终端？此终端中运行的进程可能会结束，其他终端不受影响。" : "Stop and close this terminal? Its running process may end. Other terminals are unaffected.")) return
                  void terminal.bind().close(id)
                }}>{language.locale().startsWith("zh") ? "停止当前终端" : "Stop current terminal"}</button>
              </div>
              <Show when={all().find((pty) => pty.id === terminal.active())}>{(pty) =>
                <Show when={store.errors[terminalRecoveryKey(pty())]}>{(error) => <p role="alert" class="px-3 py-2 text-12-regular text-text-weak">{error()}</p>}</Show>
              }</Show>
              <Show when={all().length === 0}>
                <div role="status" class="p-4 text-13-regular text-text-weak">
                  {language.locale().startsWith("zh") ? "尚无可用终端。可使用新建终端按钮重试；连接和权限由当前服务器处理。" : "No terminal is available yet. Use New terminal to retry; connection and permissions are handled by the current server."}
                </div>
              </Show>
              <div class="flex-1 min-h-0 relative">
                <Show when={opened() && terminal.active()} keyed>
                  {(id) => {
                    const ops = terminal.bind()
                    const connectionWorkspace = workspaceKey()
                    return (
                      <Show when={all().find((pty) => pty.id === id)}>
                        {(pty) => (
                          <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                            <Show when={(store.connections[id] ?? 0) + 1} keyed>{(_connection) =>
                            <Terminal
                              pty={pty()}
                              autoFocus={terminal.focusRequested(id)}
                              onAutoFocus={() => terminal.consumeFocus(id)}
                              class="!px-[14px]"
                              onConnect={() => {
                                if (workspaceKey() !== connectionWorkspace) return
                                markTerminalConnected(terminalRecoveryKey(pty()), id, ops.trim)
                              }}
                              onCleanup={ops.update}
                              onConnectError={() => {
                                if (workspaceKey() !== connectionWorkspace) return
                                setStore("errors", terminalRecoveryKey(pty()), language.locale().startsWith("zh")
                                  ? "终端连接失败。请检查连接和权限后重连。"
                                  : "Terminal connection failed. Check the connection and permissions before reconnecting.")
                                recoverTerminal(terminalRecoveryKey(pty()), id, ops.clone)
                              }}
                            />
                            }</Show>
                          </div>
                        )}
                      </Show>
                    )
                  }}
                </Show>
              </div>
            </div>
          </DragDropProvider>
        </Show>
      </div>
    </aside>
  )
}
