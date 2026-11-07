import { createEffect, createMemo, createUniqueId, onCleanup, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { FileIcon } from "@arforge-ai/ui/file-icon"
import { Icon } from "@arforge-ai/ui/icon"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { ProviderIcon } from "@arforge-ai/ui/provider-icon"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@arforge-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { AttachmentCardV2 } from "../attachment-card-v2"
import { CommentCardV2 } from "../comment-card-v2"
import { typeLabel } from "../../../components/message-file"
import type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2Prompt,
  PromptInputV2Suggestion,
} from "./types"
import type { PromptInputV2Interaction, PromptInputV2SelectControl } from "./interaction"
import { promptInputIsComposing } from "./editor-selection"
import { consumePromptMenuOutsidePress } from "./menu-dismissal"
import { useI18n } from "@arforge-ai/ui/context/i18n"
import "./presentation.css"

export type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2Suggestion,
} from "./types"

export type PromptInputV2Mode = "normal" | "shell"

export type PromptInputV2Props = {
  controller: PromptInputV2Interaction
  disabled?: boolean
  readOnly?: boolean
  borderUnderlay?: boolean
  class?: string
  modelControl?: JSX.Element
  permissionControl?: JSX.Element
  hideAgentControl?: boolean
  labels?: {
    removeAttachment: string
    agent: string
    model: string
    variant: string
    dropFiles: string
    editor: string
  }
  attachKeybind?: string[]
  attachShortcut?: string
  goal?: PromptInputV2GoalControl
  addMenu?: {
    title: string
    files: string
    commands: string
    context: string
    shell: string
    filesDescription?: string
    commandsDescription?: string
    contextDescription?: string
    shellDescription?: string
  }
}

export type PromptInputV2GoalControl = {
  enabled: () => boolean
  active: () => boolean
  canSelect: () => boolean
  label: () => string
  menuTitle: () => string
  menuDescription: () => string
  onToggle: () => void
}

