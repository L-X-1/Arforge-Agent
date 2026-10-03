import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { httpClient } from "@arforge-ai/core/effect/app-node-platform"
import { serviceUse } from "@arforge-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@arforge-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@arforge-ai/core/v1/config/console-state"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema, RcMap, ScopedCache } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import { ConfigProviderV1 } from "@arforge-ai/core/v1/config/provider"
import { ConfigProvider } from "@arforge-ai/core/config/provider"
import { ConfigMCP } from "@arforge-ai/core/config/mcp"
import { ConfigMCPV1 } from "@arforge-ai/core/v1/config/mcp"
import { Config as CoreConfig } from "@arforge-ai/core/config"
import { ConfigMigrateV1 } from "@arforge-ai/core/v1/config/migrate"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import { Billing } from "@arforge-ai/schema/billing"
import { Database } from "@arforge-ai/core/database/database"
import { RemoteAuthError } from "@arforge-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@arforge-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@arforge-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@arforge-ai/core/npm"
import { ConfigPluginDependency } from "./dependency"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source) as Info
  for (const [id, provider] of Object.entries(source.provider ?? {})) {
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const output = merged.provider?.[id]?.models?.[modelID]
      if (output && model.priceCatalog !== undefined) output.priceCatalog = model.priceCatalog
    }
  }
  // Preserve layered overrides for the same transport, but never carry the
  // previous endpoint's authentication or environment to another transport.
  for (const [name, server] of Object.entries(source.mcp ?? {})) {
    const previous = target.mcp?.[name]
    if (
      server.type !== undefined &&
      merged.mcp &&
      (!previous || previous.type === undefined || !sameMcpTransport(previous, server))
    )
      merged.mcp[name] = server
  }
  return merged
}

function sameMcpTransport(previous: ConfigMCPV1.Info, next: ConfigMCPV1.Info): boolean {
  if (previous.type === "remote" && next.type === "remote") return previous.url === next.url
  if (previous.type !== "local" || next.type !== "local") return false
  return (
    previous.cwd === next.cwd &&
    previous.command.length === next.command.length &&
    previous.command.every((argument, index) => argument === next.command[index])
  )
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  if (copy.mcp !== undefined) {
    const parts = ConfigMCPV1.split(copy.mcp)
    const canonical =
      parts.canonical === undefined ? undefined : ConfigParse.schema(ConfigMCP.Info, parts.canonical, source)
    const legacy = parts.legacy === undefined ? {} : ConfigParse.schema(ConfigV1.Info.fields.mcp, parts.legacy, source)
    const servers = mergeConfig(
      { mcp: legacy ?? {} },
      {
        mcp: Object.fromEntries(
          Object.entries(canonical?.servers ?? {}).map(([name, server]) => [name, ConfigMCPV1.fromCanonical(server)]),
        ),
      },
    ).mcp
    for (const server of Object.values(servers ?? {})) {
      if (server.type !== undefined && server.timeout !== undefined)
        server.timeout = ConfigMCPV1.canonicalTimeout(server.timeout, "server")
    }
    copy.mcp = servers
    if (canonical?.timeout !== undefined)
      copy.experimental = {
        ...(isRecord(copy.experimental) ? copy.experimental : {}),
        mcp_timeout: {
          ...ConfigMCPV1.canonicalTimeout(
            isRecord(copy.experimental) && copy.experimental.mcp_timeout !== undefined
              ? ConfigParse.schema(ConfigMCPV1.Timeout, copy.experimental.mcp_timeout, source)
              : undefined,
            "defaults",
          ),
          ...canonical.timeout,
        },
      }
  }
  // Normalize before merging documents so a legacy scalar request override
  // cannot erase an inherited canonical startup timeout.
  if (isRecord(copy.experimental) && copy.experimental.mcp_timeout !== undefined)
    copy.experimental = {
      ...copy.experimental,
      mcp_timeout: ConfigMCPV1.canonicalTimeout(
        ConfigParse.schema(ConfigMCPV1.Timeout, copy.experimental.mcp_timeout, source),
        "defaults",
      ),
    }
  if (copy.provider !== undefined) {
    ConfigParse.schema(Schema.Record(Schema.String, ConfigProviderV1.Info), copy.provider, source)
  }
  if (copy.providers !== undefined) {
    const providers = ConfigParse.schema(Schema.Record(Schema.String, ConfigProvider.Info), copy.providers, source)
    copy.provider = mergeDeep(
      isRecord(copy.provider) ? copy.provider : {},
      Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [id, ConfigProviderV1.fromCanonical(provider)]),
      ),
    )
    // A catalog revision is a complete billing contract, not a field-by-field
    // patch. Never retain rates from a legacy revision beneath the TS price.
    for (const [id, provider] of Object.entries(providers)) {
      const mergedProvider = isRecord(copy.provider) ? copy.provider[id] : undefined
      const models = isRecord(mergedProvider) ? mergedProvider.models : undefined
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (model.priceCatalog !== undefined) {
          const target = isRecord(models) ? models[modelID] : undefined
          if (isRecord(target)) target.priceCatalog = Schema.encodeSync(Billing.PriceCatalog)(model.priceCatalog)
        }
      }
    }
    delete copy.providers
  }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

