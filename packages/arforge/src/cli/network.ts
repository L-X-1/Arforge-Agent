import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@arforge-ai/core/v1/config/config"
import type { Config } from "@/config/config"
import { Effect } from "effect"
import { resolve } from "node:path"

const options = {
  port: {
    type: "number" as const,
    describe: "监听端口",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "监听主机名",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "启用 mDNS 服务发现（主机名默认改为 0.0.0.0）",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "mDNS 自定义域名（默认：arforge.local）",
    default: "arforge.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "额外允许跨域访问的域名",
    default: [] as string[],
  },
  "https-cert": {
    type: "string" as const,
    describe: "HTTPS PEM 证书文件（需同时提供 --https-key）",
  },
  "https-key": {
    type: "string" as const,
    describe: "HTTPS PEM 私钥文件（需同时提供 --https-cert）",
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

export function hasArg(name: string) {
  return networkArgs().some((arg) => arg === name || arg.startsWith(name + "="))
}

function hasBooleanArg(name: string) {
  return networkArgs().some(
    (arg) => arg === name || arg === name + "=true" || arg === name + "=false" || arg === "--no-" + name.slice(2),
  )
}

function networkArgs() {
  const separator = process.argv.indexOf("--")
  return process.argv.slice(2, separator === -1 ? undefined : separator)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: ConfigV1.Info) {
  const portExplicitlySet = hasArg("--port")
  const hostnameExplicitlySet = hasArg("--hostname")
  const mdnsExplicitlySet = hasBooleanArg("--mdns")
  const mdnsDomainExplicitlySet = hasArg("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]
  const certFile = args["https-cert"] || process.env.ARFORGE_HTTPS_CERT
  const keyFile = args["https-key"] || process.env.ARFORGE_HTTPS_KEY
  if (!!certFile !== !!keyFile) {
    throw new Error("HTTPS requires both --https-cert and --https-key (or ARFORGE_HTTPS_CERT and ARFORGE_HTTPS_KEY).")
  }
  const tls = certFile && keyFile ? { certFile: resolve(certFile), keyFile: resolve(keyFile) } : undefined

  return { hostname, port, mdns, mdnsDomain, cors, tls }
}
