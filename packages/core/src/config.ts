export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse, modify, applyEdits } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@arforge-ai/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"
import { ConfigErrorV1 } from "./v1/config/error"
import { ConfigProviderV1 } from "./v1/config/provider"
import { ConfigMCPV1 } from "./v1/config/mcp"
import { EffectFlock } from "./util/effect-flock"
import { atomicWrite } from "./file-guard"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Config") {}

function patchDocument(text: string, value: unknown, pointer: string[] = []): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    pointer.at(-1) === "priceCatalog" ||
    (pointer.length === 3 && pointer[0] === "mcp" && pointer[1] === "servers" && "type" in value)
  ) {
    return applyEdits(text, modify(text, pointer, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  }
  return Object.entries(value).reduce((result, [key, next]) => patchDocument(result, next, [...pointer, key]), text)
}

/** Writes the canonical file in place; preserves source comments and unrelated fields. */
export const updateDocument = Effect.fn("Config.updateDocument")(function* (
  directory: string,
  patch: Readonly<Record<string, unknown>>,
  options?: { local?: boolean; validate?: (document: { path: string; text: string }) => void },
) {
  const fs = yield* FSUtil.Service
  const flock = yield* EffectFlock.Service
  return yield* flock.withLock(
    Effect.gen(function* () {
      const candidates = [
        ...(options?.local
          ? [path.join(directory, ".arforge", "arforge.jsonc"), path.join(directory, ".arforge", "arforge.json")]
          : []),
        path.join(directory, "arforge.jsonc"),
        path.join(directory, "arforge.json"),
      ]
      let file = path.join(directory, "arforge.jsonc")
      for (const candidate of candidates) {
        if (yield* fs.exists(candidate)) {
          file = candidate
          break
        }
      }
      const before = yield* fs
        .readFileString(file)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      // One-way preservation when saving an old profile for the first time. The
      // legacy source remains untouched; subsequent saves use the canonical file.
      const legacy =
        before === undefined
          ? yield* fs
              .readFileString(path.join(directory, "config.json"))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          : undefined
      const base = before ?? legacy
      const invalid = () =>
        new ConfigErrorV1.InvalidError({
          path: file,
          issues: [{ path: [], message: "The configuration is invalid; no changes were saved." }],
        })
      if (base !== undefined && decodeDocument(base, file).length === 0) return yield* Effect.die(invalid())
      const after = patchDocument(base ?? "{}\n", patch)
      if (decodeDocument(after, file).length === 0) return yield* Effect.die(invalid())
      // A remaining compatibility consumer must validate its response before
      // the commit. Reporting a failed save after modifying the file is unsafe.
      options?.validate?.({ path: file, text: after })
      const changed = before !== after
      if (changed) {
        if (before === undefined) yield* atomicWrite(file, after, undefined, { overwrite: false })
        else {
          if (!fs.writeIfUnchanged)
            return yield* Effect.die(new Error("Conditional config writing is unavailable; nothing was saved."))
          yield* fs.writeIfUnchanged(file, new TextEncoder().encode(before), after)
        }
      }
      return { path: file, text: after, changed }
    }),
    `config:${path.resolve(directory)}`,
  )
})

export const decodeDocument = (text: string, filepath?: string): Document[] => {
  const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
  const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
  const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return []

  const mcp = typeof input === "object" && input !== null && "mcp" in input ? ConfigMCPV1.split(input.mcp) : {}
  if (
    mcp.legacy !== undefined &&
    Option.isNone(Schema.decodeUnknownOption(ConfigV1.Info.fields.mcp, decodeOptions)(mcp.legacy))
  )
    throw new ConfigErrorV1.InvalidError({
      path: filepath ?? "ARFORGE_CONFIG_CONTENT",
      issues: [
        {
          path: ["mcp"],
          message: "Invalid legacy MCP configuration; correct or migrate the server settings before retrying.",
        },
      ],
    })
  const canonicalMcp =
    mcp.canonical === undefined ? undefined : Schema.decodeUnknownOption(ConfigMCP.Info, decodeOptions)(mcp.canonical)
  if (canonicalMcp !== undefined && Option.isNone(canonicalMcp))
    throw new ConfigErrorV1.InvalidError({
      path: filepath ?? "ARFORGE_CONFIG_CONTENT",
      issues: [
        { path: ["mcp"], message: "Invalid TS MCP configuration; correct the server settings before retrying." },
      ],
    })
  const legacy = ConfigMigrateV1.isV1(input) || mcp.legacy !== undefined
  const legacyInput =
    typeof input === "object" && input !== null && "mcp" in input ? { ...input, mcp: mcp.legacy } : input

  const canonical =
    typeof input === "object" && input !== null && "providers" in input
      ? Schema.decodeUnknownOption(Schema.Record(Schema.String, ConfigProvider.Info), decodeOptions)(input.providers)
      : undefined
  if (canonical !== undefined && Option.isNone(canonical)) {
    // Do not fall back to legacy or lower-priority prices after an explicit
    // canonical provider configuration fails validation. Never include values.
    throw new ConfigErrorV1.InvalidError({
      path: filepath ?? "ARFORGE_CONFIG_CONTENT",
      issues: [
        {
          path: ["providers"],
          message: "Invalid TS provider configuration; correct the model and priceCatalog settings before retrying.",
        },
      ],
    })
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "provider" in input &&
    Option.isNone(
      Schema.decodeUnknownOption(Schema.Record(Schema.String, ConfigProviderV1.Info), decodeOptions)(input.provider),
    )
  ) {
    throw new ConfigErrorV1.InvalidError({
      path: filepath ?? "ARFORGE_CONFIG_CONTENT",
      issues: [
        {
          path: ["provider"],
          message:
            "Invalid legacy provider configuration; migrate or correct the model and priceCatalog settings before retrying.",
        },
      ],
    })
  }

  const info = Option.getOrUndefined(
    legacy
      ? decodeV1Info(legacyInput).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
      : decodeInfo(input),
  )
  if (!info) return []
  const document = (info: Info) =>
    new Document({ type: "document", ...(filepath === undefined ? {} : { path: filepath }), info })
  // One file can contain migration spellings and canonical providers. Feed
  // both through the existing ordered config/plugin pipeline, canonical last.
  // This preserves model/variant merging and atomic price replacement without
  // a second merge algorithm or losing canonical-only model metadata.
  const overlay = {
    ...(canonical !== undefined && Option.isSome(canonical) ? { providers: canonical.value } : {}),
    ...(canonicalMcp !== undefined && Option.isSome(canonicalMcp) ? { mcp: canonicalMcp.value } : {}),
  }
  return legacy && Object.keys(overlay).length ? [document(info), document(new Info(overlay))] : [document(info)]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["arforge.json", "arforge.jsonc"]

    // Keep the inline configuration escape hatch on the canonical V2 config
    // owner.  The legacy CLI has historically used ARFORGE_CONFIG_CONTENT for
    // isolated subprocesses and embedders; if V2 ignores it, the formal
    // runner sees an empty catalog even though the mature adapter loaded the
    // same provider.  Decode through the same V1 migration path as files so
    // old `provider`/`formatter` shapes remain compatible while TS remains
    // the single runtime owner.

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return []
      return decodeDocument(text, filepath)
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.flat()),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".arforge", ...names.toReversed()],
            start: location.directory,
            stop: location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".arforge")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".arforge").toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.flat()),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, canonical project directories, then an
    // explicit inline override.  The latter mirrors the legacy loader's
    // local ARFORGE_CONFIG_CONTENT precedence and is intentionally ephemeral
    // (no synthetic path is exposed to relative-file/plugin resolution).
    const inline = process.env.ARFORGE_CONFIG_CONTENT ? decodeDocument(process.env.ARFORGE_CONFIG_CONTENT) : []
    const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat(), ...inline]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
