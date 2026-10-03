import type { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { FSUtil } from "@arforge-ai/core/fs-util"
// CLI entry point for `arforge run` and `arforge --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`arforge --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`arforge --mini --attach`): connects to a running
//      arforge server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
// The historical `print`/`--print` entry is an argv alias of this same owner;
// its text/stream-json renderer, multi-message stdin and final-only behavior
// are implemented below without a Python subprocess or a second loop.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createArforgeClient, type ArforgeClient, type ToolPart } from "@arforge-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import {
  PRINT_INPUT_FORMATS,
  PRINT_OUTPUT_FORMATS,
  PrintModeInputError,
  PrintModeRenderer,
  isPrintRetryableError,
  resolvePrintMessages,
  type PrintInputFormat,
  type PrintOutputFormat,
} from "./print-mode"

type ModelInput = Parameters<ArforgeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

export const CLI_AUTO_SHARE_SUPPRESSED =
  "Automatic session sharing is disabled until controlled publishing runs through a sealed ControlRun worker."

export const CLI_SHARE_MUTATION_UNAVAILABLE =
  "Session sharing is disabled until controlled publishing runs through a sealed ControlRun worker; --share did not publish anything."

export async function runLegacyCliShare(input: {
  explicit: boolean
  automatic: boolean
  warn: (message: string) => void
}) {
  if (input.explicit) {
    input.warn(CLI_SHARE_MUTATION_UNAVAILABLE)
    return "blocked" as const
  }
  if (!input.automatic) return "idle" as const
  input.warn(CLI_AUTO_SHARE_SUPPRESSED)
  return "suppressed" as const
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

type CoreToolCall = {
  tool: string
  input: Record<string, unknown>
  started: number
  assistantMessageID: string
}

function coreContentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter((item): item is { type: "text"; text: string } => {
      return Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    })
    .map((item) => item.text)
    .join("\n")
}

