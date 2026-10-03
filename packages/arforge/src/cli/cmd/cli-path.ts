import { spawnSync } from "node:child_process"
import { readFile, realpath, lstat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { EOL } from "node:os"
import path from "node:path"
import type { Argv } from "yargs"
import { cmd } from "./cmd"

export type CliEntryKind = "canonical" | "canonical-shim" | "legacy-python" | "external" | "unknown"

export type CliEntryCandidate = Readonly<{
  readonly path: string
  readonly shellKind?: string
  readonly content?: string
  /** Produced by the read-only filesystem inspector, not inferred from a filename. */
  readonly verification?: Readonly<{
    kind: "repository-cmd" | "npm-shim"
    target: string
    launcher_digest: string
    source_digest: string
    wrapper_digest: string
    package_root: string
    package_version: string
    package_digest: string
  }>
}>

export type CliEntry = Readonly<{
  readonly path: string
  readonly kind: CliEntryKind
  readonly role: string
  readonly detail: string
  readonly verification?: CliEntryCandidate["verification"]
}>

export type CliEntryAudit = Readonly<{
  readonly schema_version: 2
  readonly command: "arforge"
  readonly resolver: "where.exe" | "which" | "PowerShell:Get-Command"
  readonly status: "ok" | "blocked" | "unavailable"
  readonly entries: ReadonlyArray<CliEntry>
  readonly canonical_entry_count: number
  readonly legacy_entry_count: number
  readonly external_entry_count: number
  /** Multiple shims may point at one logical TypeScript CLI implementation. */
  readonly logical_cli_count: number | null
  readonly recommendation: string
  readonly limitations: ReadonlyArray<string>
}>

type CliPathArgs = Readonly<{ readonly json: boolean; readonly "powershell-stdin": boolean }>

const productRoot = path.resolve(import.meta.dir, "../../../../..")

const normalize = (value: string, platform: NodeJS.Platform): string => {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "")
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

const digest = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex")
// Reviewed development launcher. A launcher change requires re-review; unknown bytes are not executed.
const reviewedLauncherDigest = "478e9d25d832c3a261652b4d47148409804e04f2e7ca205b7e3da9af7ff712e8"
// Exact, reviewed npm cmd-shim templates for this fixed package/bin target.
// Unknown template versions remain unknown until reviewed; never parse arbitrary shell programs.
const reviewedNpmShims: Readonly<Record<string, string>> = {
  "arforge.cmd": "d295eac6ad82bac1bd2e3ec5dfb7865bd466c57c4cd14f09ae76fcf2ac2440a1",
  arforge: "7f5484e01a2796fb82cfa901e4d7594dc3005b0b5c93d07ed2cc37c3510fcd27",
  "arforge.ps1": "43b068f827f09ce6349a98cdf192d75285319dc6054ecffc39a1c98139c5812f",
}
const cmdBody = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^rem(?:\s|$)/i.test(line))
    .join("\n")
    .toLowerCase()
const canonicalCmdBody =
  '@echo off\nsetlocal\nset "arforge_root=%~dp0"\nnode "%arforge_root%bin\\arforge.js" %*\nset "arforge_exit=%errorlevel%"\nendlocal & exit /b %arforge_exit%'

const fileName = (value: string): string => value.slice(value.lastIndexOf("/") + 1)

const isShimName = (value: string): boolean => value === "arforge" || value === "arforge.cmd" || value === "arforge.ps1"