export function PromptInputV2(props: PromptInputV2Props) {
  const i18n = useI18n()
  const labels = () =>
    props.labels ??
    (i18n.locale().startsWith("zh")
      ? {
          removeAttachment: "移除附件",
          agent: "选择代理",
          model: "选择模型",
          variant: "选择模型变体",
          dropFiles: "拖放文件以添加附件",
          editor: "输入消息",
        }
      : {
          removeAttachment: "Remove attachment",
          agent: "Choose agent",
          model: "Choose model",
          variant: "Choose model variant",
          dropFiles: "Drop files to attach",
          editor: "Prompt",
        })
  const state = props.controller.state
  const view = props.controller.view
  let editor: HTMLDivElement | undefined
  let localInput = false
  let composing = false
  const updateCursor = () => {
    if (!editor || !window.getSelection()?.isCollapsed) return
    props.controller.onCursor(promptInputV2Cursor(editor))
  }
  const mode = createMemo(() => state.mode)
  const buttons = createMemo(() => ({
    opacity: mode() === "normal" ? 1 : 0,
    "pointer-events": mode() === "normal" ? ("auto" as const) : ("none" as const),
    transition: "opacity 140ms ease",
  }))
  const editorOptions = () => ({
    removeLabel: labels().removeAttachment,
    disabled: props.disabled || props.readOnly,
    isComposing: () => composing,
  })

  createEffect(() => {
    const parts = props.controller.parts()
    const options = editorOptions()
    if (!editor) return
    if (localInput) {
      localInput = false
      return
    }
    renderPromptInputV2Editor(editor, parts, options)
  })

  return (
    <div class={`relative size-full flex flex-col gap-0 ${props.class ?? ""}`}>
      <input
        ref={props.controller.setFileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh"
        class="hidden"
        onCancel={() => props.controller.cancelAttachmentPicker()}
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list) props.controller.addAttachments(Array.from(list))
          event.currentTarget.value = ""
        }}
      />
      <Show when={state.popover.type !== "closed"}>
        <PromptInputV2Popover
          emptyLabel="No matching items"
          items={props.controller.suggestions()}
          activeID={state.popover.type === "closed" ? undefined : state.popover.activeID}
          search={
            state.popover.type === "command-menu"
              ? {
                  value: state.popover.query,
                  label: "Commands",
                  placeholder: "/",
                  onValueChange: props.controller.setQuery,
                  onKeyDown: props.controller.onKeyDown,
                }
              : undefined
          }
          onActiveChange={(item) => props.controller.dispatch({ type: "popover.active", id: item.id })}
          onSelect={(item) => props.controller.dispatch({ type: "popover.select", item })}
        />
      </Show>
      <form
        data-component="prompt-input-v2"
        data-arforge-material="floating"
        data-dock-border-underlay={props.borderUnderlay ? "v2" : undefined}
        class="group/prompt-input relative min-h-[96px] w-full overflow-hidden rounded-[20px] border border-[var(--arforge-hairline)] bg-transparent"
        classList={{
          "shadow-[var(--v2-elevation-raised)]": !props.borderUnderlay,
          "border border-v2-icon-icon-info border-dashed": state.drag === "active",
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.disabled && !props.readOnly && !composing) props.controller.submit()
        }}
        onDragEnter={props.controller.onDragEnter}
        onDragOver={props.controller.onDragOver}
        onDragLeave={props.controller.onDragLeave}
        onDrop={props.controller.onDrop}
      >
        <Show when={state.drag === "active"}>
          <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-v2-background-bg-base/90 text-v2-text-text-base">
            {labels().dropFiles}
          </div>
        </Show>

        <Show when={state.mode === "normal"}>
          <PromptInputV2Attachments
            attachments={props.controller.attachments()}
            comments={props.controller.comments()}
            activeCommentID={state.activeContextID}
            removeLabel={labels().removeAttachment}
            onAttachmentClick={props.controller.openAttachment}
            onAttachmentRemove={(attachment) => props.controller.removeAttachment(attachment.id)}
            onCommentClick={(comment) => props.controller.toggleContext(comment.key)}
            onCommentRemove={(comment) => props.controller.removeContext(comment.key)}
          />
        </Show>

        <div class="relative min-h-[60px]">
          <div
            ref={(element) => {
              editor = element
              props.controller.setEditor(element)
              renderPromptInputV2Editor(element, props.controller.parts(), editorOptions())
            }}
            data-component="prompt-input"
            data-slot="prompt-input-editor"
            role="textbox"
            aria-multiline="true"
            aria-label={labels().editor}
            contenteditable={!props.disabled && !props.readOnly}
            autocapitalize={state.mode === "normal" ? "sentences" : "off"}
            autocorrect={state.mode === "normal" ? "on" : "off"}
            spellcheck={state.mode === "normal"}
            // @ts-expect-error
            autocomplete="off"
            class="relative z-10 block min-h-[60px] max-h-[180px] w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-4 pt-4 pb-2 text-[13px] font-[440] leading-5 text-v2-text-text-base focus:outline-none [&_[data-mention=file]]:text-syntax-property [&_[data-mention=agent]]:text-syntax-type [&_[data-mention=reference]]:text-syntax-keyword"
            classList={{ "font-mono!": state.mode === "shell", "opacity-50": props.disabled }}
            onInput={(event) => {
              const cursor = promptInputV2Cursor(event.currentTarget)
              const prompt = parsePromptInputV2Editor(event.currentTarget)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
            onCompositionStart={() => {
              composing = true
            }}
            onCompositionEnd={() => {
              composing = false
            }}
            onBlur={props.controller.captureSelection}
            onKeyDown={(event) => {
              if (promptInputIsComposing(event, composing)) return
              if (props.disabled || props.readOnly) return
              if (props.controller.onKeyDown(event)) return
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                if (event.repeat) return
                props.controller.submit()
              }
            }}
            onKeyUp={updateCursor}
            onPointerUp={updateCursor}
            onPaste={props.controller.onPaste}
            onFocus={() => props.controller.dispatch({ type: "focus.editor" })}
          />
          <Show
            when={
              !props.controller.value() &&
              !props.controller.parts().some((part) => part.type === "file" && part.source?.type === "resource")
            }
          >
            <div
              data-slot="prompt-input-placeholder"
              class="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
              classList={{ "font-mono!": state.mode === "shell" }}
            >
              {view.placeholder?.() ??
                (state.mode === "shell" ? "输入 Shell 命令…" : "输入消息，/ 查看命令，@ 添加上下文…")}
            </div>
          </Show>
        </div>

        <div data-slot="prompt-input-footer" class="flex min-h-11 items-end gap-1 px-2 py-1.5 min-[521px]:items-center">
          <div
            data-slot="prompt-input-controls"
            class="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-hidden"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <PromptInputV2AddMenu
              disabled={state.mode === "shell"}
              title={props.addMenu?.title ?? "添加图片和文件"}
              keybind={props.attachKeybind ?? ["Mod", "U"]}
              attachLabel={props.addMenu?.files ?? "图片和文件"}
              attachShortcut={props.attachShortcut ?? "Mod+U"}
              commandsLabel={props.addMenu?.commands ?? "命令"}
              contextLabel={props.addMenu?.context ?? "上下文"}
              shellLabel={props.addMenu?.shell ?? "Shell 命令"}
              descriptions={props.addMenu}
              onAttach={props.controller.attach}
              onCommands={props.controller.openCommands}
              onContext={props.controller.openContext}
              onShell={props.controller.openShell}
              goal={props.goal}
            />
            <Show when={props.goal?.enabled()}>
              <ButtonV2
                type="button"
                variant="ghost-muted"
                size="normal"
                class="text-text-warning"
                aria-pressed={props.goal?.enabled()}
                disabled={props.goal?.active()}
                onClick={props.goal?.onToggle}
              >
                <IconV2 name="status-active" />
                <span>{props.goal?.label()}</span>
              </ButtonV2>
            </Show>
            <Show when={!props.hideAgentControl}>
              <Show when={view.agent}>
                {(control) => (
                  <PromptInputV2ConfiguredSelect title={labels().agent} keybind={["Mod", "."]} control={control()} agent />
                )}
              </Show>
            </Show>
            {props.permissionControl}
          </div>
          <div
            data-slot="prompt-input-model-controls"
            class="flex min-w-0 flex-wrap items-center justify-end gap-1"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <Show
              when={props.modelControl}
              fallback={
                <Show when={view.model}>
                  {(control) => (
                    <PromptInputV2ConfiguredSelect
                      title={labels().model}
                      keybind={["Mod", "M"]}
                      control={control()}
                      model
                    />
                  )}
                </Show>
              }
            >
              {props.modelControl}
            </Show>
            <Show when={view.variant}>
              {(control) => (
                <Show when={control().options().length > 1}>
                  <PromptInputV2ConfiguredSelect
                    title={labels().variant}
                    keybind={["Shift", "Mod", "D"]}
                    control={control()}
                  />
                </Show>
              )}
            </Show>
          </div>
          <PromptInputV2SubmitButton
            mode={state.mode}
            stopping={view.submit.stopping()}
            disabled={props.disabled || props.readOnly || !props.controller.canSubmit()}
            sendLabel="Send"
            stopLabel="Stop"
            onSubmit={props.controller.submit}
            onStop={props.controller.stop}
          />
        </div>
      </form>
    </div>
  )
}

