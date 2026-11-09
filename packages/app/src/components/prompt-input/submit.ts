import type { Message, Session } from "@arforge-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@arforge-ai/core/util/encode"
import { Binary } from "@arforge-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, createSignal, startTransition, type Accessor, type Signal } from "solid-js"
import { unwrap } from "solid-js/store"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { createPromptSession, hasPromptContent } from "@/context/prompt-state"
import { useServer } from "@/context/server"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError, promptModelErrorMessage } from "@/utils/server-errors"
import { formatHtmlSelectionSnapshot } from "@/utils/html-selection-reference"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Prompt as DurablePromptSchema } from "@arforge-ai/schema/prompt-input"
import { OutputFormat } from "@arforge-ai/schema/prompt"
import { Schema } from "effect"
import { isDeepEqual } from "remeda"
import type { OperationsApi } from "@/utils/server"
import type { PromptInputGoalControl } from "./contracts"
import type { SessionPermissionMode } from "@/context/permission-mode"
import {
  beginControlOperation,
  runControlOperationToCompletion,
  type CompletedWorktree,
} from "@/utils/control-operation-intent"
import { showControlOperationStatusNotice } from "@/utils/control-operation-notice"

type DurablePrompt = typeof DurablePromptSchema.Encoded
type QueuedPrompt = Awaited<ReturnType<OperationsApi["sessions"]["promptQueueList"]>>[number]

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()
type PromptTarget = ReturnType<ReturnType<typeof usePrompt>["capture"]>
const queueing = new WeakMap<PromptTarget, Signal<boolean>>()

const queueState = (target: PromptTarget) => {
  const existing = queueing.get(target)
  if (existing) return existing
  const state = createSignal(false)
  queueing.set(target, state)
  return state
}

export const promptQueueSubmitting = (target: PromptTarget) => queueState(target)[0]()

export const DEFAULT_VISIBLE_LANGUAGE_SYSTEM_PROMPT = [
  "<output_language>",
  "所有用户可见内容默认使用简体中文。",
  "推理过程和思考摘要必须使用简体中文；即使系统模板、工具结果或上下文是英文，也要用简体中文叙述。",
  "代码、命令、文件路径、API、协议名和无法准确翻译的专业术语保留原文。",
  "</output_language>",
].join("\n")

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  serverScope?: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export function durableFollowupPrompt(
  draft: FollowupDraft,
  messageID: string,
  commandNames: ReadonlySet<string>,
  retained?: Pick<QueuedPrompt["prompt"], "system" | "format" | "scheduledTasks">,
): DurablePrompt {
  const text = draftText(draft.prompt)
  const images = draftImages(draft.prompt)
  const { requestParts } = buildRequestParts({
    prompt: draft.prompt,
    context: draft.context,
    images,
    text,
    sessionID: draft.sessionID,
    messageID,
    sessionDirectory: draft.sessionDirectory,
    serverScope: draft.serverScope,
  })
  const [head, ...tail] = text.split(" ")
  const name = head?.startsWith("/") ? head.slice(1) : undefined
  const command = name && commandNames.has(name) ? { name, arguments: tail.join(" ") } : undefined
  if (command && draft.context.some((item) => item.htmlSelection !== undefined))
    throw new Error("HTML selection snapshots require a normal message, not a slash command.")

  const format =
    retained?.format === undefined
      ? undefined
      : Schema.decodeUnknownSync(OutputFormat)(
          retained.format.type === "json_schema"
            ? { ...retained.format, retryCount: retained.format.retryCount ?? undefined }
            : retained.format,
        )
  return {
    ...(retained?.system === undefined ? {} : { system: retained.system }),
    ...(format === undefined ? {} : { format }),
    ...(retained?.scheduledTasks === undefined ? {} : { scheduledTasks: retained.scheduledTasks }),
    text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    files: requestParts.flatMap((part) => {
      if (part.type !== "file") return []
      const source = part.source?.text
      return [
        {
          uri: part.url,
          mime: part.mime,
          name: part.filename,
          source: source ? { start: source.start, end: source.end, text: source.value } : undefined,
          ...(part.source?.type === "resource"
            ? { resource: { server: part.source.clientName, uri: part.source.uri } }
            : {}),
        },
      ]
    }),
    agents: requestParts.flatMap((part) =>
      part.type === "agent"
        ? [
            {
              name: part.name,
              source: part.source
                ? { start: part.source.start, end: part.source.end, text: part.source.value }
                : undefined,
            },
          ]
        : [],
    ),
    route: {
      agent: draft.agent,
      model: {
        id: draft.model.modelID,
        providerID: draft.model.providerID,
        variant: draft.variant,
      },
    },
    command,
  }
}

const queueEditorContent = ({ text, files, agents, route }: Pick<DurablePrompt, "text" | "files" | "agents" | "route">) => ({
  text,
  files: (files ?? []).map(({ uri, mime, name, description, source, resource }) => ({
    uri,
    mime,
    name,
    description,
    source,
    resource,
  })),
  agents: (agents ?? []).map(({ name, source }) => ({ name, source })),
  agent: route?.agent,
  model: route?.model && { id: route.model.id, providerID: route.model.providerID, variant: route.model.variant },
})