const hasLegacyPythonContent = (content: string): boolean => {
  const normalized = content.toLocaleLowerCase("en-US").replaceAll("\\", "/")
  return (
    normalized.includes("main.py") ||
    normalized.includes("cli_bridge") ||
    normalized.includes("arforge.cli") ||
    /(?:^|[\s"'`])python(?:\.exe|3)?(?:[\s"'`]|$)/.test(normalized)
  )
}

/** Classify one resolver result without executing or trusting the entry. */
export const classifyCliEntry = (
  candidate: CliEntryCandidate,
  options: Readonly<{ readonly productRoot: string; readonly platform: NodeJS.Platform }>,
): CliEntry => {
  if (candidate.shellKind)
    return {
      path: candidate.path,
      kind: "unknown",
      role: `powershell-${candidate.shellKind.toLowerCase()}`,
      detail: `当前 PowerShell 的 ${candidate.shellKind} 参与命令解析；未执行该命令，不能认定为文件启动入口`,
    }
  const normalizedPath = normalize(candidate.path, options.platform)
  const normalizedRoot = normalize(options.productRoot, options.platform)
  const name = fileName(normalizedPath)
  const content = candidate.content ?? ""
  const executableContent = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:rem(?:\s|$)|::|#)/i.test(line))
    .join("\n")

  if (
    (normalizedPath.includes("/python/") && normalizedPath.includes("/scripts/")) ||
    hasLegacyPythonContent(executableContent)
  ) {
    return {
      path: candidate.path,
      kind: "legacy-python",
      role: "legacy-python-entry",
      detail: "疑似旧 Python CLI/bridge 入口，不应抢占 arforge",
    }
  }

  const verifiedTarget =
    candidate.verification?.wrapper_digest === digest(content) &&
    candidate.verification.launcher_digest === reviewedLauncherDigest &&
    /^[a-f0-9]{64}$/.test(candidate.verification.source_digest) &&
    /^[a-f0-9]{64}$/.test(candidate.verification.package_digest) &&
    normalize(candidate.verification.package_root, options.platform) === normalizedRoot &&
    normalize(candidate.verification.target, options.platform) === `${normalizedRoot}/packages/arforge/src/index.ts`
  if (
    verifiedTarget &&
    candidate.verification?.kind === "repository-cmd" &&
    normalizedPath === `${normalizedRoot}/arforge.cmd` &&
    cmdBody(content) === canonicalCmdBody
  ) {
    return {
      path: candidate.path,
      kind: "canonical",
      role: "typescript-repository-entry",
      detail: "已核验仓库 CMD 内容、launcher 指纹及当前 checkout 的 TS 目标实路径（非全链路安全认证）",
      verification: candidate.verification,
    }
  }

  if (verifiedTarget && candidate.verification?.kind === "npm-shim" && reviewedNpmShims[name] === digest(content)) {
    return {
      path: candidate.path,
      kind: "canonical-shim",
      role: "typescript-npm-shim",
      detail: "已核验 npm 模板、npm link 实路径及当前 checkout 的版本/源码指纹；与仓库入口共享同一 TS module",
      verification: candidate.verification,
    }
  }

  if (isShimName(name)) {
    return {
      path: candidate.path,
      kind: "unknown",
      role: "uninspectable-shim",
      detail: "启动脚本或目标尚未完整核验；路径位置和文本片段不能证明 canonical TS 入口",
    }
  }

  return {
    path: candidate.path,
    kind: "external",
    role: "external-entry",
    detail: "解析到产品目录之外的 arforge 入口，需要人工核验",
  }
}

/** Build a deterministic, side-effect-free audit from resolver candidates. */
export const buildCliEntryAudit = (
  candidates: ReadonlyArray<CliEntryCandidate>,
  options: Readonly<{
    readonly productRoot: string
    readonly platform: NodeJS.Platform
    readonly resolver?: "where.exe" | "which" | "PowerShell:Get-Command"
  }>,
): CliEntryAudit => {
  const seen = new Set<string>()
  const entries = candidates
    .filter((candidate) => {
      const key = normalize(candidate.path, options.platform)
      if (key.length === 0 || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((candidate) => classifyCliEntry(candidate, options))
  const canonicalEntryCount = entries.filter(
    (entry) => entry.kind === "canonical" || entry.kind === "canonical-shim",
  ).length
  const legacyEntryCount = entries.filter((entry) => entry.kind === "legacy-python").length
  const externalEntryCount = entries.filter((entry) => entry.kind === "external" || entry.kind === "unknown").length
  const status =
    entries.length === 0
      ? ("unavailable" as const)
      : canonicalEntryCount === 0 || legacyEntryCount > 0 || externalEntryCount > 0
        ? ("blocked" as const)
        : ("ok" as const)

  const recommendation =
    status === "ok"
      ? "当前解析项均指向 TypeScript/Core；多个 shim 仍是同一逻辑 CLI，不代表多套实现。"
      : status === "blocked"
        ? "请将旧 Python 或无法核验的外部入口移出 PATH；本命令只诊断，不自动删除或改写系统 PATH。"
        : "无法解析 arforge 命令；请确认已安装 TypeScript CLI 或从 Arforge 工作区启动。"

  return Object.freeze({
    schema_version: 2 as const,
    command: "arforge" as const,
    resolver: options.resolver ?? (options.platform === "win32" ? "where.exe" : "which"),
    status,
    entries: Object.freeze(entries),
    canonical_entry_count: canonicalEntryCount,
    legacy_entry_count: legacyEntryCount,
    external_entry_count: externalEntryCount,
    logical_cli_count: externalEntryCount > 0 || legacyEntryCount > 0 ? null : canonicalEntryCount > 0 ? 1 : 0,
    recommendation,
    limitations: Object.freeze([
      "仅覆盖 where.exe/which 返回的文件候选；检查当前 PowerShell alias/function 请在该会话执行 scripts/arforge-cli-path.ps1。",
      "仅验证已审阅的仓库 CMD 和固定 npm shim 模板到当前 checkout 的目标；其他模板/安装版 bin/环境覆盖项仍待核验。",
      "指纹不是签名或全链路安全认证；读取要求文件稳定，不提供对抗并发替换的原子快照。",
    ]),
  })
}

type Discovery = Readonly<{
  readonly resolver: "where.exe" | "which"
  readonly paths: ReadonlyArray<string>
}>

const discover = (platform: NodeJS.Platform): Discovery => {
  const resolver = platform === "win32" ? "where.exe" : "which"
  const args = platform === "win32" ? ["arforge"] : ["-a", "arforge"]
  const result = spawnSync(resolver, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 2_000,
  })
  if (result.error || result.status !== 0) return { resolver, paths: [] }
  const output = typeof result.stdout === "string" ? result.stdout : ""
  const paths = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 32)
  return { resolver, paths: Object.freeze(paths) }
}

const readShimContent = async (entryPath: string): Promise<string | undefined> => {
  if (path.extname(entryPath).toLocaleLowerCase("en-US") === ".exe") return undefined
  try {
    const info = await lstat(entryPath)
    if (!info.isFile() || info.size > 32_768) return undefined
    return await readFile(entryPath, "utf8")
  } catch {
    return undefined
  }
}

/** Never executes a discovered wrapper; verifies only reviewed command chains and their real targets. */
export const inspectCliCandidate = async (entryPath: string, product: string): Promise<CliEntryCandidate> => {
  // Local diagnostics must not follow caller-supplied UNC/device paths into remote filesystem authentication.
  if (/^[\\/]{2}/.test(entryPath) || /^[\\/]{2}/.test(product)) return { path: entryPath }
  const content = await readShimContent(entryPath)
  const candidate = { path: entryPath, content }
  if (content === undefined) return candidate
  const name = path.basename(entryPath).toLowerCase()
  const repositoryCmd = name === "arforge.cmd" && cmdBody(content) === canonicalCmdBody
  const npmShim = reviewedNpmShims[name] === digest(content)
  if (!repositoryCmd && !npmShim) return candidate
  try {
    const root = await realpath(product)
    if (repositoryCmd && (await realpath(entryPath)) !== path.join(root, "arforge.cmd")) return candidate
    if (npmShim) {
      const packagePath = path.join(path.dirname(entryPath), "node_modules/arforge-agent")
      if ((await realpath(packagePath)) !== root) return candidate
      if ((await realpath(path.join(packagePath, "bin/arforge.js"))) !== path.join(root, "bin/arforge.js"))
        return candidate
    }
    const launcher = path.join(root, "bin/arforge.js")
    const target = path.join(root, "packages/arforge/src/index.ts")
    if ((await realpath(launcher)) !== launcher || (await realpath(target)) !== target) return candidate
    const launcherText = await readShimContent(launcher)
    const source = await readShimContent(target)
    const manifestPath = path.join(root, "package.json")
    if ((await realpath(manifestPath)) !== manifestPath) return candidate
    const manifestText = await readShimContent(manifestPath)
    if (manifestText === undefined) return candidate
    const manifest: unknown = JSON.parse(manifestText)
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("name" in manifest) ||
      manifest.name !== "arforge-agent" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(manifest.version)
    )
      return candidate
    if (launcherText === undefined || source === undefined || digest(launcherText) !== reviewedLauncherDigest)
      return candidate
    return {
      ...candidate,
      verification: {
        kind: npmShim ? "npm-shim" : "repository-cmd",
        target,
        launcher_digest: digest(launcherText),
        source_digest: digest(source),
        wrapper_digest: digest(content),
        package_root: root,
        package_version: manifest.version,
        package_digest: digest(manifestText),
      },
    }
  } catch {
    return candidate
  }
}

/** Inspect the host command resolver without spawning Arforge or touching state. */
export const inspectCliEntries = async (options?: {
  readonly productRoot?: string
  readonly platform?: NodeJS.Platform
}): Promise<CliEntryAudit> => {
  const platform = options?.platform ?? process.platform
  const product = options?.productRoot ?? productRoot
  const discovery = discover(platform)
  const candidates = await Promise.all(discovery.paths.map((entryPath) => inspectCliCandidate(entryPath, product)))
  return buildCliEntryAudit(candidates, { productRoot: product, platform, resolver: discovery.resolver })
}

/** Consume a bounded current-session metadata snapshot. Never execute captured command text. */
export const inspectPowerShellSnapshot = async (input: string, product = productRoot): Promise<CliEntryAudit> => {
  if (Buffer.byteLength(input, "utf8") > 32_768) throw new Error("PowerShell snapshot exceeds 32768 bytes")
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    throw new Error("Invalid PowerShell snapshot JSON")
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("commands" in value) ||
    !Array.isArray(value.commands) ||
    value.commands.length > 64 ||
    Object.keys(value).some((key) => key !== "schema_version" && key !== "commands")
  )
    throw new Error("Invalid PowerShell snapshot")
  const candidates: CliEntryCandidate[] = []
  for (const row of value.commands) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.name !== "string" ||
      !["arforge", "arforge.cmd", "arforge.ps1", "arforge.exe", "arforge.bat"].includes(row.name.toLowerCase()) ||
      !["Application", "ExternalScript", "Alias", "Function", "Filter", "Cmdlet"].includes(row.command_type) ||
      Object.keys(row).some((key) => !["name", "command_type", "path", "alias_target"].includes(key))
    )
      throw new Error("Invalid PowerShell command metadata")
    if (row.command_type === "Application" || row.command_type === "ExternalScript") {
      if (
        typeof row.path !== "string" ||
        row.path.includes("\0") ||
        row.path.split(/[\\/]/).at(-1)?.toLowerCase() !== row.name.toLowerCase() ||
        (!path.isAbsolute(row.path) && !path.win32.isAbsolute(row.path))
      )
        throw new Error("PowerShell file command needs an absolute path")
      candidates.push(await inspectCliCandidate(row.path, product))
    } else {
      // Alias target names and function definitions are not needed to prove shadowing.
      candidates.push({ path: `<PowerShell ${row.command_type}: ${row.name}>`, shellKind: row.command_type })
    }
  }
  const report = buildCliEntryAudit(candidates, {
    productRoot: product,
    platform: process.platform,
    resolver: "PowerShell:Get-Command",
  })
  return {
    ...report,
    limitations: [
      "来自调用者提供的当前 PowerShell 会话元数据，按 Get-Command -All 顺序显示；未执行 alias/function，未验证 snapshot 来源真实性。",
      ...report.limitations.slice(1),
    ],
  }
}

const readPowerShellStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) throw new Error("请在当前 PowerShell 执行 scripts/arforge-cli-path.ps1，不要手工等待 stdin")
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      process.stdin.off("data", onData).off("end", onEnd).off("error", onError)
      process.stdin.pause()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > 32_768) {
        onError(new Error("PowerShell snapshot exceeds 32768 bytes"))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const timer = setTimeout(() => onError(new Error("PowerShell snapshot input timed out")), 10_000)
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError)
  })
}

const statusLabel: Record<CliEntryAudit["status"], string> = {
  ok: "正常",
  blocked: "需处理",
  unavailable: "不可用",
}

const kindLabel: Record<CliEntryKind, string> = {
  canonical: "TS canonical",
  "canonical-shim": "TS shim",
  "legacy-python": "旧 Python",
  external: "外部入口",
  unknown: "未核验入口",
}

const render = (report: CliEntryAudit): string => {
  const lines = [
    "Arforge CLI 入口解析（只读）",
    `解析器：${report.resolver}`,
    `状态：${statusLabel[report.status]} · 逻辑 CLI=${report.logical_cli_count ?? "未确定"} · canonical 解析项=${report.canonical_entry_count}`,
    "解析项：",
    ...(report.entries.length === 0
      ? ["- （未发现 arforge 命令）"]
      : report.entries.map((entry) => `- ${kindLabel[entry.kind]} · ${entry.path} · ${entry.detail}`)),
    `建议：${report.recommendation}`,
    ...report.limitations.map((limitation) => `范围：${limitation}`),
  ]
  return lines.join(EOL) + EOL
}

/** User-facing read-only CLI entry diagnostic; it never edits PATH or files. */
export const CliPathCommand = cmd<{}, CliPathArgs>({
  command: "cli-path",
  describe: "检查 arforge 命令解析路径与旧入口（只读）",
  builder: (yargs: Argv) =>
    yargs
      .option("powershell-stdin", {
        type: "boolean",
        default: false,
        describe: "读取当前 PowerShell 会话的只读命令元数据（配合 scripts/arforge-cli-path.ps1）",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "输出机器可读 JSON",
      }),
  async handler(args) {
    let report: CliEntryAudit
    try {
      report = args["powershell-stdin"]
        ? await inspectPowerShellSnapshot(await readPowerShellStdin())
        : await inspectCliEntries()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid command metadata"
      if (args.json)
        process.stdout.write(JSON.stringify({ schema_version: 2, status: "blocked", error: message }) + EOL)
      else process.stderr.write(`入口诊断失败：${message}${EOL}`)
      process.exitCode = 2
      return
    }
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + EOL)
    else process.stdout.write(render(report))
    if (report.status !== "ok") process.exitCode = 1
  },
})

export { render as renderCliEntryAudit }