// Keep provenance on the actual non-editable node, never in user-controlled HTML.
const editorMentions = new WeakMap<HTMLElement, Extract<PromptInputV2Prompt[number], { type: "file" | "agent" }>>()

export function renderPromptInputV2Editor(
  editor: HTMLDivElement,
  prompt: PromptInputV2Prompt,
  options?: { removeLabel: string; disabled?: boolean; isComposing?: () => boolean },
) {
  const active = document.activeElement === editor
  editor.replaceChildren(
    ...prompt.flatMap<Node>((part) => {
      if (part.type === "image") return []
      if (part.type === "text") return [document.createTextNode(part.content)]
      const mention = document.createElement("span")
      mention.textContent = part.content
      mention.contentEditable = "false"
      editorMentions.set(mention, part)
      mention.dataset.mention =
        part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
      if (part.type === "agent") mention.dataset.name = part.name
      if (part.type === "file") {
        mention.dataset.path = part.path
        if (part.mime) mention.dataset.mime = part.mime
        if (part.filename) mention.dataset.filename = part.filename
        if (part.source?.type === "resource" && !part.content) {
          const label = `${part.source.clientName}: ${part.filename || part.source.uri}`
          mention.dataset.resourceLabel = label
          mention.title = `${part.source.clientName}: ${part.source.uri}`
          mention.setAttribute(
            "aria-label",
            options ? `${options.removeLabel}: ${label} (${part.source.uri})` : `${label} (${part.source.uri})`,
          )
          mention.classList.add("before:content-[attr(data-resource-label)]")
          if (options) {
            mention.setAttribute("role", "button")
            mention.tabIndex = 0
            if (options.disabled) mention.setAttribute("aria-disabled", "true")
            mention.classList.add(
              "inline-flex",
              "gap-1",
              "after:content-['×']",
              "cursor-pointer",
              "focus-visible:outline",
              "focus-visible:outline-2",
              "focus-visible:outline-offset-2",
              "focus-visible:outline-[var(--v2-border-border-focus)]",
            )
            const remove = (event: Event) => {
              if (options.disabled || options.isComposing?.() || !editor.contains(mention)) return
              event.preventDefault()
              event.stopPropagation()
              const range = document.createRange()
              range.setStartBefore(mention)
              range.collapse(true)
              mention.remove()
              editor.focus()
              const selection = window.getSelection()
              selection?.removeAllRanges()
              selection?.addRange(range)
              editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }))
            }
            mention.addEventListener("click", remove)
            mention.addEventListener("keydown", (event) => {
              if (promptInputIsComposing(event, options.isComposing?.())) return
              if (["Enter", " ", "Backspace", "Delete"].includes(event.key)) remove(event)
            })
          }
        }
      }
      return [mention]
    }),
  )
  if (!active) return
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function parsePromptInputV2Editor(editor: HTMLDivElement) {
  const parts: Exclude<PromptInputV2Prompt[number], PromptInputV2Attachment>[] = []
  let buffer = ""
  let position = 0

  const flush = () => {
    if (!buffer) return
    parts.push({ type: "text", content: buffer, start: position, end: position + buffer.length })
    position += buffer.length
    buffer = ""
  }
  const mention = (element: HTMLElement) => {
    flush()
    const content = element.textContent ?? ""
    const original = editorMentions.get(element)
    if (element.dataset.mention === "agent") {
      parts.push({
        type: "agent",
        name: element.dataset.name ?? content.slice(1),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    parts.push({
      ...(original?.type === "file" ? original : {}),
      type: "file",
      path: element.dataset.path ?? content.slice(1),
      content,
      start: position,
      end: position + content.length,
      ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
      ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
    })
    position += content.length
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      mention(node)
      return
    }
    if (node.tagName === "BR") {
      // Chromium uses a lone BR as the placeholder for an empty block line.
      // The sibling block boundary below already represents that line break.
      const parent = node.parentElement
      if (parent !== editor && parent && ["DIV", "P"].includes(parent.tagName) && parent.childNodes.length === 1) return
      buffer += "\n"
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  Array.from(editor.childNodes).forEach((node, index, nodes) => {
    const block = node instanceof HTMLElement && ["DIV", "P"].includes(node.tagName)
    const previous = nodes[index - 1]
    if (block && index > 0 && !(previous instanceof HTMLElement && ["DIV", "P", "BR"].includes(previous.tagName)))
      buffer += "\n"
    visit(node)
    if (block && index < nodes.length - 1) buffer += "\n"
  })
  flush()
  if (
    parts.every((part) => part.type === "text") &&
    parts.every((part) => part.content.replace(/[\n\u200B]/g, "") === "")
  ) {
    return [{ type: "text" as const, content: "", start: 0, end: 0 }]
  }
  if (parts.length > 0) return parts
  return [{ type: "text" as const, content: "", start: 0, end: 0 }]
}

function promptInputV2Cursor(editor: HTMLDivElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

export function PromptInputV2Attachments(props: {
  attachments: PromptInputV2Attachment[]
  comments?: PromptInputV2Comment[]
  activeCommentID?: string
  removeLabel: string
  onAttachmentClick?: (attachment: PromptInputV2Attachment) => void
  onAttachmentRemove: (attachment: PromptInputV2Attachment) => void
  onCommentClick?: (comment: PromptInputV2Comment) => void
  onCommentRemove?: (comment: PromptInputV2Comment) => void
}) {
  return (
    <Show when={props.attachments.length > 0 || (props.comments?.length ?? 0) > 0}>
      <div data-slot="prompt-attachments" class="relative">
        <div
          data-slot="prompt-attachments-scroll"
          class="flex flex-nowrap gap-2 overflow-x-auto no-scrollbar px-2 pt-2 pb-1"
        >
          <For each={props.comments ?? []}>
            {(comment) => (
              <div class="relative group shrink-0">
                <TooltipV2
                  value={comment.comment}
                  placement="top"
                  openDelay={800}
                  contentClass="max-w-[300px] break-words"
                >
                  <CommentCardV2
                    comment={comment.comment ?? ""}
                    path={comment.path}
                    selection={comment.selection}
                    active={comment.key === props.activeCommentID}
                    onClick={() => props.onCommentClick?.(comment)}
                  />
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onCommentRemove?.(comment)}
                  class="absolute -top-1 -right-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
          <For each={props.attachments}>
            {(attachment) => (
              <div class="relative group shrink-0">
                <TooltipV2 value={attachment.filename} placement="top" contentClass="break-all">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <AttachmentCardV2 title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime)}
                      </AttachmentCardV2>
                    }
                  >
                    <button
                      type="button"
                      data-slot="prompt-attachment-preview"
                      aria-label={attachment.filename}
                      onClick={() => props.onAttachmentClick?.(attachment)}
                    >
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.filename}
                        class="w-[58px] h-[46px] rounded-[6px] object-cover"
                      />
                    </button>
                    <div class="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-base)] pointer-events-none" />
                  </Show>
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onAttachmentRemove(attachment)}
                  class="absolute -top-1 -right-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
        </div>
        <div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)]" />
        <div class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)]" />
      </div>
    </Show>
  )
}

