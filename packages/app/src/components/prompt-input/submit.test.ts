import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore, unwrap } from "solid-js/store"
import { createRoot } from "solid-js"
import { createPromptState } from "@/context/prompt-state"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import type { FollowupDraft } from "./submit"
import type { Prompt as PromptInputSchema } from "@arforge-ai/schema/prompt-input"
import { queuedPromptParts } from "@/pages/session/helpers"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { ServerScope } from "@/utils/server-scope"
import { listPendingControlOperations } from "@/utils/control-operation-intent"
import { resolveAgent, unavailableAgentReason } from "@/context/local-agent"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let durableFollowupPrompt: typeof import("./submit").durableFollowupPrompt
let promptQueueSubmitting: typeof import("./submit").promptQueueSubmitting

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; messageID?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const registeredSessions: Array<{ server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const failureToasts: Array<{ title?: string; description?: unknown }> = []
const restoredPrompts: Prompt[] = []
let promptSendError: Error | undefined
let interruptError: Error | undefined
let interruptGate: Promise<void> | undefined
const interruptInputs: unknown[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const worktreeCreateInputs: unknown[] = []
const controlOperationStatusInputs: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let selectedAgent: { name: string } | undefined = { name: "agent" }
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined
let registrationAllowed = true
let permissionModeGate: Promise<void> | undefined
let registrationAttempts = 0
let tabStateInitializations = 0
let handoffWrites = 0
let worktreeCreateStatus: "pending" | "pending_then_completed" | "completed" | undefined

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const promptOwnership = createPromptState().ownership
const prompt = {
  ownership: promptOwnership,
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => undefined,
  set: (value: Prompt) => {
    restoredPrompts.push(value)
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        interrupt: async (input: unknown) => {
          interruptInputs.push(input)
          await interruptGate
          if (interruptError) throw interruptError
        },
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          if (promptSendError) throw promptSendError
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; messageID?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async (input: unknown) => {
        worktreeCreateInputs.push(input)
        if (worktreeCreateStatus) {
          const requestID = (input as { worktreeCreateControlInput: { requestID: string } }).worktreeCreateControlInput
            .requestID
          const worktreeDirectory = `${directory}/new`
          if (worktreeCreateStatus === "completed") WorktreeState.ready(ServerScope.local, worktreeDirectory)
          return {
            data: {
              runID: "run_create_pending",
              actionID: "act_create_pending",
              requestID,
              operation: "worktree.create",
              phase: worktreeCreateStatus === "completed" ? "completed" : "waiting_for_confirmation",
              recovery: worktreeCreateStatus === "completed" ? "none" : "awaiting_authorization",
              canApprove: worktreeCreateStatus !== "completed",
              ...(worktreeCreateStatus === "completed"
                ? {
                    result: {
                      kind: "worktree.create",
                      name: "new",
                      directory: worktreeDirectory,
                      branch: "arforge/new",
                    },
                  }
                : {}),
            },
          }
        }
        const worktreeDirectory = `${directory}/new`
        // The submit flow waits for a real worktree-ready event before it
        // queues the first prompt. This focused client contract test supplies
        // that event after the mocked control-plane response.
        WorktreeState.ready(ServerScope.local, worktreeDirectory)
        return { data: { directory: worktreeDirectory } }
      },
    },
    experimental: {
      controlOperation: {
        status: async (input: { requestID: string; directory: string; operation: "worktree.create" }) => {
          controlOperationStatusInputs.push(input)
          const completed = worktreeCreateStatus === "pending_then_completed"
          const worktreeDirectory = `${directory}/new`
          if (completed) WorktreeState.ready(ServerScope.local, worktreeDirectory)
          return {
            data: {
              runID: "run_create_status",
              actionID: "act_create_status",
              requestID: input.requestID,
              operation: input.operation,
              phase: "completed",
              recovery: "none",
              canApprove: false,
              ...(completed
                ? {
                    result: {
                      kind: "worktree.create",
                      name: "new",
                      directory: worktreeDirectory,
                      branch: "arforge/new",
                    },
                  }
                : {}),
            },
          }
        },
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@arforge-ai/sdk/v2/client", () => ({
    createArforgeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@arforge-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (value: { title?: string; description?: unknown }) => {
      failureToasts.push(value)
      return 0
    },
  }))

  mock.module("@arforge-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    hash: async (content: string) => `hash:${content}`,
    checksum: (content: string) => (content ? `checksum:${content.length}` : undefined),
    sampledChecksum: (content: string) => (content ? `checksum:${content.length}` : undefined),
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => selectedAgent,
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
      async setMode(sessionID: string, directory: string, mode: "plan" | "acceptEdits" | "fullAccess") {
        if (mode === "fullAccess") enabledAutoAccept.push({ server, sessionID, directory })
        await permissionModeGate
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      addSessionTab: (session: { server: string; sessionId: string }) => {
        registrationAttempts++
        if (!registrationAllowed) return
        if (
          !registeredSessions.some(
            (existing) => existing.server === session.server && existing.sessionId === session.sessionId,
          )
        )
          registeredSessions.push(session)
        return { type: "session", ...session }
      },
      state: <T>(_tab: unknown, _name: string, init: () => T) => {
        tabStateInitializations++
        return init()
      },
      promoteDraft: (
        draftID: string,
        session: { server: string; sessionId: string },
        _source?: unknown,
        _navigate?: () => boolean,
        canConsume?: () => boolean,
      ) => {
        if (canConsume && !canConsume()) return
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => {
          handoffWrites++
        },
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  durableFollowupPrompt = mod.durableFollowupPrompt
  promptQueueSubmitting = mod.promptQueueSubmitting
})

beforeEach(() => {
  promptSendError = undefined
  interruptError = undefined
  interruptGate = undefined
  interruptInputs.length = 0
  failureToasts.length = 0
  restoredPrompts.length = 0
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  registeredSessions.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  worktreeCreateInputs.length = 0
  controlOperationStatusInputs.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  selectedAgent = { name: "agent" }
  permissionServer = "server-a"
  createSessionGate = undefined
  registrationAllowed = true
  permissionModeGate = undefined
  registrationAttempts = 0
  tabStateInitializations = 0
  handoffWrites = 0
  worktreeCreateStatus = undefined
  serverSessionSyncs = 0
  localStorage.clear()
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("resource-only prompt submission", () => {
  test("queue text/model edits retain the original request system, format and scheduled tasks", () => {
    const original = {
      text: "Review sources",
      files: ["server-A", "server-B"].map((server) => ({
        uri: "evidence://shared/manual",
        mime: "text/plain",
        name: "manual",
        resource: { server, uri: "evidence://shared/manual" },
      })),
      system: { text: "Original request policy", source: "request", scope: "turn" },
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        retryCount: 2,
      },
      scheduledTasks: [
        {
          id: "task-retain",
          prompt: "Review independently",
          description: "Keep task",
          agent: "review",
          model: { providerID: "owned", id: "scheduled", variant: "task-high" },
        },
      ],
      route: { agent: "build", model: { providerID: "owned", id: "original", variant: "original-high" } },
    } satisfies typeof PromptInputSchema.Encoded
    const draft: FollowupDraft = {
      sessionID: "session-current",
      sessionDirectory: "/repo/main",
      context: [],
      prompt: queuedPromptParts({
        id: "queued-edit",
        sessionID: "session-current",
        prompt: { ...original, text: "Edited text" },
      }),
      agent: "build",
      model: { providerID: "owned", modelID: "current" },
      variant: "current-high",
    }
    for (const model of [original.route.model, { providerID: "owned", id: "current", variant: "current-high" }]) {
      const edited = { ...draft, model: { providerID: model.providerID, modelID: model.id }, variant: model.variant }
      const request = durableFollowupPrompt(edited, "queued-edit", new Set(), original)
      expect(JSON.parse(JSON.stringify(request))).toEqual({
        text: "Edited text",
        system: original.system,
        format: original.format,
        scheduledTasks: original.scheduledTasks,
        route: { agent: "build", model },
        agents: [],
        files: ["server-A", "server-B"].map((server) => ({
          uri: "evidence://shared/manual",
          mime: "text/plain",
          name: "manual",
          source: { text: "", start: 0, end: 0 },
          resource: { server, uri: "evidence://shared/manual" },
        })),
      })
    }
    const defaulted = durableFollowupPrompt(draft, "queued-edit", new Set(), {
      ...original,
      format: { ...original.format, retryCount: null },
    })
    expect(defaulted.format).toEqual(original.format)
    expect(original.text).toBe("Review sources")
    expect(original.route?.model).toEqual({ providerID: "owned", id: "original", variant: "original-high" })
  })

  const controller = (working: boolean, queued?: FollowupDraft[], mode: "normal" | "shell" = "normal") =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => promptValue.filter((part) => part.type === "image"),
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => mode,
      working: () => working,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => queued !== undefined,
      onQueue: (draft) => {
        queued?.push(draft)
      },
    })

  const resourceDraft = (): Prompt =>
    ["server-A", "server-B"].map((clientName) => ({
      type: "file",
      path: "evidence://shared/manual",
      url: "evidence://shared/manual",
      filename: "manual",
      mime: "text/plain",
      content: "",
      start: 0,
      end: 0,
      source: { type: "resource", clientName, uri: "evidence://shared/manual", text: { value: "", start: 0, end: 0 } },
    }))

  test.each([false, true])("sends unmentioned resources without aborting (working=%s)", async (working) => {
    params = { id: "session-current" }
    variant = "high"
    promptValue = resourceDraft()
    await controller(working).handleSubmit(new Event("submit"))
    await Bun.sleep(0)
    expect(interruptInputs).toEqual([])
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-current",
      text: "",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
      files: ["server-A", "server-B"].map(() => ({
        uri: "evidence://shared/manual",
        name: "manual",
        mention: { text: "", start: 0, end: 0 },
      })),
      legacyParts: ["server-A", "server-B"].map((clientName) => ({
        type: "file",
        mime: "text/plain",
        source: { type: "resource", clientName, uri: "evidence://shared/manual" },
      })),
    })
    expect(sentShell).toEqual([])
  })

  test("queues a resource-only follow-up with its source and selected model instead of stopping", async () => {
    params = { id: "session-current" }
    variant = "high"
    promptValue = resourceDraft()
    const original = promptValue
    const queued: FollowupDraft[] = []
    await controller(true, queued).handleSubmit(new Event("submit"))
    expect(interruptInputs).toEqual([])
    expect(promptInputs).toEqual([])
    expect(queued).toEqual([
      {
        sessionID: "session-current",
        sessionDirectory: "/repo/main",
        serverScope: ServerScope.local,
        prompt: original,
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
    ])
  })

  test.each(["normal", "shell"] as const)("genuinely empty %s drafts retain Stop semantics", async (mode) => {
    params = { id: "session-current" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    await controller(true, undefined, mode).handleSubmit(new Event("submit"))
    await Bun.sleep(0)
    expect(interruptInputs).toEqual([{ sessionID: "session-current" }])
    expect(promptInputs).toEqual([])
    expect(sentShell).toEqual([])
  })
})

describe("prompt submit worktree selection", () => {
  const stopController = () =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: params.id! }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })
  test("reports a failed current-session stop without sending another prompt", async () => {
    params = { id: "session-current" }
    interruptError = new Error("Isolated stop failure")
    await stopController().abort()
    expect(interruptInputs).toEqual([{ sessionID: "session-current" }])
    expect(failureToasts).toEqual([{ title: "common.requestFailed", description: "Isolated stop failure" }])
    expect(promptInputs).toEqual([])
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
  })
  test("does not project a previous-session stop failure into the new session", async () => {
    params = { id: "session-old" }
    const gate = Promise.withResolvers<void>()
    interruptGate = gate.promise
    interruptError = new Error("Old source failed")
    const pending = stopController().abort()
    params.id = "session-new"
    gate.resolve()
    await pending
    expect(interruptInputs).toEqual([{ sessionID: "session-old" }])
    expect(failureToasts).toEqual([])
  })
  test("surfaces admission rejection after persistence without retrying or duplicating the prompt", async () => {
    params = { id: "session-existing" }
    promptSendError = new Error("durable-run admission: isolated getSQL failure")
    const original = promptValue
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })
    await submit.handleSubmit(new Event("submit"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs).toHaveLength(1)
    expect(createdSessions).toEqual([])
    expect(failureToasts).toEqual([
      { title: "prompt.toast.promptSendFailed.title", description: "durable-run admission: isolated getSQL failure" },
    ])
    expect(restoredPrompts).toEqual([original])
  })

  test("queued MCP attachments preserve two servers sharing one URI", () => {
    const uri = "evidence://shared/manual"
    const result = durableFollowupPrompt(
      {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        context: [],
        agent: "build",
        model: { providerID: "owned", modelID: "current" },
        variant: "high",
        prompt: ["server-A", "server-B"].map((clientName, index) => ({
          type: "file",
          path: uri,
          url: uri,
          filename: "manual",
          mime: "text/plain",
          content: "@manual",
          start: index * 7,
          end: index * 7 + 7,
          source: {
            type: "resource",
            clientName,
            uri,
            text: { value: "@manual", start: index * 7, end: index * 7 + 7 },
          },
        })),
      },
      "msg_resources_queue",
      new Set(),
    )
    expect(result.files?.map((file) => file.resource)).toEqual([
      { server: "server-A", uri },
      { server: "server-B", uri },
    ])
    expect(result.route?.model).toEqual({ id: "current", providerID: "owned", variant: "high" })
  })

  test("serializes queued routing, attachments, and slash-command intent for the durable server queue", () => {
    const result = durableFollowupPrompt(
      {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [
          { type: "text", content: "/review staged changes", start: 0, end: 22 },
          {
            type: "file",
            path: "src/app.ts",
            content: "@src/app.ts",
            start: 23,
            end: 34,
            mime: "text/plain",
          },
          { type: "agent", name: "reviewer", content: "@reviewer", start: 35, end: 44 },
        ],
        context: [],
        agent: "build",
        model: { providerID: "private", modelID: "deepseek" },
        variant: "high",
      },
      "msg_queue",
      new Set(["review"]),
    )

    expect(result).toMatchObject({
      route: {
        agent: "build",
        model: { id: "deepseek", providerID: "private", variant: "high" },
      },
      command: { name: "review", arguments: "staged changes@src/app.ts@reviewer" },
      files: [{ mime: "text/plain", name: "app.ts" }],
      agents: [{ name: "reviewer" }],
    })
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", messageID: expect.stringMatching(/^msg_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", messageID: expect.stringMatching(/^msg_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("mints one first-party control-plane request ID when creating a worktree", async () => {
    selected = "create"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(worktreeCreateInputs).toEqual([
      {
        directory: "/repo/main",
        worktreeCreateControlInput: { requestID: expect.stringMatching(/^cpr_/) },
      },
    ])
  })

  test("does not create a session when the worktree endpoint returns only accepted status", async () => {
    selected = "create"
    worktreeCreateStatus = "pending"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdSessions).toEqual([])
    expect(sentShell).toEqual([])
    expect(controlOperationStatusInputs).toEqual([
      {
        requestID: expect.stringMatching(/^cpr_/),
        directory: "/repo/main",
        operation: "worktree.create",
      },
    ])
    const pending = await listPendingControlOperations(undefined, "local")
    expect(pending.intents).toHaveLength(1)
    expect(pending.intents[0]?.requestID).toBe(
      (worktreeCreateInputs[0] as { worktreeCreateControlInput: { requestID: string } }).worktreeCreateControlInput
        .requestID,
    )
  })

  test("polls read-only status and continues after a matching terminal create result", async () => {
    selected = "create"
    worktreeCreateStatus = "pending_then_completed"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(worktreeCreateInputs).toHaveLength(1)
    expect(controlOperationStatusInputs).toHaveLength(1)
    expect(createdSessions).toEqual(["/repo/main/new"])
    expect(sentShell).toHaveLength(1)
    expect((await listPendingControlOperations(undefined, "local")).intents).toEqual([])
  })

  test("continues session creation only for completed status with a matching create result", async () => {
    selected = "create"
    worktreeCreateStatus = "completed"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdSessions).toEqual(["/repo/main/new"])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", messageID: expect.stringMatching(/^msg_/), command: "ls" }),
    ])
    expect((await listPendingControlOperations(undefined, "local")).intents).toEqual([])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test.each(["taken-over", "edited-live", "background", "live", "closed-origin"] as const)(
    "delayed actual submit separates Session registration from %s draft consumption",
    async (caseName) => {
      let release!: () => void
      createSessionGate = new Promise<void>((done) => {
        release = done
      })
      search = { draftId: "original-draft" }
      const original = createPromptState({
        prompt: "A1 original",
        model: { providerID: "provider", modelID: "A", variant: "high" },
      })
      original.ownership.claim()
      original.context.add({ type: "file", path: "a1.ts", comment: "original context" })
      let stop = () => {},
        uiWrites = 0
      const submit = createRoot((dispose) => {
        stop = dispose
        return createPromptSubmit({
          prompt: original,
          info: () => undefined,
          imageAttachments: () => [],
          commentCount: () => 0,
          autoAccept: () => false,
          mode: () => "normal",
          working: () => false,
          editor: () => undefined,
          queueScroll: () => undefined,
          promptLength: (value) => value.reduce((n, part) => n + ("content" in part ? part.content.length : 0), 0),
          addToHistory: () => undefined,
          resetHistoryNavigation: () => undefined,
          setMode: () => {
            uiWrites++
          },
          setPopover: () => {
            uiWrites++
          },
          model: {
            current: () => ({ id: original.model.current()!.modelID, provider: { id: "provider" } }),
            variant: { current: () => original.model.current()?.variant },
          } as unknown as ModelSelection,
        })
      })
      try {
        const pending = submit.handleSubmit(new Event("submit"))
        if (caseName === "taken-over" || caseName === "background" || caseName === "closed-origin")
          search.draftId = "draft-b"
        if (caseName === "closed-origin") registrationAllowed = false
        if (caseName === "taken-over" || caseName === "edited-live") {
          search.draftId = "original-draft"
          if (caseName === "taken-over") original.ownership.claim()
          original.set([{ type: "text", content: "A2 new text", start: 0, end: 11 }], 4)
          original.model.set({ providerID: "provider", modelID: "B", variant: "low" })
          original.context.add({ type: "file", path: "a2.ts", comment: "keep A2" })
          if (caseName === "taken-over") search.draftId = "draft-b"
        }
        release()
        await pending
        await new Promise<void>((done) => setTimeout(done, 0))
        expect(registeredSessions).toEqual(
          caseName === "closed-origin" ? [] : [{ server: "project-server", sessionId: "session-1" }],
        )
        expect(storedSessions["/repo/main"]).toHaveLength(1)
        expect(sessionCreateInputs[0]?.model).toEqual({ id: "A", providerID: "provider", variant: "high" })
        expect(promptInputs).toHaveLength(1)
        expect(promptInputs[0]).toMatchObject({
          sessionID: "session-1",
          model: { modelID: "A", providerID: "provider" },
          variant: "high",
          text: "A1 original\nThe user made the following comment regarding this file of a1.ts: original context",
        })
        expect(JSON.stringify(promptInputs[0])).toContain("A1 original")
        expect(JSON.stringify(promptInputs[0])).not.toContain("A2 new text")
        if (caseName === "taken-over" || caseName === "edited-live") {
          expect(promotedDrafts).toHaveLength(0)
          expect(original.current()[0]).toMatchObject({ content: "A2 new text" })
          expect(original.model.current()).toEqual({ providerID: "provider", modelID: "B", variant: "low" })
          expect(original.context.items().map((item) => item.path)).toEqual(["a1.ts", "a2.ts"])
          expect(uiWrites).toBe(0)
        } else if (caseName === "closed-origin") {
          expect(promotedDrafts).toHaveLength(0)
          expect(original.current()[0]).toMatchObject({ content: "A1 original" })
          expect(original.context.items().map((item) => item.path)).toEqual(["a1.ts"])
          expect(uiWrites).toBe(0)
        } else expect(promotedDrafts).toHaveLength(1)
      } finally {
        stop()
      }
    },
  )

  test("rechecks a closed Session/source after delayed permission before recreating prompt memory or handoff", async () => {
    let release!: () => void
    permissionModeGate = new Promise<void>((done) => {
      release = done
    })
    search = { draftId: "original-draft" }
    const original = createPromptState({ prompt: "captured request" })
    original.context.add({ type: "file", path: "original.ts", comment: "captured context" })
    original.ownership.claim()
    let stop = () => {}
    const submit = createRoot((dispose) => {
      stop = dispose
      return createPromptSubmit({
        prompt: original,
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => "normal",
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: () => 16,
        addToHistory: () => undefined,
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
      })
    })
    try {
      const pending = submit.handleSubmit(new Event("submit"))
      for (let i = 0; i < 12 && registeredSessions.length === 0; i++) await Promise.resolve()
      expect(registeredSessions).toHaveLength(1)
      // The actual Tabs tests cover closed/source removal checks; reject the same guarded call here.
      registrationAllowed = false
      release()
      await pending
      await new Promise<void>((done) => setTimeout(done, 0))
      expect(tabStateInitializations).toBe(0)
      expect(registrationAttempts).toBe(2)
      expect(promotedDrafts).toHaveLength(0)
      expect(promoted).toHaveLength(0)
      expect(handoffWrites).toBe(0)
      expect(original.current()[0]).toMatchObject({ content: "captured request" })
      expect(original.context.items().map((item) => item.path)).toEqual(["original.ts"])
      expect(promptInputs).toHaveLength(1)
      expect(JSON.stringify(promptInputs[0])).toContain("captured request")
    } finally {
      release()
      stop()
    }
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
      system: expect.stringContaining("推理过程和思考摘要必须使用简体中文"),
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})

describe("acknowledged queue submission", () => {
  const queuedController = (
    state: ReturnType<typeof createPromptState>,
    onQueue: (draft: FollowupDraft) => Promise<void>,
    options?: {
      captureQueue?: () => (draft: FollowupDraft) => Promise<void>
      shouldQueue?: () => boolean
    },
  ) =>
    createPromptSubmit({
      prompt: state,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => state.current().filter((part) => part.type === "image"),
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 0,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: options?.shouldQueue ?? (() => true),
      onQueue,
      captureQueue: options?.captureQueue,
    })

  test("the original queue intent is captured before permission validation and cannot edit a replacement target", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({ prompt: "Edit original A" })
      let release!: () => void
      permissionModeGate = new Promise<void>((resolve) => {
        release = resolve
      })
      let selectedID = "queued-A"
      const writes: { id: string; text: string }[] = []
      const write = async (id: string, draft: FollowupDraft) => {
        writes.push({ id, text: draft.prompt.map((p) => ("content" in p ? p.content : "")).join("") })
      }
      const submit = queuedController(state, (draft) => write(selectedID, draft), {
        captureQueue: () => {
          const id = selectedID
          return (draft) => write(id, draft)
        },
      })
      const pending = submit.handleSubmit(new Event("submit"))
      selectedID = "queued-B"
      state.set([{ type: "text", content: "New edit B", start: 0, end: 10 }])
      release()
      await pending
      expect(writes).toEqual([{ id: "queued-A", text: "Edit original A" }])
      expect(state.current()[0]).toMatchObject({ content: "New edit B" })
      expect(sentPrompts).toEqual([])
      dispose()
    })
  })

  test("overlapping submits during permission validation cannot become a second steer after queue acknowledgement", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({ prompt: "One queued edit" })
      let release!: () => void
      permissionModeGate = new Promise<void>((resolve) => {
        release = resolve
      })
      let editing = true
      let writes = 0
      const submit = queuedController(
        state,
        async () => {
          writes++
          editing = false
        },
        { shouldQueue: () => editing },
      )
      const first = submit.handleSubmit(new Event("submit"))
      expect(promptQueueSubmitting(state.capture())).toBe(true)
      const otherController = queuedController(
        state,
        async () => {
          writes++
        },
        { shouldQueue: () => editing },
      )
      const second = otherController.handleSubmit(new Event("submit"))
      release()
      await Promise.all([first, second])
      await Bun.sleep(0)
      expect(writes).toBe(1)
      expect(promptQueueSubmitting(state.capture())).toBe(false)
      expect(sentPrompts).toEqual([])
      expect(sentCommands).toEqual([])
      dispose()
    })
  })

  test("a pending queue save retains the original text, PNG and context; success consumes them once", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({
        prompt: "Save this edit",
        model: { providerID: "owned", modelID: "original", variant: "high" },
      })
      state.set([
        ...state.current(),
        {
          type: "image",
          id: "img_owned",
          filename: "owned.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,b3duZWQ=",
        },
      ])
      state.context.add({ type: "file", path: "owned.ts", comment: "original context" })
      const original = structuredClone(unwrap(state.current()))
      let accept!: () => void
      const gate = new Promise<void>((resolve) => {
        accept = resolve
      })
      const queued: FollowupDraft[] = []
      const submit = queuedController(state, async (draft) => {
        queued.push(draft)
        await gate
      })
      const pending = submit.handleSubmit(new Event("submit"))
      await Bun.sleep(0)
      expect(queued).toHaveLength(1)
      expect(state.current()).toEqual(original)
      expect(state.context.items()).toHaveLength(1)
      await submit.handleSubmit(new Event("submit"))
      expect(queued).toHaveLength(1)
      accept()
      await pending
      expect(state.current()[0]).toMatchObject({ content: "" })
      expect(state.context.items()).toHaveLength(0)
      expect(failureToasts).toEqual([])
      dispose()
    })
  })

  test("a rejected queue save keeps the draft and attachments available for an explicit retry", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({ prompt: "Retain failed edit" })
      state.context.add({ type: "file", path: "keep.ts", comment: "keep this context" })
      const original = structuredClone(unwrap(state.current()))
      let calls = 0
      const submit = queuedController(state, async () => {
        if (++calls === 1) throw new Error("Queue save rejected")
      })
      await submit.handleSubmit(new Event("submit"))
      expect(state.current()).toEqual(original)
      expect(state.context.items()).toHaveLength(1)
      expect(failureToasts).toEqual([
        { title: "prompt.toast.promptSendFailed.title", description: "Queue save rejected" },
      ])
      await submit.handleSubmit(new Event("submit"))
      expect(calls).toBe(2)
      expect(state.current()[0]).toMatchObject({ content: "" })
      expect(state.context.items()).toHaveLength(0)
      dispose()
    })
  })

  test("a delayed queue acknowledgement cannot consume newer text, model or context", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({ prompt: "Original queued edit" })
      let accept!: () => void
      const gate = new Promise<void>((resolve) => {
        accept = resolve
      })
      const submit = queuedController(state, () => gate)
      const pending = submit.handleSubmit(new Event("submit"))
      await Bun.sleep(0)
      state.set([{ type: "text", content: "Newer unsent draft", start: 0, end: 18 }])
      state.model.set({ providerID: "owned", modelID: "new", variant: "low" })
      state.context.add({ type: "file", path: "newer.ts" })
      accept()
      await pending
      expect(state.current()[0]).toMatchObject({ content: "Newer unsent draft" })
      expect(state.model.current()).toEqual({ providerID: "owned", modelID: "new", variant: "low" })
      expect(state.context.items().map((item) => item.path)).toEqual(["newer.ts"])
      dispose()
    })
  })

  test("a source switch while permission validation is pending cannot dispatch a queue callback in the new view", async () => {
    await createRoot(async (dispose) => {
      params = { id: "session-current" }
      const state = createPromptState({ prompt: "Keep original source" })
      let release!: () => void
      permissionModeGate = new Promise<void>((resolve) => {
        release = resolve
      })
      let writes = 0
      const submit = queuedController(state, async () => {
        writes++
      })
      const pending = submit.handleSubmit(new Event("submit"))
      params.id = "session-other"
      release()
      await pending
      expect(writes).toBe(0)
      expect(state.current()[0]).toMatchObject({ content: "Keep original source" })
      dispose()
    })
  })
})