type LocationMap = Context.Service.Shape<typeof LocationServiceMap.Service>

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (
    config: Info,
    locations: LocationMap,
    options?: { directory?: string },
  ) => Effect.Effect<{ path: string; changed: boolean }>
  readonly updateGlobal: (
    config: Info,
    locations: LocationMap,
  ) => Effect.Effect<{ info: Info; changed: boolean; path: string }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["arforge.jsonc", "arforge.json", "config.json"].map((file) =>
    path.join(Flag.ARFORGE_CONFIG_DIR ?? Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

function canonicalPatch(info: Info) {
  const { provider: _provider, mcp: _mcp, ...rest } = Schema.encodeSync(ConfigV1.Info)(writable(info))
  // The existing migration is the only provider spelling conversion. JSON
  // encoding omits migration placeholders instead of deleting authored fields.
  const migrated = ConfigMigrateV1.migrate(info)
  const encode = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
  return {
    ...rest,
    ...(info.provider === undefined ? {} : { providers: encode(migrated.providers) }),
    ...(info.mcp === undefined ? {} : { mcp: encode(migrated.mcp ?? {}) }),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient
    const flock = yield* EffectFlock.Service
    const constructionContext = yield* Effect.context()

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed, source), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      const globalDirectory = Flag.ARFORGE_CONFIG_DIR ?? Global.Path.config
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.ARFORGE_CONFIG && !Flag.ARFORGE_CONFIG_DIR && !Flag.ARFORGE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs.writeWithDirs(file, "{}\n").pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(globalDirectory, "config.json"), env))
      for (const file of ["arforge.json", "arforge.jsonc"]) {
        result = mergeConfig(result, yield* loadFile(path.join(globalDirectory, file), env))
      }

      const legacy = path.join(globalDirectory, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(globalDirectory, "arforge.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "ARFORGE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/arforge`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.ARFORGE_CONFIG) {
          yield* merge(Flag.ARFORGE_CONFIG, yield* loadFile(Flag.ARFORGE_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.ARFORGE_CONFIG })
        }

        if (!Flag.ARFORGE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("arforge", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.ARFORGE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from ARFORGE_CONFIG_DIR", { path: Flag.ARFORGE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".arforge") || dir === Flag.ARFORGE_CONFIG_DIR) {
            for (const file of ["arforge.json", "arforge.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [ConfigPluginDependency],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              // Dependency installation belongs to the config snapshot that
              // requested it. Keep it in that snapshot's scope so invalidation
              // or instance disposal cannot leave an orphan npm worker behind
              // while the next snapshot (or SQLite cleanup) starts.
              Effect.forkScoped({ startImmediately: true }),
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.arforge/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.ARFORGE_CONFIG_CONTENT) {
          const source = "ARFORGE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.ARFORGE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from ARFORGE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["ARFORGE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("ARFORGE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["arforge.json", "arforge.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.ARFORGE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.ARFORGE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("ARFORGE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.ARFORGE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.ARFORGE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (
      config: Info,
      locations: LocationMap,
      options?: { directory?: string },
    ) {
      const dir = options?.directory ?? (yield* InstanceState.directory)
      const result = yield* CoreConfig.updateDocument(dir, canonicalPatch(config), { local: true }).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(EffectFlock.Service, flock),
        Effect.orDie,
      )
      if (!result.changed) return { path: result.path, changed: false }
      // A project file is inherited by already-opened descendant directories.
      // Invalidate their original product snapshots as well as the Core map;
      // otherwise CLI/server consumers disagree after a successful save.
      for (const key of yield* ScopedCache.keys(state.cache)) {
        if (FSUtil.contains(dir, key))
          yield* ScopedCache.invalidate(state.cache, key).pipe(Effect.provide(constructionContext))
      }
      yield* invalidateLocations(locations, dir)
      return { path: result.path, changed: true }
    })

    const invalidateLocations = Effect.fnUntraced(function* (locations: LocationMap, directory?: string) {
      // The caller passes its actual runtime owner, captured at its application
      // boundary. A pruned request context must not silently skip this step.
      const keys = Array.from(yield* RcMap.keys(locations.rcMap))
      for (const key of keys) {
        if (directory !== undefined && !FSUtil.contains(directory, key.directory)) continue
        yield* locations.invalidate(key)
      }
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info, locations: LocationMap) {
      const savedInfo = (document: { path: string; text: string }) =>
        ConfigParse.schema(
          ConfigV1.Info,
          normalizeLoadedConfig(ConfigParse.jsonc(document.text, document.path), document.path),
          document.path,
        )
      const result = yield* CoreConfig.updateDocument(
        Flag.ARFORGE_CONFIG_DIR ?? Global.Path.config,
        canonicalPatch(writableGlobal(config)),
        { validate: savedInfo },
      ).pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(EffectFlock.Service, flock), Effect.orDie)
      const info = savedInfo(result)
      if (result.changed) {
        yield* invalidate()
        yield* ScopedCache.invalidateAll(state.cache).pipe(Effect.provide(constructionContext))
        yield* invalidateLocations(locations)
      }
      return { info, changed: result.changed, path: result.path }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient, Database.node, EffectFlock.node],
})

export * as Config from "./config"