export function PromptInputV2AddMenu(props: {
  disabled?: boolean
  title: string
  keybind?: string[]
  attachLabel: string
  attachShortcut?: string
  commandsLabel: string
  contextLabel: string
  shellLabel: string
  descriptions?: {
    filesDescription?: string
    commandsDescription?: string
    contextDescription?: string
    shellDescription?: string
  }
  onAttach: () => void
  onCommands: () => void
  onContext: () => void
  onShell: () => void
  goal?: PromptInputV2GoalControl
}) {
  const [surface, setSurface] = createStore({ open: false, width: 320 })
  let trigger: HTMLButtonElement | undefined
  createEffect(() => {
    if (!surface.open) return
    const form = trigger?.closest("form")
    const update = () =>
      setSurface(
        "width",
        Math.max(0, Math.min(760, form?.getBoundingClientRect().width ?? 320, window.innerWidth - 16)),
      )
    update()
    const observer = form ? new ResizeObserver(update) : undefined
    if (form) observer?.observe(form)
    window.addEventListener("resize", update)
    onCleanup(() => {
      observer?.disconnect()
      window.removeEventListener("resize", update)
    })
  })
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={4} modal={false} placement="top-start" onOpenChange={(open) => setSurface("open", open)}>
        <MenuV2.Trigger
          as={IconButtonV2}
          ref={trigger}
          data-action="prompt-attach"
          type="button"
          icon={<IconV2 name="plus" />}
          variant="ghost-muted"
          size="large"
          disabled={props.disabled}
          aria-label={props.title}
        />
        <MenuV2.Portal>
          <MenuV2.Content
            data-prompt-attachment-menu
            onPointerDownOutside={(event) => consumePromptMenuOutsidePress(event.detail.originalEvent)}
            style={{ width: `${surface.width}px`, "min-width": "0px", "max-width": "calc(100vw - 16px)" }}
          >
            <MenuV2.Item
              onSelect={props.onAttach}
              shortcut={
                props.keybind?.length ? <KeybindV2 keys={props.keybind} variant="neutral" /> : props.attachShortcut
              }
            >
              <PromptMenuLabels label={props.attachLabel} description={props.descriptions?.filesDescription} />
            </MenuV2.Item>
            <Show when={props.goal}>
              {(goal) => (
                <MenuV2.Item onSelect={goal().onToggle} disabled={!goal().canSelect()}>
                  <div class="flex min-w-0 flex-col">
                    <span class="text-13-medium">{goal().menuTitle()}</span>
                    <span class="truncate text-11-regular text-text-weak">{goal().menuDescription()}</span>
                  </div>
                </MenuV2.Item>
              )}
            </Show>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={props.onCommands} shortcut={<KeybindV2 keys={["/"]} variant="neutral" />}>
              <PromptMenuLabels label={props.commandsLabel} description={props.descriptions?.commandsDescription} />
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onContext} shortcut={<KeybindV2 keys={["@"]} variant="neutral" />}>
              <PromptMenuLabels label={props.contextLabel} description={props.descriptions?.contextDescription} />
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onShell} shortcut={<KeybindV2 keys={["!"]} variant="neutral" />}>
              <PromptMenuLabels label={props.shellLabel} description={props.descriptions?.shellDescription} />
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