function coreValueText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function coreErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message
    }
    if (typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message
    }
    if (typeof (error as { name?: unknown }).name === "string") {
      return (error as { name: string }).name
    }
  }
  return String(error)
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  // Python's historical `ask` command is a spelling alias only. The TS run
  // handler remains the single execution/output owner for both names.
  aliases: ["ask", "print"],
  describe: "run Arforge with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("print-mode", {
        type: "boolean",
        hidden: true,
        default: false,
        describe: "compatibility print mode (owned by the TypeScript run handler)",
      })
      .option("input-format", {
        type: "string",
        choices: PRINT_INPUT_FORMATS,
        default: "text",
        describe: "print input format: text or stream-json",
      })
      .option("output-format", {
        type: "string",
        choices: PRINT_OUTPUT_FORMATS,
        default: "text",
        describe: "print output format: text or stream-json",
      })
      .option("final-message-only", {
        type: "boolean",
        default: false,
        describe: "print only the final assistant message",
      })
      .option("quiet", {
        type: "boolean",
        hidden: true,
        default: false,
        describe: "alias for --final-message-only",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running Arforge server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to ARFORGE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to ARFORGE_SERVER_USERNAME or 'arforge')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const interactive = args.mini
      const printMode = args["print-mode"] === true || args._?.[0] === "print"
      const printInputFormat = (args["input-format"] ?? "text") as PrintInputFormat
      const printOutputFormat = (args["output-format"] ?? "text") as PrintOutputFormat
      const finalMessageOnly = printMode && (args["final-message-only"] === true || args.quiet === true)
      const auto = printMode || args.auto || args.yolo || args["dangerously-skip-permissions"]
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = printMode
        ? [...args.message, ...(args["--"] || [])].join(" ")
        : [...args.message, ...(args["--"] || [])]
            .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
            .join(" ")

      if (printMode && interactive) {
        die("print mode cannot be used with --mini or --interactive")
      }

      if (printMode && args.command) {
        die("print mode cannot be used with --command")
      }

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createArforgeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      let printMessages: string[] | undefined
      if (printMode) {
        try {
          printMessages = resolvePrintMessages(printInputFormat, message, piped)
        } catch (error) {
          if (error instanceof PrintModeInputError) die(error.message)
          throw error
        }
        message = printMessages[0] ?? ""
      } else {
        message = resolveRunInput(message, piped) ?? ""
      }
      const initialInput = printMode ? undefined : resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !interactive && !printMode) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = interactive || printMode
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: ArforgeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function share(sdk: ArforgeClient, _sessionID: string) {
        const cfg = await sdk.config.get()
        if (!cfg.data) return
        await runLegacyCliShare({
          explicit: args.share === true,
          automatic: cfg.data.share === "auto" || flags.autoShare,
          warn: (message) => UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + message),
        })
      }

      async function createFreshSession(
        sdk: ArforgeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        void share(sdk, id).catch(() => {})
        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: ArforgeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: ArforgeClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: ArforgeClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function execute(sdk: ArforgeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id
        const printRenderer = printMode
          ? new PrintModeRenderer({
              outputFormat: printOutputFormat,
              finalMessageOnly,
            })
          : undefined

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(
          client: ArforgeClient,
          events: Awaited<ReturnType<typeof sdk.event.subscribe>>,
          renderer = printRenderer,
        ) {
          const toggles = new Map<string, boolean>()
          const coreTextStarted = new Map<string, number>()
          const coreReasoningStarted = new Map<string, number>()
          const coreTools = new Map<string, CoreToolCall>()
          let pendingUnknownStep: { assistantMessageID: string; timestamp: number } | undefined
          let error: string | undefined
          let retryable = false

          renderer?.beginTurn()

          for await (const event of events.stream) {
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              !renderer &&
              args.format !== "json" &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            // Core V2 is the canonical session runner. Older CLI consumers
            // still expect the mature `message.part.updated` projection, so
            // normalize the replayable Core boundaries here at the TS CLI
            // output edge instead of introducing another execution owner.
            if (event.type === "session.next.step.started" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              pendingUnknownStep = undefined
              const part = {
                id: `step:${properties.assistantMessageID}`,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "step-start" as const,
                ...(properties.snapshot ? { snapshot: properties.snapshot } : {}),
              }
              if (!renderer) emit("step_start", { part })
              continue
            }

            if (event.type === "session.next.step.ended" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              const total = properties.tokens.input + properties.tokens.output + properties.tokens.reasoning
              const part = {
                id: `step:${properties.assistantMessageID}`,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "step-finish" as const,
                reason: properties.finish,
                ...(properties.snapshot ? { snapshot: properties.snapshot } : {}),
                cost: properties.cost,
                tokens: { ...properties.tokens, total },
              }
              if (!renderer) emit("step_finish", { part })
              // The mature stream exposed an empty follow-up step when a
              // provider ended with an unknown finish (for example an SSE
              // error after partial output). Preserve that observable
              // ordering only if Core does not publish a replacement step.
              pendingUnknownStep =
                (properties.finish === "unknown" || properties.finish === "tool-calls")
                  ? { assistantMessageID: properties.assistantMessageID, timestamp: properties.timestamp }
                  : undefined
              continue
            }

            if (event.type === "session.next.text.started" && event.properties.sessionID === sessionID) {
              coreTextStarted.set(event.properties.textID, event.properties.timestamp)
              continue
            }

            if (event.type === "session.next.text.delta" && event.properties.sessionID === sessionID) {
              if (renderer) renderer.textDelta(event.properties.delta, event.properties.textID)
              continue
            }

            if (event.type === "session.next.text.ended" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              const part = {
                id: properties.textID,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "text" as const,
                text: properties.text,
                time: {
                  start: coreTextStarted.get(properties.textID) ?? properties.timestamp,
                  end: properties.timestamp,
                },
              }
              coreTextStarted.delete(properties.textID)
              if (renderer) {
                renderer.textEnded(part.text, properties.textID)
                continue
              }
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
              continue
            }

            if (event.type === "session.next.primary.delivered" && event.properties.sessionID === sessionID) {
              renderer?.finalAnswer(event.properties.message)
              continue
            }

            if (event.type === "session.next.reasoning.started" && event.properties.sessionID === sessionID) {
              coreReasoningStarted.set(event.properties.reasoningID, event.properties.timestamp)
              continue
            }

            if (event.type === "session.next.reasoning.ended" && event.properties.sessionID === sessionID) {
              if (renderer) continue
              if (!thinking) continue
              const properties = event.properties
              const part = {
                id: properties.reasoningID,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "reasoning" as const,
                text: properties.text,
                time: {
                  start: coreReasoningStarted.get(properties.reasoningID) ?? properties.timestamp,
                  end: properties.timestamp,
                },
              }
              coreReasoningStarted.delete(properties.reasoningID)
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
              continue
            }

            if (event.type === "session.next.tool.called" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              coreTools.set(properties.callID, {
                tool: properties.tool,
                input: properties.input,
                started: properties.timestamp,
                assistantMessageID: properties.assistantMessageID,
              })
              if (renderer) renderer.toolCalled(properties.callID, properties.tool, properties.input)
              continue
            }

            if (event.type === "session.next.tool.success" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              const call = coreTools.get(properties.callID)
              const output = coreContentText(properties.content) || coreValueText(properties.result)
              const part = {
                id: properties.callID,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "tool" as const,
                callID: properties.callID,
                tool: call?.tool ?? "tool",
                state: {
                  status: "completed" as const,
                  input: call?.input ?? {},
                  output,
                  title: call?.tool ?? "tool",
                  metadata: properties.structured,
                  time: {
                    start: call?.started ?? properties.timestamp,
                    end: properties.timestamp,
                  },
                },
              } satisfies ToolPart
              coreTools.delete(properties.callID)
              if (renderer) {
                renderer.toolCompleted(properties.callID, output, false)
                continue
              }
              if (emit("tool_use", { part })) continue
              await tool(part)
              continue
            }

            if (event.type === "session.next.tool.failed" && event.properties.sessionID === sessionID) {
              const properties = event.properties
              const call = coreTools.get(properties.callID)
              const part = {
                id: properties.callID,
                sessionID,
                messageID: properties.assistantMessageID,
                type: "tool" as const,
                callID: properties.callID,
                tool: call?.tool ?? "tool",
                state: {
                  status: "error" as const,
                  input: call?.input ?? {},
                  error: coreErrorText(properties.error),
                  time: {
                    start: call?.started ?? properties.timestamp,
                    end: properties.timestamp,
                  },
                },
              } satisfies ToolPart
              coreTools.delete(properties.callID)
              if (renderer) {
                renderer.toolCompleted(properties.callID, part.state.error, true)
                continue
              }
              if (emit("tool_use", { part })) continue
              await toolError(part)
              UI.error(part.state.error)
              continue
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (renderer) {
                  renderer.toolCompleted(
                    part.callID,
                    part.state.status === "completed" ? part.state.output : part.state.error,
                    part.state.status === "error",
                  )
                  continue
                }
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (renderer) {
                  renderer.text(part.text, part.id)
                  continue
                }
                if (emit("text", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking) {
                if (renderer) continue
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.next.step.failed" && event.properties.sessionID === sessionID) {
              const failure = event.properties.error
              error = error ? error + EOL + coreErrorText(failure) : coreErrorText(failure)
              retryable = retryable || isPrintRetryableError(failure)
              if (renderer) renderer.error(failure)
              if (renderer) continue
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              retryable = retryable || isPrintRetryableError(props.error)
              if (renderer) renderer.error(props.error)
              if (emit("error", { error: props.error })) continue
              if (renderer) continue
              UI.error(err)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              if (renderer) renderer.finish()
              if (pendingUnknownStep) {
                const id = `step:${pendingUnknownStep.assistantMessageID}:unknown`
                const start = {
                  id,
                  sessionID,
                  messageID: pendingUnknownStep.assistantMessageID,
                  type: "step-start" as const,
                }
                const finish = {
                  id,
                  sessionID,
                  messageID: pendingUnknownStep.assistantMessageID,
                  type: "step-finish" as const,
                  reason: "unknown",
                  cost: 0,
                  tokens: {
                    total: 0,
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                }
                if (!renderer) {
                  emit("step_start", { part: start })
                  emit("step_finish", { part: finish })
                }
                pendingUnknownStep = undefined
              }
              break
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (auto) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
                break
              }
            }

            if (event.type === "permission.v2.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (auto) {
                await client.v2.session.permission.reply({
                  sessionID,
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.action} (${permission.resources.join(", ")}); auto-rejecting`,
                )
                await client.v2.session.permission.reply({
                  sessionID,
                  requestID: permission.id,
                  reply: "reject",
                })
                break
              }
            }
          }
          return { error, retryable }
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        await share(client, sessionID)

        if (!interactive) {
          const model = pick(args.model)

          if (printMode) {
            const messages = printMessages ?? [message]
            for (const nextMessage of messages) {
              const events = await client.event.subscribe()
              const completed = loop(client, events, printRenderer).catch((error) => {
                printRenderer?.error(error)
                return { error: String(error), retryable: isPrintRetryableError(error) }
              })
              const result = await client.session.prompt({
                sessionID,
                agent,
                model,
                variant: args.variant,
                parts: [...files, { type: "text", text: nextMessage }],
              })
              if (result.error) {
                printRenderer?.error(result.error)
                process.exitCode = isPrintRetryableError(result.error) ? 75 : 1
                return
              }
              const terminal = await completed
              if (terminal.error) {
                process.exitCode = terminal.retryable ? 75 : 1
                return
              }
            }
            return
          }

          const events = await client.event.subscribe()
          const completed = loop(client, events).catch((error) => {
            console.error(error)
            return { error: String(error), retryable: false }
          })
          async function finish() {
            if (args.attach) return
            const terminal = await completed
            if (terminal.error) process.exitCode = terminal.retryable ? 75 : 1
          }

          if (args.command) {
            const result = await client.session.command({
              sessionID,
              agent,
              model: args.model,
              command: args.command,
              arguments: message,
              variant: args.variant,
            })
            if (result.error) {
              if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
              process.exitCode = 1
              return
            }
            await finish()
            return
          }

          const result = await client.session.prompt({
            sessionID,
            agent,
            model,
            variant: args.variant,
            parts: [...files, { type: "text", text: message }],
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            return
          }
          await finish()
          return
        }

        const model = pick(args.model)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (interactive && !args.attach && !args.session && !args.continue) {
        const model = pick(args.model)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: localAgent,
            session,
            share,
            createSession: createFreshSession,
            agent: args.agent,
            model,
            variant: args.variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createArforgeClient({
        baseUrl: "http://arforge.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "arforge",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    share: undefined,
    model: input.model,
    agent: input.agent,
    format: "default",
    "print-mode": false,
    printMode: false,
    "input-format": "text",
    inputFormat: "text",
    "output-format": "text",
    outputFormat: "text",
    "final-message-only": false,
    finalMessageOnly: false,
    quiet: false,
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    interactive: false,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    demo: input.demo ?? false,
  })
}