describe("unavailable injected draft model", () => {
  for (const mode of ["normal", "shell"] as const) {
    test("blocks " + mode + " before creating a session, history, queue or request", async () => {
      let historyWrites = 0
      let queueWrites = 0
      const original = promptValue
      const model = {
        current: () => undefined,
        variant: { current: () => undefined },
      } as unknown as ModelSelection
      const submit = createPromptSubmit({
        prompt,
        model,
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => mode,
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
        addToHistory: () => {
          historyWrites++
        },
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
        shouldQueue: () => true,
        onQueue: () => {
          queueWrites++
        },
      })
      await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      expect(promptValue).toBe(original)
      expect(createdSessions).toHaveLength(0)
      expect(worktreeCreateInputs).toHaveLength(0)
      expect(sentPrompts).toHaveLength(0)
      expect(sentCommands).toHaveLength(0)
      expect(sentShell).toHaveLength(0)
      expect(optimistic).toHaveLength(0)
      expect(historyWrites).toBe(0)
      expect(queueWrites).toBe(0)
    })
  }
})

describe("unavailable selected Agent", () => {
  for (const mode of ["normal", "shell"] as const) {
    test("blocks " + mode + " before any Session, request, history, permission or queue mutation", async () => {
      selectedAgent = resolveAgent([{ name: "build" }, { name: "plan" }], "owned-r02-review")
      let historyWrites = 0
      let queueWrites = 0
      const original = promptValue
      const reason = unavailableAgentReason("owned-r02-review", true, "en")
      const submit = createPromptSubmit({
        prompt,
        agentUnavailable: () => reason,
        info: () => undefined,
        imageAttachments: () => [],
        commentCount: () => 0,
        autoAccept: () => false,
        mode: () => mode,
        working: () => false,
        editor: () => undefined,
        queueScroll: () => undefined,
        promptLength: () => 2,
        addToHistory: () => {
          historyWrites++
        },
        resetHistoryNavigation: () => undefined,
        setMode: () => undefined,
        setPopover: () => undefined,
        shouldQueue: () => true,
        onQueue: () => {
          queueWrites++
        },
      })
      await submit.handleSubmit(new Event("submit"))
      expect(promptValue).toBe(original)
      expect(createdSessions).toHaveLength(0)
      expect(worktreeCreateInputs).toHaveLength(0)
      expect(sentPrompts).toHaveLength(0)
      expect(sentCommands).toHaveLength(0)
      expect(sentShell).toHaveLength(0)
      expect(optimistic).toHaveLength(0)
      expect(enabledAutoAccept).toHaveLength(0)
      expect(registrationAttempts).toBe(0)
      expect(promoted).toHaveLength(0)
      expect(historyWrites).toBe(0)
      expect(queueWrites).toBe(0)
      expect(failureToasts).toEqual([{ title: "prompt.toast.modelAgentRequired.title", description: reason }])
    })
  }
})