function PromptMenuLabels(props: { label: string; description?: string; multiline?: boolean; descriptionID?: string }) {
  return (
    <span data-slot="prompt-menu-labels">
      <span>{props.label}</span>
      <Show when={props.description}>
        {(description) => <span id={props.descriptionID} data-slot="prompt-menu-description" classList={{ "whitespace-pre-line normal-case": !!props.multiline }}>{description()}</span>}
      </Show>
    </span>
  )
}

function PromptInputV2ConfiguredSelect(props: {
  title: string
  keybind?: string[]
  control: PromptInputV2SelectControl
  model?: boolean
  agent?: boolean
}) {
  const current = () => props.control.current()
  const providerID = () => props.control.options().find((option) => option.id === current())?.providerID
  return (
    <PromptInputV2Select
      title={props.title}
      keybind={props.control.keybind?.() ?? props.keybind}
      options={props.control.options()}
      current={current()}
      currentIcon={
        <Show when={props.model && providerID()}>
          <ProviderIcon id={providerID()!} class="size-4 shrink-0 opacity-60" />
        </Show>
      }
      onSelect={props.control.onSelect}
      search={props.agent}
      scope={props.agent ? props.control.scope?.() : undefined}
      configure={props.agent && props.control.configure ? {
        label: props.control.configure.label(), run: props.control.configure.run,
      } : undefined}
    />
  )
}