export function matchesQueuedDraft(draft: FollowupDraft, item: Pick<QueuedPrompt, "id" | "sessionID" | "prompt">) {
  if (draft.sessionID !== item.sessionID) return false
  try {
    const serialized = durableFollowupPrompt(draft, item.id, new Set())
    return isDeepEqual(queueEditorContent(serialized), queueEditorContent(item.prompt))
  } catch {
    return false
  }
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    if (input.draft.context.some((item) => item.htmlSelection !== undefined))
      throw new Error("HTML selection snapshots require a normal message, not a slash command.")
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
        files: images.map((attachment) => ({
          uri: attachment.dataUrl,
          name: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
    serverScope: input.draft.serverScope,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      system: DEFAULT_VISIBLE_LANGUAGE_SYSTEM_PROMPT,
      variant: input.draft.variant,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  permissionMode?: Accessor<SessionPermissionMode>
  mode: Accessor<"normal" | "shell">
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void | Promise<void>
  captureQueue?: () => ((draft: FollowupDraft) => void | Promise<void>) | undefined
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
  agentUnavailable?: Accessor<string | undefined>
  goal?: PromptInputGoalControl
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const server = useServer()
  const lifetime = createSessionOwnership(() => "prompt-submit").capture()
  const view = createSessionOwnership(() => JSON.stringify([sdk().scope, sdk().directory, params.id, search.draftId]))
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    const modelMessage = promptModelErrorMessage(err)
    if (modelMessage) return modelMessage
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()
    const source = sdk()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return source.api.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(15_000) }).catch((error: unknown) => {
      if (sdk() !== source || params.id !== sessionID) return
      showToast({ title: language.t("common.requestFailed"), description: errorMessage(error) })
    })
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
        htmlSelection: item.htmlSelection,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (source: ServerSync, dir: string, info: Session) => {
    source.session.remember(info)
    const [, setStore] = source.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const submit = async (event: Event, queued?: { send: PromptSubmitInput["onQueue"] }) => {
    event.preventDefault()
    if (!lifetime.current()) return

    const target = prompt.capture()
    const originSDK = sdk(),
      originSync = sync(),
      originServerSync = serverSync()
    const viewOwner = view.capture()
    const currentView = () => lifetime.current() && viewOwner.current() && sdk() === originSDK
    const draftID = search.draftId
    const originDraft = draftID ? { ...tabs.draft(draftID) } : undefined
    const sessionServer = originDraft?.server ?? server.key
    const initialSession = input.info()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = structuredClone(unwrap(input.imageAttachments()))
    const mode = input.mode()
    const goal = mode === "normal" && input.goal?.selected() ? input.goal : undefined
    if (
      context.some((item) => item.htmlSelection !== undefined) &&
      (mode === "shell" ||
        (text.startsWith("/") &&
          originSync.data.command.some((command) => command.name === text.split(" ")[0]?.slice(1))))
    ) {
      showToast({
        title: language.t("common.requestFailed"),
        description: "HTML selection snapshots require a normal message, not Shell or a slash command.",
      })
      return
    }
    const selectedPermissionMode = input.permissionMode?.() ?? (input.autoAccept() ? "fullAccess" : "acceptEdits")

    if (!hasPromptContent(currentPrompt) && images.length === 0 && input.commentCount() === 0) return

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: input.agentUnavailable?.() ?? language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    if (selectedPermissionMode === "plan" && mode === "shell") {
      showToast({
        title: language.t("controlCenter.m140"),
        description: language.t("controlCenter.m140"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = originSDK.directory
    const projectScope = originSDK.scope
    const pendingKey = (sessionID: string) => ScopedKey.from(projectScope, sessionID)
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = originSDK.client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktreeResult = await beginControlOperation({
          server: projectScope,
          project: projectDirectory,
          location: projectDirectory,
          kind: "worktree.create",
          input: {},
        })
          .then((intent) =>
            runControlOperationToCompletion<CompletedWorktree>(
              intent,
              (requestID) =>
                client.worktree
                  .create({
                    directory: projectDirectory,
                    worktreeCreateControlInput: { requestID },
                  })
                  .then((x) => x.data),
              ({ requestID, operation, location }) =>
                client.experimental.controlOperation
                  .status({ requestID, directory: location, operation })
                  .then((x) => x.data),
            ),
          )
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (createdWorktreeResult?.state === "status") {
          showControlOperationStatusNotice(createdWorktreeResult.status, (key) => language.t(key))
          return
        }
        const createdWorktree = createdWorktreeResult?.value
        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(projectScope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = originSDK.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        originServerSync.child(sessionDirectory)
      }

      if (currentView() && submission.canConsume()) input.onNewSessionWorktreeReset?.()
    }

    let session = initialSession
    if (!session && isNewSession) {
      const created = await originSDK.api.session
        .create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        })
        .then(normalizeSessionInfo)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(originServerSync, sessionDirectory, created)
        session = created
        const sessionTab = { server: sessionServer, sessionId: created.id }
        // Registration is independent of permission to consume the captured draft.
        tabs.addSessionTab(sessionTab, originDraft)
        try {
          await permissionState.setMode(created.id, sessionDirectory, selectedPermissionMode)
        } catch (err) {
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: errorMessage(err),
          })
          return
        }
        // The user can close the Session/draft or remove its source while permission is pending.
        const registered = tabs.addSessionTab(sessionTab, originDraft)
        if (registered) {
          const next = tabs.state({ type: "session", ...sessionTab }, "prompt", () =>
            createPromptSession(projectScope, { dir: base64Encode(sessionDirectory), id: created.id }),
          )
          // Tabs owns draft consumption/deletion; a declined promotion must never reset it later.
          submission.retarget(next, { consumeInitial: !draftID })
        } else submission.preserve()
        if (registered && currentView() && submission.canConsume()) {
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent.name,
            model: { providerID: currentModel.provider.id, modelID: currentModel.id },
            variant: variant ?? null,
          })
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        }
        if (registered && draftID) {
          await tabs.promoteDraft(draftID, sessionTab, originDraft, currentView, submission.canConsume)
        } else if (registered && currentView() && submission.canConsume()) {
          await startTransition(() => navigate(`/${base64Encode(sessionDirectory)}/session/${created.id}`))
        }
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    if (!isNewSession) {
      try {
        await permissionState.setMode(session.id, sessionDirectory, selectedPermissionMode)
      } catch (err) {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
        return
      }
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      serverScope: projectScope,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      if (!submission.clear() || !currentView() || !submission.current(prompt.capture())) return
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      submission.update(() => restored.target.set(restored.prompt, input.promptLength(restored.prompt)))
      if (!currentView() || !submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        if (!currentView() || !submission.current(prompt.capture())) return
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (goal) {
      const objective = [
        text.trim(),
        ...context.map((item) => {
          if (item.htmlSelection !== undefined)
            return formatHtmlSelectionSnapshot(item.htmlSelection, {
              path: item.path,
              directory: sessionDirectory,
              serverScope: projectScope,
            })
          const selection = item.selection
            ? `:${item.selection.startLine}${item.selection.endLine === item.selection.startLine ? "" : `-${item.selection.endLine}`}`
            : ""
          const comment = item.comment?.trim()
          return [`[file:${item.path}${selection}]`, comment].filter(Boolean).join(" ")
        }),
        ...images.map((image) => `[image:${image.filename}]`),
      ]
        .filter(Boolean)
        .join("\n")
        .trim()

      try {
        const started = await goal.submit({ sessionID: session.id, objective })
        if (!started) return
        submission.update(() => clearContext(submission.target()))
        clearInput()
        if (currentView() && submission.current(prompt.capture())) submission.update(() => input.onSubmit?.())
      } catch {
        // The Goal controller reports the server error and keeps the draft available for retry.
      }
      return
    }

    if (!isNewSession && mode === "normal" && queued) {
      const queue = queued.send
      if (!queue || !currentView()) return
      try {
        await queue(draft)
        submission.update(() => clearContext(submission.target()))
        clearInput()
      } catch (err) {
        if (currentView()) {
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
        }
      }
      return
    }

    if (currentView() && submission.current(prompt.capture())) submission.update(() => input.onSubmit?.())

    if (mode === "shell") {
      clearInput()
      // Direct Shell is a durable action. Its user-message identity must be
      // a real MessageID so retries bind to the same action rather than
      // minting a fresh side effect.
      const messageID = Identifier.ascending("message")
      originSDK.api.session
        .shell({
          sessionID: session.id,
          messageID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = originSync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        originServerSync.session.set("session_status", session.id, { type: "busy" })
        originSDK.api.session
          .command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            files: images.map((attachment) => ({
              uri: attachment.dataUrl,
              name: attachment.filename,
            })),
          })
          .catch((err) => {
            originServerSync.session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      originSync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    submission.update(() => {
      for (const item of commentItems) submission.target().context.remove(item.key)
    })
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(projectScope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        originSync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          originSync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) submission.update(() => restoreCommentItems(submission.target(), commentItems))
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(projectScope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      api: originSDK.api.session,
      sync: originSync,
      serverSync: originServerSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        originSync.set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) submission.update(() => restoreCommentItems(submission.target(), commentItems))
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    if (!lifetime.current()) return
    const target = prompt.capture()
    const [isQueueing, setQueueing] = queueState(target)
    if (isQueueing()) return
    const queued = !!input.info() && input.mode() === "normal" && !input.goal?.selected() && !!input.shouldQueue?.()
    if (queued) setQueueing(true)
    try {
      const prepared = queued ? { send: input.captureQueue ? input.captureQueue() : input.onQueue } : undefined
      await submit(event, prepared)
    } finally {
      if (queued) setQueueing(false)
    }
  }

  return {
    abort,
    handleSubmit,
  }
}
