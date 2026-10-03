import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"

const SENSITIVE_KEY = /^(?:api_key|authorization|auth_token|access_token|refresh_token|id_token|client_secret|secret|password|passwd|credential|credentials|private_key|token|[a-z0-9]+_(?:api_key|token|secret|password|passwd|credential))$/i
const REDACTED = "[REDACTED]"

function redactString(value: string) {
  return value.replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, "://[REDACTED]@")
}

/**
 * Keep `config` useful for diagnostics without turning it into a credential
 * dumper. The same recursive boundary covers provider options, MCP headers,
 * nested plugin settings and URL-embedded passwords.
 */
export function redactConfig(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_")
  if (SENSITIVE_KEY.test(normalizedKey)) return REDACTED
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redactConfig(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactConfig(childValue, childKey)]),
    )
  }
  return value
}

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  instance: false,
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    process.stdout.write(JSON.stringify(redactConfig(config), null, 2) + EOL)
  }),
})