export function PromptInputV2Select(props: {
  title: string
  keybind?: string[]
  options: PromptInputV2Option[]
  current: string
  currentIcon?: JSX.Element
  menuWidth?: number
  class?: string
  onOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
  /** Only the Agent control opts in; permission/model/variant menus keep their existing behavior. */
  search?: boolean
  scope?: string
  configure?: { label: string; run: () => void }
}) {
  const i18n = useI18n()
  const [state, setState] = createStore({ open: false, query: "", scope: props.scope })
  let selectTrigger: HTMLButtonElement | undefined
  let searchInput: HTMLInputElement | undefined
  let searchFocusTimer: ReturnType<typeof setTimeout> | undefined
  let searchFocusGeneration = 0
  const cancelSearchFocus = () => {
    searchFocusGeneration++
    if (searchFocusTimer !== undefined) clearTimeout(searchFocusTimer)
    searchFocusTimer = undefined
  }
  onCleanup(cancelSearchFocus)
  // Equal source values must not retrigger Kobalte's autofocus effect through prop dependencies.
  const source = createMemo(() => props.scope)
  const preserveSearchFocus = (event: PointerEvent) => {
    // Restoring results can move an item under a stationary mouse. Keep typing focus;
    // deliberate presses, touch scrolling and keyboard navigation retain their own behavior.
    if (props.search && event.pointerType === "mouse" && event.buttons === 0 && document.activeElement === searchInput)
      event.preventDefault()
  }
  const preserveSearchOnLeave = (event: PointerEvent) => {
    // Kobalte's item-leave handler focuses the menu even when default is prevented.
    // Capture the native nonbubbling event before that handler while typing owns focus.
    if (props.search && event.pointerType === "mouse" && event.buttons === 0 && document.activeElement === searchInput &&
      event.target instanceof Element && event.target.matches('[role^="menuitem"]'))
      event.stopPropagation()
  }
  // Each Agent menu keeps the source it opened for, including deferred close callbacks.
  const menu = createMemo(() => !props.search ? { scope: undefined } : state.open ? { scope: state.scope } : undefined)
  const searchLabel = () => i18n.locale().startsWith("zh") ? "搜索代理" : "Search agents"
  const clearLabel = () => i18n.locale().startsWith("zh") ? "清除搜索" : "Clear search"
  const filtered = createMemo(() => {
    const query = state.query.trim().toLocaleLowerCase()
    return !props.search || !query ? props.options : props.options.filter(option =>
      [option.id, option.label, option.description].some(value => value?.toLocaleLowerCase().includes(query)))
  })
  // A disposed old menu retains its original callback owner even if a new scope reopens the menu.
  const actions = createMemo(() => {
    const owner = source()
    const current = () => !props.search || (state.open && state.scope === owner && source() === owner)
    return {
      select: (id: string) => {
        if (current() && (!props.search || props.options.some(option => option.id === id))) props.onSelect(id)
      },
      configure: () => { if (current()) props.configure?.run() },
    }
  })
  createEffect(() => {
    if (props.search && state.open && state.scope !== source()) {
      cancelSearchFocus()
      setState({ open: false, query: "" })
    }
  })
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={4} modal={false} placement="top-start" open={props.search ? state.open : undefined}
        onOpenChange={open => {
          if (props.search) {
            cancelSearchFocus()
            setState({ open, query: "", ...(open ? { scope: source() } : {}) })
          }
          props.onOpenChange?.(open)
        }}>
        <MenuV2.Trigger
          ref={selectTrigger}
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          class={`max-w-[220px] justify-start ![font-weight:400] ${props.class ?? ""}`}
          aria-label={props.title}
        >
          {props.currentIcon}
          <span class="truncate capitalize leading-5">
            {props.options.find((option) => option.id === props.current)?.label ?? props.current}
          </span>
          <span class="-ml-0.5 -mr-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <Show when={menu()} keyed>{opened =>
        <MenuV2.Portal>
          <MenuV2.Content
            data-prompt-mode-menu
            oncapture:pointerleave={props.search ? preserveSearchOnLeave : undefined}
            onOpenAutoFocus={event => {
              if (!props.search) return
              event.preventDefault()
              cancelSearchFocus()
              const input = searchInput
              const owner = source(), generation = searchFocusGeneration
              // Kobalte defers selectable-list autofocus with setTimeout(0).
              // Run after that task; a microtask loses pointer-open search focus.
              searchFocusTimer = setTimeout(() => {
                if (generation !== searchFocusGeneration) return
                searchFocusTimer = undefined
                if (state.open && state.scope === owner && source() === owner && input?.isConnected)
                  input.focus({ preventScroll: true })
              }, 0)
            }}
            onCloseAutoFocus={event => {
              if (!props.search || opened.scope === source()) return
              event.preventDefault()
              const owner = source(), focused = document.activeElement, trigger = selectTrigger
              // DropdownMenu restores its trigger even when this event is prevented.
              // Preserve the new owner's focus after that synchronous restoration only.
              queueMicrotask(() => {
                if (source() !== owner || !trigger?.isConnected || document.activeElement !== trigger) return
                if (focused instanceof HTMLElement && focused.isConnected && focused !== trigger && focused !== document.body)
                  focused.focus({ preventScroll: true })
                else trigger.blur()
              })
            }}
            onPointerDownOutside={(event) => consumePromptMenuOutsidePress(event.detail.originalEvent)}
            onPointerDown={(event: PointerEvent) => {
              if (props.search && event.target instanceof Element && event.target.closest('[role^="menuitem"]'))
                cancelSearchFocus()
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (props.search && event.target !== searchInput) cancelSearchFocus()
            }}
            style={
              props.menuWidth
                ? { width: `${props.menuWidth}px`, "min-width": "0px", "max-width": "calc(100vw - 16px)" }
                : undefined
            }
          >
            <Show when={props.search}>
              <div class="flex items-center gap-2 px-2 py-1">
                {/* Text entry must not activate the menu's selected-item focus effect. */}
                <input ref={searchInput} type="search" aria-label={searchLabel()} placeholder={searchLabel()}
                  class="min-w-0 flex-1 bg-transparent px-1 py-2 text-[13px] outline-none"
                  value={state.query} onInput={event => setState("query", event.currentTarget.value)}
                  onFocusIn={event => event.stopPropagation()}
                  onKeyDown={event => {
                    if (promptInputIsComposing(event)) { event.stopPropagation(); return }
                    if (event.key === "Escape" || event.key === "Tab") return
                    event.stopPropagation()
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      cancelSearchFocus()
                      event.preventDefault()
                      const items = event.currentTarget.closest('[data-prompt-mode-menu]')?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
                      const item = event.key === "ArrowUp" ? items?.[items.length - 1] : items?.[0]
                      item?.focus()
                    } else if (event.key === "Enter") event.preventDefault()
                  }} />
                <Show when={state.query}>
                  <button type="button" aria-label={clearLabel()} class="px-2 py-2 text-[12px]"
                    onClick={() => { setState("query", ""); searchInput?.focus() }}>{clearLabel()}</button>
                </Show>
              </div>
              <p class="px-3 py-1 text-[12px] text-v2-text-text-muted">
                {i18n.locale().startsWith("zh") ? "用于当前输入的后续提交；不修改既有消息或代理定义。" : "Used by subsequent submissions from this composer; existing messages and Agent definitions stay intact."}
              </p>
            </Show>
            <Show when={actions()} keyed>{owned => <>
            <MenuV2.RadioGroup value={props.current} onChange={owned.select}>
              <For each={filtered()}>
                {(option) => {
                  const descriptionID = createUniqueId()
                  return (
                    <MenuV2.RadioItem value={option.id} aria-label={props.search ? option.label : undefined}
                      onPointerMove={props.search ? preserveSearchFocus : undefined}
                    aria-describedby={props.search && option.description ? descriptionID : undefined}
                    class={props.search ? "normal-case" : "capitalize"} closeOnSelect>
                    <PromptMenuLabels label={option.label} description={option.description} multiline={props.search}
                      descriptionID={props.search ? descriptionID : undefined} />
                  </MenuV2.RadioItem>
                  )
                }}
              </For>
            </MenuV2.RadioGroup>
            <Show when={props.search && filtered().length === 0}>
              <p role="status" class="px-3 py-3 text-[13px] text-v2-text-text-muted">{i18n.t("ui.list.empty")}</p>
            </Show>
            <Show when={props.search && props.configure}>
              {configuration => <>
                <MenuV2.Separator />
                <MenuV2.Item data-agent-configure onPointerMove={preserveSearchFocus} onSelect={owned.configure}>{configuration().label}</MenuV2.Item>
              </>}
            </Show>
            </>}</Show>
          </MenuV2.Content>
        </MenuV2.Portal>
        }</Show>
      </MenuV2>
    </TooltipV2>
  )
}

