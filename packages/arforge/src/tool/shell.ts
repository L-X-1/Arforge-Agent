import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@arforge-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@arforge-ai/core/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { isProtectedSecretEnvironmentKey, sanitizeChildEnvironment } from "@arforge-ai/core/secret-environment"
import { SandboxRunner } from "@/sandbox/runner"
import { SandboxPolicy } from "@arforge-ai/core/sandbox/policy"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const LOCAL_ONLY_COMMANDS = new Set([
  "awk",
  "basename",
  "cat",
  "cd",
  "chdir",
  "chmod",
  "chown",
  "cp",
  "cut",
  "date",
  "df",
  "dirname",
  "du",
  "echo",
  "false",
  "file",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "mkdir",
  "mv",
  "pwd",
  "printf",
  "realpath",
  "rm",
  "rmdir",
  "sed",
  "sleep",
  "sort",
  "stat",
  "tail",
  "test",
  "touch",
  "tr",
  "true",
  "uniq",
  "wc",
  "which",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (isProtectedSecretEnvironmentKey(key)) return undefined
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

/**
 * The session Action Gateway needs a deliberately small, side-effect-free
 * view of a shell invocation before it can ask for an L3 approval.  This is
 * not a sandbox or a general shell evaluator: any construct whose filesystem
 * effects cannot be accounted for is rejected before a process can spawn.
 */
export type Preflight =
  | {
      readonly type: "known"
      readonly command: string
      readonly externalDirectoryGlobs: ReadonlyArray<string>
      readonly network: "none" | "possible"
    }
  | {
      readonly type: "unknown"
      readonly command: string
      readonly reason: string
    }

export class UnknownEffectError extends Error {
  override readonly name = "ShellUnknownEffectError"

  constructor(readonly reason: string) {
    super(`Shell command was not executed because its effects could not be fully preflighted: ${reason}`)
  }
}

type PreflightInput = {
  readonly command: string
  readonly cwd: string
  readonly instanceDirectory: string
  /** The configured executable, not a model-provided shell name. */
  readonly shell: string
}

function nodeTypes(root: Node) {
  const types = new Set<string>()
  const visit = (node: Node) => {
    types.add(node.type)
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index)
      if (child) visit(child)
    }
  }
  visit(root)
  return types
}

function externalDirectoryGlob(directory: string) {
  const glob = path.join(directory, "*")
  return process.platform === "win32" ? FSUtil.normalizePathPattern(glob) : glob
}

