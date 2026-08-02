import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["ARFORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["ARFORGE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("ARFORGE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  ARFORGE_AUTO_HEAP_SNAPSHOT: truthy("ARFORGE_AUTO_HEAP_SNAPSHOT"),
  ARFORGE_GIT_BASH_PATH: process.env["ARFORGE_GIT_BASH_PATH"],
  ARFORGE_CONFIG: process.env["ARFORGE_CONFIG"],
  ARFORGE_CONFIG_CONTENT: process.env["ARFORGE_CONFIG_CONTENT"],
  ARFORGE_DISABLE_AUTOUPDATE: truthy("ARFORGE_DISABLE_AUTOUPDATE"),
  ARFORGE_ALWAYS_NOTIFY_UPDATE: truthy("ARFORGE_ALWAYS_NOTIFY_UPDATE"),
  ARFORGE_DISABLE_PRUNE: truthy("ARFORGE_DISABLE_PRUNE"),
  ARFORGE_DISABLE_TERMINAL_TITLE: truthy("ARFORGE_DISABLE_TERMINAL_TITLE"),
  ARFORGE_SHOW_TTFD: truthy("ARFORGE_SHOW_TTFD"),
  ARFORGE_DISABLE_AUTOCOMPACT: truthy("ARFORGE_DISABLE_AUTOCOMPACT"),
  ARFORGE_DISABLE_MODELS_FETCH: truthy("ARFORGE_DISABLE_MODELS_FETCH"),
  ARFORGE_DISABLE_MOUSE: truthy("ARFORGE_DISABLE_MOUSE"),
  ARFORGE_FAKE_VCS: process.env["ARFORGE_FAKE_VCS"],
  ARFORGE_SERVER_PASSWORD: process.env["ARFORGE_SERVER_PASSWORD"],
  ARFORGE_SERVER_USERNAME: process.env["ARFORGE_SERVER_USERNAME"],
  get ARFORGE_AUTH_MODE() {
    return process.env["ARFORGE_AUTH_MODE"]?.trim().toLowerCase() ?? "private"
  },
  ARFORGE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("ARFORGE_DISABLE_FFF"),

  // Experimental
  ARFORGE_EXPERIMENTAL_FILEWATCHER: Config.boolean("ARFORGE_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ARFORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("ARFORGE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  ARFORGE_MODELS_URL: process.env["ARFORGE_MODELS_URL"],
  ARFORGE_MODELS_PATH: process.env["ARFORGE_MODELS_PATH"],
  ARFORGE_DB: process.env["ARFORGE_DB"],

  ARFORGE_WORKSPACE_ID: process.env["ARFORGE_WORKSPACE_ID"],
  ARFORGE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("ARFORGE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get ARFORGE_DISABLE_PROJECT_CONFIG() {
    return truthy("ARFORGE_DISABLE_PROJECT_CONFIG")
  },
  get ARFORGE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("ARFORGE_EXPERIMENTAL_REFERENCES")
  },
  get ARFORGE_TUI_CONFIG() {
    return process.env["ARFORGE_TUI_CONFIG"]
  },
  get ARFORGE_CONFIG_DIR() {
    return process.env["ARFORGE_CONFIG_DIR"]
  },
  get ARFORGE_PURE() {
    return truthy("ARFORGE_PURE")
  },
  get ARFORGE_PERMISSION() {
    return process.env["ARFORGE_PERMISSION"]
  },
  get ARFORGE_PLUGIN_META_FILE() {
    return process.env["ARFORGE_PLUGIN_META_FILE"]
  },
  get ARFORGE_CLIENT() {
    return process.env["ARFORGE_CLIENT"] ?? "cli"
  },
}