export function PromptInputV2Popover(props: {
  emptyLabel: string
  items: PromptInputV2Suggestion[]
  activeID?: string
  search?: {
    value: string
    label: string
    placeholder: string
    onValueChange: (value: string) => void
    onKeyDown: (event: KeyboardEvent) => void
  }
  onActiveChange: (item: PromptInputV2Suggestion) => void
  onSelect: (item: PromptInputV2Suggestion) => void
}) {
  return (
    <div
      data-component="prompt-input-suggestions"
      class="absolute inset-x-0 -top-2 z-40 flex max-h-80 -translate-y-full flex-col overflow-auto rounded-xl bg-v2-background-bg-base p-2 shadow-[var(--v2-elevation-raised)] no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={props.search}>
        {(search) => (
          <div class="px-2 py-1">
            <input
              ref={(element) => requestAnimationFrame(() => element.focus())}
              value={search().value}
              aria-label={search().label}
              placeholder={search().placeholder}
              class="w-full bg-transparent text-[13px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              onInput={(event) => search().onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => search().onKeyDown(event)}
              onMouseDown={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.emptyLabel}</div>}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-suggestion-id={item.id}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-v2-overlay-simple-overlay-hover": props.activeID === item.id }}
              onPointerMove={() => props.onActiveChange(item)}
              onClick={() => props.onSelect(item)}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <PromptInputV2SuggestionIcon item={item} />
                <span data-slot="prompt-menu-labels">
                  <span class="text-v2-text-text-base">{item.label}</span>
                  <Show when={item.description}>
                    <span data-slot="prompt-menu-description">{item.description}</span>
                  </Show>
                </span>
              </div>
              <Show when={item.keybind?.length}>
                <KeybindV2 keys={item.keybind ?? []} variant="neutral" class="shrink-0" />
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

export function PromptInputV2SubmitButton(props: {
  mode: PromptInputV2Mode
  stopping: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <TooltipV2
      placement="top"
      inactive={!props.stopping && props.disabled}
      value={props.stopping ? props.stopLabel : props.sendLabel}
    >
      <IconButton
        data-action="prompt-submit"
        type="button"
        disabled={!props.stopping && props.disabled}
        tabIndex={props.mode === "normal" ? undefined : -1}
        icon={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
        variant="primary"
        class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
        style={{
          "background-image":
            "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
        }}
        aria-label={props.stopping ? props.stopLabel : props.sendLabel}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (props.stopping) {
            props.onStop()
            return
          }
          props.onSubmit()
        }}
      />
    </TooltipV2>
  )
}

function PromptInputV2SuggestionIcon(props: { item: PromptInputV2Suggestion }) {
  if (props.item.kind === "agent") return <Icon name="brain" size="small" class="shrink-0 text-icon-info-active" />
  if (props.item.kind === "command") return null
  return (
    <FileIcon
      node={{ path: props.item.path ?? props.item.label, type: props.item.kind === "reference" ? "directory" : "file" }}
      class="size-4 shrink-0"
    />
  )
}