function insideDirectory(directory: string, target: string) {
  const relative = path.relative(directory, target)
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const networkRisk = (tokens: ReadonlyArray<string>): "none" | "possible" => {
  const executable = tokens[0]?.toLowerCase().replace(/^.*[\\/]/, "")
  return executable && LOCAL_ONLY_COMMANDS.has(executable) ? "none" : "possible"
}

/**
 * Parse only the POSIX single-command subset for which we can bind every
 * literal external path before approval.  PowerShell and cmd have distinct
 * expansion semantics; they remain L3 and fail closed until they receive an
 * equally complete parser, rather than pretending the Bash parser protects
 * them.
 */
export const preflight = Effect.fn("ShellPreflight.preflight")(function* (input: PreflightInput) {
  const shellName = Shell.name(input.shell)
  const kind = ShellID.toKind(shellName)
  if (shellName !== "bash" || !Shell.posix(input.shell)) {
    return {
      type: "unknown" as const,
      command: input.command,
      reason: `configured ${kind} shell has no complete static effect parser`,
    }
  }

  // Git Bash translates POSIX absolute paths through cygpath at execution.
  // A pure preflight must not invoke cygpath, so failing closed is safer than
  // binding the host's unrelated /tmp-style path.
  if (process.platform === "win32" && /(?:^|\s)["']?\//.test(input.command)) {
    return {
      type: "unknown" as const,
      command: input.command,
      reason: "POSIX absolute paths require runtime cygpath translation",
    }
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tree = yield* Effect.acquireRelease(parse(input.command, false), (tree) => Effect.sync(() => tree.delete()))
      const root = tree.rootNode
      const types = nodeTypes(root)
      const unsupported = [
        "redirected_statement",
        "file_redirect",
        "heredoc_redirect",
        "herestring_redirect",
        "pipeline",
        "command_substitution",
        "process_substitution",
        "subshell",
      ].find((type) => types.has(type))
      if (unsupported || root.hasError) {
        return {
          type: "unknown" as const,
          command: input.command,
          reason: unsupported ? `unsupported ${unsupported} syntax` : "shell syntax did not parse cleanly",
        }
      }

      const parsed = commands(root)
      // Relative arguments after `cd`, and every command in a compound list,
      // can depend on effects of an earlier command.  Do not infer a scope
      // from an execution order we have not modelled.
      if (parsed.length !== 1) {
        return {
          type: "unknown" as const,
          command: input.command,
          reason: "compound shell commands are not statically sequenced",
        }
      }

      const command = parts(parsed[0]!)
      const tokens = command.map((item) => item.text)
      const executable = tokens[0]
      const dirs = new Set<string>()
      if (executable && FILES.has(executable)) {
        for (const arg of pathArgs(command, false)) {
          const text = home(unquote(arg))
          if (!text || dynamic(text, false)) {
            return {
              type: "unknown" as const,
              command: input.command,
              reason: "dynamic filesystem path",
            }
          }
          const literal = prefix(text)
          if (!literal) {
            return {
              type: "unknown" as const,
              command: input.command,
              reason: "filesystem glob without a stable parent path",
            }
          }
          const resolved = path.resolve(input.cwd, literal)
          if (insideDirectory(input.instanceDirectory, resolved)) continue
          // The existing leaf resolves a literal as either a file (parent
          // directory) or a directory.  Stat declares both possible exact
          // directory scopes without consulting the filesystem.
          dirs.add(path.dirname(resolved))
          dirs.add(resolved)
        }
      }

      if (!insideDirectory(input.instanceDirectory, input.cwd)) dirs.add(input.cwd)
      return {
        type: "known" as const,
        command: input.command,
        externalDirectoryGlobs: Array.from(dirs, externalDirectoryGlob).sort((a, b) => a.localeCompare(b)),
        network: networkRisk(tokens),
      }
    }),
  )
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const sandbox = yield* SandboxRunner.Service
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return (
        sanitizeChildEnvironment({
          ...process.env,
          ...extra.env,
        }) ?? {}
      )
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        workspace: string
        env: NodeJS.ProcessEnv
        timeout: number
        roots: ReadonlyArray<string>
        readOnlyRoots: ReadonlyArray<string>
        profile: SandboxPolicy.Profile
        network: "none" | "inherit"
        requireEnforcement: boolean
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false
      let sandboxReport: SandboxRunner.Report | undefined

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const prepared = yield* sandbox.prepare({
            command: cmd(input.shell, input.command, input.cwd, input.env),
            workspace: input.workspace,
            cwd: input.cwd,
            roots: input.roots,
            readOnlyRoots: input.readOnlyRoots,
            profile: input.profile,
            network: input.network,
            requireEnforcement: input.requireEnforcement,
          })
          sandboxReport = prepared.report
          yield* ctx.metadata({
            metadata: {
              sandbox: prepared.report,
            },
          })
          const handle = yield* spawner.spawn(prepared.command)

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
          ...(sandboxReport ? { sandbox: sandboxReport } : { sandbox: { backend: sandbox.backend().kind } }),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              const shellPreflight = yield* preflight({
                command: params.command,
                cwd,
                instanceDirectory: instanceCtx.directory,
                shell,
              })
              // Unknown effects remain closed for automatic/scoped durable
              // actions. A gateway-verified fresh human L3 capability may
              // execute the exact command the person just approved.
              if (ctx.parentAction && shellPreflight.type === "unknown" && ctx.parentAction.authority !== "human") {
                throw new UnknownEffectError(shellPreflight.reason)
              }
              if (ctx.parentAction && shellPreflight.type === "known" && shellPreflight.network === "possible") {
                if (!ctx.egress?.assertProcess)
                  throw new UnknownEffectError(
                    "network-capable shell command requires an explicit process egress scope",
                  )
                yield* ctx.egress.assertProcess({ command: shellPreflight.command }).pipe(Effect.orDie)
              }
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              const sandboxProfile = ctx.sandboxProfile ?? SandboxPolicy.DefaultProfile
              const roots = new Set<string>([instanceCtx.directory, cwd])
              // Native Windows shells often load helper DLLs/interpreters from
              // beside the configured executable (Git Bash's usr/bin is a
              // common example).  Grant those installation directories as
              // read-only SBOX roots only when the host has the full
              // BaseContainer boundary; never turn them into writable roots or
              // weaken the truthful partial path on legacy hosts.
              const readOnlyRoots = new Set<string>()
              const backend = sandbox.backend()
              const msysLegacy =
                process.platform === "win32" &&
                backend.kind === "windows-native" &&
                backend.baseContainer.status === "available" &&
                /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/iu.test(shell)
              if (
                process.platform === "win32" &&
                backend.kind === "windows-native" &&
                backend.baseContainer.status === "available" &&
                !msysLegacy
              ) {
                let current = path.dirname(shell)
                for (let depth = 0; depth < 2; depth++) {
                  readOnlyRoots.add(current)
                  const parent = path.dirname(current)
                  if (parent === current) break
                  current = parent
                }
              }
              // A fresh human capability authorizes the exact opaque command
              // that the gateway displayed. Re-parsing an unknown PowerShell/
              // cmd compound command into leaf fragments would incorrectly
              // compare those fragments with the whole-command grant and
              // reject it as a scope expansion. The input digest still binds
              // execution to the exact approved command, so only bypass the
              // legacy leaf prompt for this narrow human + unknown case.
              const exactOpaqueHumanApproval =
                ctx.parentAction?.authority === "human" && shellPreflight.type === "unknown"
              if (!exactOpaqueHumanApproval) {
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                      Effect.sync(() => tree.delete()),
                    )
                    const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                    if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                    for (const directory of scan.dirs) roots.add(directory)
                    yield* ask(ctx, scan, params)
                  }),
                )
              }

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  workspace: instanceCtx.directory,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  roots: [...roots],
                  readOnlyRoots: [...readOnlyRoots],
                  profile: sandboxProfile,
                  network: shellPreflight.type === "known" && shellPreflight.network === "none" ? "none" : "inherit",
                  requireEnforcement:
                    (ctx.parentAction?.authority === "automatic" || ctx.parentAction?.authority === "scoped_grant") &&
                    (msysLegacy ||
                      sandboxProfile === "read-only" ||
                      (shellPreflight.type === "known" &&
                        (shellPreflight.network === "possible" || shellPreflight.externalDirectoryGlobs.length > 0))),
                },
                ctx,
              )
            }),
        }
      })
  }),
)

export * as ShellPreflight from "./shell"
