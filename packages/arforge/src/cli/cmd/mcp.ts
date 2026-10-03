import { cmd } from "./cmd"
import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpControlGateway } from "../../mcp/control-gateway"
import { McpAuth } from "../../mcp/auth"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@arforge-ai/core/v1/config/mcp"
import { ConfigMCP } from "@arforge-ai/core/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@arforge-ai/core/installation/version"
import { Global } from "@arforge-ai/core/global"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect, Schema } from "effect"
import { CliError } from "../effect-cmd"

const mcpCatalogError = (_error: unknown) =>
  new CliError({
    message: "读取 MCP 能力目录失败；请检查服务器连接、授权状态和传输范围后重试。",
    exitCode: 1,
  })

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpHealthCommand)
      .command(McpCapabilitiesCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Add servers with: arforge mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else if (status.status === "needs_approval") {
        statusIcon = "?"
        statusText = "needs approval"
        hint = "\n    " + status.reason
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpHealthCommand = effectCmd({
  command: "health",
  describe: "probe MCP servers and show retry/circuit health",
  handler: Effect.fn("Cli.mcp.health")(function* () {
    UI.empty()
    prompts.intro("MCP Health")
    const mcp = yield* MCP.Service
    const health = yield* mcp.health({ probe: true })
    const entries = Object.entries(health)
    if (entries.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Done")
      return
    }
    for (const [name, snapshot] of entries) {
      const retry = snapshot.nextRetryAt === null ? "" : `; retry after ${new Date(snapshot.nextRetryAt).toISOString()}`
      prompts.log.info(
        `${name}: ${snapshot.phase}/${snapshot.health} — ${snapshot.safeMessage} (failures: ${snapshot.failureCount}${retry})`,
      )
    }
    prompts.outro(`${entries.length} server(s) checked`)
  }),
})

export const McpCapabilitiesCommand = effectCmd({
  command: "capabilities",
  aliases: ["caps"],
  describe: "show the current generation-scoped MCP capability catalog",
  handler: Effect.fn("Cli.mcp.capabilities")(function* () {
    UI.empty()
    prompts.intro("MCP Capabilities")
    const mcp = yield* MCP.Service
    const capabilities = (yield* McpControlGateway.catalog({
      mcp,
      principal: ControlPrincipal.LOCAL_PRINCIPAL,
      requestID: AgentRuntime.ControlPlaneRequestID.create(),
    }).pipe(Effect.mapError(mcpCatalogError))).capabilities
    if (capabilities.length === 0) {
      prompts.log.warn("No capabilities are currently available. Connect an MCP server first.")
      prompts.outro("Done")
      return
    }

    const grouped = new Map<string, typeof capabilities>()
    for (const item of capabilities) grouped.set(item.server, [...(grouped.get(item.server) ?? []), item])
    for (const [server, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const generation = items[0]?.generation
      prompts.log.info(`${server} · generation ${generation ?? "?"}`)
      for (const item of items) {
        const target = item.reference ? ` — ${item.reference}` : ""
        prompts.log.info(`  ${item.kind}: ${item.name}${target}`)
      }
    }
    prompts.outro(`${capabilities.length} capability(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in arforge.json:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to authenticate",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Authorize in your browser:")
        prompts.log.info(url)
        spinner.start("Waiting for authorization...")
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const config = yield* cfg.get()
    // OAuth entries use an opaque project-scoped key. The CLI must only offer
    // configured display names, then delegate lookup/removal to MCP.Service;
    // using a persisted key as a name would HMAC it again and cross scopes.
    const stored = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    const serverNames = Object.entries(stored)
      .filter(([, hasTokens]) => hasTokens)
      .map(([name]) => name)
    const configuredNames = oauthServers(config).map(([name]) => name)
    // Pre-project-scoping records are deliberately never adopted. They can be
    // explicitly cleaned up, but cannot be treated as current-project servers.
    const legacyKeys = Object.keys(credentials).filter((key) => !key.startsWith("mcp-oauth:"))

    if (!args.name && serverNames.length === 0 && legacyKeys.length === 0) {
      prompts.log.warn("No MCP OAuth credentials stored")
      prompts.outro("Done")
      return
    }

    let selection:
      | { readonly type: "configured"; readonly name: string }
      | { readonly type: "legacy"; readonly key: string }
    if (args.name) {
      if (configuredNames.includes(args.name)) {
        selection = { type: "configured", name: args.name }
      } else if (legacyKeys.includes(args.name)) {
        selection = { type: "legacy", key: args.name }
      } else if (args.name.startsWith("mcp-oauth:")) {
        prompts.log.error("OAuth credential keys are project-scoped. Use the configured MCP server name instead.")
        prompts.outro("Done")
        return
      } else {
        prompts.log.error(`No current-project OAuth credentials found for: ${args.name}`)
        prompts.outro("Done")
        return
      }
    } else {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to logout",
          options: [
            ...serverNames.map((name) => ({
              label: name,
              value: `configured\u0000${name}`,
              hint: "current project",
            })),
            ...legacyKeys.map((key) => ({
              label: `Legacy credential: ${key}`,
              value: `legacy\u0000${key}`,
              hint: "not assigned to this project; removes only this legacy record",
            })),
          ],
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      const separator = selected.indexOf("\u0000")
      const kind = selected.slice(0, separator)
      const value = selected.slice(separator + 1)
      selection = kind === "configured" ? { type: "configured", name: value } : { type: "legacy", key: value }
    }

    if (selection.type === "configured") {
      yield* mcp.removeAuth(selection.name)
      prompts.log.success(`Removed OAuth credentials for ${selection.name}`)
    } else {
      yield* McpAuth.Service.use((auth) => auth.remove(selection.key))
      prompts.log.success(`Removed legacy OAuth credential record for ${selection.key}`)
    }
    prompts.outro("Done")
  }),
})

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("read-only-path", {
        describe:
          "request a read-only dependency directory (repeatable, relative to the workspace; approval required at connect)",
        type: "string",
        array: true,
      })
      .option("startup-timeout", {
        describe: "MCP connection and initialization timeout in milliseconds",
        type: "number",
      })
      .option("request-timeout", {
        describe: "MCP request timeout after initialization, in milliseconds",
        type: "number",
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  // A named invocation saves global configuration and must not bootstrap the
  // project or execute configured integrations before validating the edit.
  instance: (args) => !args.name,
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const ctx = args.name ? undefined : yield* InstanceRef
    const config = yield* Config.Service
    const locations = yield* LocationServiceMap.Service
    const global = Global.make()
    const selected = yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (
        !args.name &&
        (args.url ||
          args.env?.length ||
          args.header?.length ||
          args["read-only-path"]?.length ||
          args["startup-timeout"] !== undefined ||
          args["request-timeout"] !== undefined ||
          command.length)
      ) {
        throw new Error("A server name is required for non-interactive MCP configuration")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("Provide either --url <url> or a command after --")
        }
        if (args.url && (!URL.canParse(args.url) || !["http:", "https:"].includes(new URL(args.url).protocol))) {
          throw new Error("Invalid MCP URL. Use an HTTP or HTTPS URL.")
        }
        if (args.url && args.env?.length) {
          throw new Error("--env is only valid for local MCP servers")
        }
        if (args.url && args["read-only-path"]?.length)
          throw new Error("--read-only-path is only valid for local MCP servers")
        if (args["read-only-path"] !== undefined && !Schema.is(ConfigMCP.ReadOnlyPaths)(args["read-only-path"]))
          throw new Error("Invalid read-only dependency directory. Use non-empty paths without NUL characters.")
        if (command.length && args.header?.length) {
          throw new Error("--header is only valid for remote MCP servers")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Invalid ${kind}. Expected KEY=VALUE.`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const timeout = {
          ...(args["startup-timeout"] === undefined ? {} : { startup: args["startup-timeout"] }),
          ...(args["request-timeout"] === undefined ? {} : { request: args["request-timeout"] }),
        }
        if (!Schema.is(ConfigMCPV1.Timeout)(timeout))
          throw new Error("Invalid MCP timeout. Use positive whole milliseconds for startup and request timeouts.")
        const timeouts = Object.keys(timeout).length ? { timeout } : {}
        const mcpConfig: ConfigMCPV1.Info = args.url
          ? {
              type: "remote",
              url: args.url,
              ...timeouts,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...timeouts,
              ...(args["read-only-path"] === undefined ? {} : { read_only_paths: [...args["read-only-path"]] }),
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        return { name: args.name, config: mcpConfig, global: true }
      }

      UI.empty()
      prompts.intro("Add MCP server")

      if (!ctx) throw new Error("Project context is unavailable")
      const project = ctx.project

      // Determine scope
      let globalScope = true
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: "project",
              hint: ctx.worktree,
            },
            {
              label: "Global",
              value: "global",
              hint: global.config,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        globalScope = scopeResult === "global"
      }

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          placeholder: "e.g., arforge x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        return { name, config: mcpConfig, global: globalScope }
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            const isValid = URL.canParse(x) && ["http:", "https:"].includes(new URL(x).protocol)
            return isValid ? undefined : "Use an HTTP or HTTPS URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        return { name, config: mcpConfig, global: globalScope }
      }

      throw new Error("Unknown MCP server type")
    })
    const patch = { mcp: { [selected.name]: selected.config } }
    const saved = yield* selected.global
      ? config.updateGlobal(patch, locations)
      : config.update(patch, locations, { directory: ctx?.worktree })
    prompts.log.success(`MCP server "${selected.name}" added to ${saved.path}`)
    if (!args.name) prompts.outro("MCP server added successfully")
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const serverConfig = config.mcp?.[args.name]
    const authStatus =
      serverConfig && isMcpRemote(serverConfig) && serverConfig.oauth !== false
        ? yield* mcp.getAuthStatus(args.name)
        : undefined
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const serverName = args.name

      if (!serverConfig) {
        prompts.log.error(`MCP server not found: ${serverName}`)
        prompts.outro("Done")
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(`MCP server ${serverName} is not a remote server`)
        prompts.outro("Done")
        return
      }

      if (serverConfig.oauth === false) {
        prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)
        prompts.outro("Done")
        return
      }

      prompts.log.info(`Server: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)

      const status = authStatus!
      prompts.log.info(`Auth status: ${getAuthStatusIcon(status)} ${getAuthStatusText(status)}`)

      const spinner = prompts.spinner()
      spinner.start("Testing connection...")

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            ...serverConfig.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "arforge-debug", version: InstallationVersion },
            },
            id: 1,
          }),
        })

        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.info("Initial unauthenticated check returned 401, so this server requires OAuth")
          prompts.log.info(`Project-scoped OAuth status: ${getAuthStatusText(status)}`)
          prompts.log.info(`Run \"arforge mcp auth ${serverName}\" to start or refresh the trusted OAuth flow.`)
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success("Server responded successfully (no auth required or already authenticated)")
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(`Unexpected status: ${response.status}`)
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.stop("Connection failed", 1)
        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro("Debug complete")
    })
  }),
})
