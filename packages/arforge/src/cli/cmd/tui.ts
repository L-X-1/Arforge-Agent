import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@arforge-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@arforge-ai/sdk/v2"
import type { EventSource } from "@arforge-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { ServerAuth } from "@/server/auth"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@arforge-ai/tui/terminal-win32"

declare global {
  const ARFORGE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof ARFORGE_WORKER_PATH !== "undefined") return ARFORGE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  // Keep the historical `chat` spelling as an alias of the same TUI owner.
  // `$0` remains the displayed/default command, so no second interactive
  // runtime is introduced for Python/legacy callers.
  command: "$0 [project]",
  aliases: ["chat"],
  describe: "启动 Arforge 终端界面",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "Arforge 的启动目录",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "要使用的模型，格式为 提供商/模型",
      })
      .option("continue", {
        alias: ["c"],
        describe: "继续上一次会话",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "要继续的会话 ID",
      })
      .option("fork", {
        type: "boolean",
        describe: "继续时复制会话（与 --continue 或 --session 配合使用）",
      })
      .option("prompt", {
        type: "string",
        describe: "要使用的提示词",
      })
      .option("agent", {
        type: "string",
        describe: "要使用的代理",
      })
      .option("auto", {
        type: "boolean",
        describe: "自动批准未明确拒绝的权限（危险）",
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
      .option("mini", {
        type: "boolean",
        describe: "启动精简交互界面",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "恢复或调整大小后不重放精简会话历史",
      })
      .option("replay-limit", {
        type: "number",
        describe: "精简界面最多重放最近 N 条消息",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    // Validate argument combinations before checking the terminal. This keeps
    // deterministic CLI errors visible in scripts and subprocesses that do
    // not have a TTY, instead of masking them with the generic TUI error.
    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }
    } else {
      const unsupported = [
        ["--no-replay", noReplay],
        ["--replay-limit", args.replayLimit !== undefined],
        ["--demo", args.demo !== undefined],
      ].find((entry) => entry[1])?.[0]
      if (unsupported) {
        UI.error(`${unsupported} requires --mini`)
        process.exitCode = 1
        return
      }
    }

    const hasTty = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY
    if (!hasTty) {
      UI.error("当前终端不支持 Arforge TUI（stdin/stdout/stderr 不是 TTY）")
      UI.println("")
      UI.error("请改用：bun run cli run \"你的问题\"（非交互模式）")
      UI.println("如果你需要界面模式，请在普通 PowerShell/Windows Terminal 里直接运行 bun run cli")
      process.exitCode = 1
      return
    }

    if (args.mini) {
      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const worker = new Worker(file, {
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      })
      const client = Rpc.client<typeof rpc>(worker)
      const reload = () => {
        client.call("reload", undefined).catch(() => {})
      }
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch(() => {})
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      const network = resolveNetworkOptionsNoConfig(args)
      const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true

      const headers = external ? ServerAuth.headers() : undefined

      const transport = external
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
            headers,
          }
        : {
            url: "http://arforge.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            fetch: transport.fetch,
            headers: transport.headers,
            events: transport.events,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
      } finally {
        await stop()
      }
    } finally {
      try {
        unguard?.()
      } catch {}
    }
    process.exit(0)
  },
})
// scratch
