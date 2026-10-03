import { Context, Effect, Layer, Schema } from "effect"
import { existsSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"
import { ChildProcess } from "effect/unstable/process"
import {
  SandboxPolicy,
  type Enforcement,
  type Network,
  type Profile,
  type Resolved,
} from "@arforge-ai/core/sandbox/policy"
import { which } from "@arforge-ai/core/util/which"
import { makeGlobalNode } from "@arforge-ai/core/effect/app-node"
import { probeWindowsNativeCapability, type WindowsNativeCapability } from "./windows-native-capability"
import { probeUnixNativeCapability, type UnixNativeCapability } from "./unix-native-capability"

export type Backend =
  | { readonly kind: "bubblewrap"; readonly executable: string; readonly capability?: UnixNativeCapability }
  | { readonly kind: "sandbox-exec"; readonly executable: string; readonly capability?: UnixNativeCapability }
  | {
      readonly kind: "windows-native"
      readonly executable: string
      readonly helper: string
      /** Host-gated BaseContainer capability selected by the launcher for workspace-write. */
      readonly baseContainer: WindowsNativeCapability
    }
  | { readonly kind: "none"; readonly reason: string }

export type Report = {
  readonly backend: Backend["kind"]
  readonly enforcement: Enforcement
  readonly profile: Profile
  readonly network: Network
  readonly roots: ReadonlyArray<string>
  readonly readOnlyRoots?: ReadonlyArray<string>
  /** Per-dimension enforcement, so callers do not infer capabilities from one status string. */
  readonly capabilities: {
    readonly processBoundary: "none" | "low-integrity-token" | "pid-namespace" | "seatbelt" | "app-container" | "host"
    readonly fileSystem:
      | "host"
      | "low-integrity-only"
      | "read-only-mounts"
      | "workspace-mounts"
      | "seatbelt-profile"
      | "app-container-paths"
    readonly network: "host" | "inherited" | "unshared" | "seatbelt" | "app-container-policy"
    readonly processTree: "host" | "job-kill-on-close" | "die-with-parent" | "seatbelt"
  }
  /** Optional native capability detail, currently populated on Windows. */
  readonly nativeBoundary?: WindowsNativeCapability | UnixNativeCapability
  readonly reason: string
}

export type PrepareInput = {
  readonly command: ChildProcess.StandardCommand
  readonly workspace: string
  readonly cwd: string
  readonly roots?: ReadonlyArray<string>
  readonly readOnlyRoots?: ReadonlyArray<string>
  readonly profile?: Profile
  readonly network?: Network
  /** Non-human/automatic execution can require a real host backend. */
  readonly requireEnforcement?: boolean
}

/**
 * Read-only input for callers that need to explain the selected sandbox
 * policy without preparing or executing a child process.
 */
export type StatusInput = {
  readonly workspace: string
  readonly cwd: string
  readonly roots?: ReadonlyArray<string>
  readonly readOnlyRoots?: ReadonlyArray<string>
  readonly profile?: Profile
  readonly network?: Network
}

export type Prepared = {
  readonly command: ChildProcess.StandardCommand
  readonly report: Report
}

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("SandboxRunner.UnavailableError", {
  message: Schema.String,
  profile: Schema.Literals(["read-only", "workspace-write", "unrestricted"]),
}) {}

export class UnsupportedCommandError extends Schema.TaggedErrorClass<UnsupportedCommandError>()(
  "SandboxRunner.UnsupportedCommandError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly backend: () => Backend
  readonly prepare: (input: PrepareInput) => Effect.Effect<Prepared, UnavailableError | UnsupportedCommandError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SandboxRunner") {}

/** Resolve the host backend without implying that an unavailable backend is safe. */
export function detectBackend(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Backend {
  if (platform === "linux") {
    const executable = which("bwrap", env)
    if (executable) {
      const capability = probeUnixNativeCapability("bubblewrap", executable, platform, env)
      if (capability.status === "available") return { kind: "bubblewrap", executable, capability }
      return { kind: "none", reason: capability.reason }
    }
    return { kind: "none", reason: "bubblewrap is not installed or is not available on PATH" }
  }
  if (platform === "darwin") {
    const executable = which("sandbox-exec", env)
    if (executable) {
      const capability = probeUnixNativeCapability("seatbelt", executable, platform, env)
      if (capability.status === "available") return { kind: "sandbox-exec", executable, capability }
      return { kind: "none", reason: capability.reason }
    }
    return { kind: "none", reason: "sandbox-exec is not available on PATH" }
  }
  if (platform === "win32") {
    if (env.ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE === "1")
      return {
        kind: "none",
        reason: "Windows native sandbox backend disabled by ARFORGE_SANDBOX_DISABLE_WINDOWS_NATIVE",
      }
    const executable = which("bun", env)
    const helper = fileURLToPath(new URL("./windows-launcher.ts", import.meta.url))
    const baseContainer = probeWindowsNativeCapability(platform, env)
    if (executable && existsSync(helper)) return { kind: "windows-native", executable, helper, baseContainer }
    // Compiled Arforge embeds the launcher behind a private self-hosted flag,
    // so it does not depend on a separately installed Bun or source file.
    if (existsSync(process.execPath) && isSelfHostedArforgeExecutable(process.execPath))
      return {
        kind: "windows-native",
        executable: process.execPath,
        helper: WINDOWS_SANDBOX_HELPER_FLAG,
        baseContainer,
      }
    return {
      kind: "none",
      reason: executable
        ? `Windows sandbox helper is missing: ${helper}`
        : "Bun is not available to run the Windows Restricted Token helper",
    }
  }
  return { kind: "none", reason: `no OS sandbox backend is implemented for ${platform}` }
}

function shellTarget(command: ChildProcess.StandardCommand): ReadonlyArray<string> {
  const shell = command.options.shell
  if (shell === undefined || shell === false) return [command.command, ...command.args]
  if (command.args.length > 0)
    throw new UnsupportedCommandError({
      message: "SandboxRunner cannot safely wrap a shell command that also has positional arguments",
    })
  // The only backends that call this helper are POSIX wrappers (bubblewrap
  // and Seatbelt). A Windows shell command is never wrapped because the
  // Windows backend currently reports `none`; using the host platform here
  // would make deterministic Linux/macOS command construction depend on the
  // platform running the test.
  const executable = typeof shell === "string" ? shell : "/bin/sh"
  return [executable, "-c", command.command]
}

function bwrapCommand(command: ChildProcess.StandardCommand, policy: Resolved, executable: string) {
  const writable = policy.profile === "workspace-write"
  const bind = writable ? "--bind" : "--ro-bind"
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--chdir",
    policy.cwd,
    ...policy.roots.flatMap((root) => [bind, root, root]),
    ...(policy.network === "none" ? ["--unshare-net"] : []),
    "--",
    ...shellTarget(command),
  ]
  return ChildProcess.make(executable, args, {
    ...command.options,
    shell: undefined,
  })
}

function sandboxProfile(policy: Resolved) {
  const quote = (value: string) => JSON.stringify(value)
  const writes =
    policy.profile === "workspace-write"
      ? policy.roots.map((root) => `(allow file-write* (subpath ${quote(root)}))`).join(" ")
      : ""
  const network = policy.network === "inherit" ? "(allow network*)" : ""
  return `(version 1) (deny default) (allow process*) (allow file-read* (subpath "/")) ${writes} ${network}`
}

function sandboxExecCommand(command: ChildProcess.StandardCommand, policy: Resolved, executable: string) {
  return ChildProcess.make(executable, ["-p", sandboxProfile(policy), "--", ...shellTarget(command)], {
    ...command.options,
    shell: undefined,
  })
}

function windowsNativeCommand(
  command: ChildProcess.StandardCommand,
  policy: Resolved,
  backend: Extract<Backend, { kind: "windows-native" }>,
  baseContainer = backend.baseContainer.status === "available",
) {
  const payload = Buffer.from(
    JSON.stringify({
      command: command.command,
      args: command.args,
      shell: command.options.shell,
      cwd: policy.cwd,
      profile: policy.profile,
      network: policy.network,
      workspace: policy.workspace,
      roots: policy.roots,
      readOnlyRoots: policy.readOnlyRoots,
      baseContainer,
    }),
  ).toString("base64url")
  return ChildProcess.make(backend.executable, [backend.helper, payload], {
    ...command.options,
    cwd: command.options.cwd,
    shell: undefined,
    detached: false,
  })
}

const WINDOWS_SANDBOX_HELPER_FLAG = "--arforge-windows-sandbox-helper"

const isSelfHostedArforgeExecutable = (executable: string) => /^arforge(?:\.exe)?$/iu.test(basename(executable))

export function prepareCommand(command: ChildProcess.StandardCommand, policy: Resolved, backend: Backend) {
  if (policy.profile === "unrestricted" || backend.kind === "none") return command
  if (backend.kind === "bubblewrap") return bwrapCommand(command, policy, backend.executable)
  if (backend.kind === "sandbox-exec") return sandboxExecCommand(command, policy, backend.executable)
  // Read-only uses the restricted low-integrity token. Workspace-write uses
  // SBOX when the host probe succeeds, otherwise the same launcher only for
  // Job Object/process-tree cleanup and per-run TEMP/TMP isolation.
  return windowsNativeCommand(command, policy, backend)
}

/**
 * MSYS/Git Bash creates named objects outside the BaseContainer contract.  A
 * full SBOX launch therefore fails inside bash before the user's command is
 * evaluated.  Keep the exception explicit and narrow: the legacy path still
 * has Job Object/process-tree cleanup, but it is reported as partial and can
 * never satisfy a caller that requires full enforcement.
 */
const isMsysShell = (shell: ChildProcess.StandardCommand["options"]["shell"]) =>
  typeof shell === "string" && /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/iu.test(shell)

const reportMsysLegacy = (policy: Resolved, backend: Extract<Backend, { kind: "windows-native" }>): Report => {
  const boundary = report(policy, backend)
  return {
    ...boundary,
    enforcement: "partial",
    capabilities: {
      processBoundary: "host",
      fileSystem: "host",
      network: policy.network === "inherit" ? "inherited" : "host",
      processTree: "job-kill-on-close",
    },
    reason:
      "Git Bash/MSYS is incompatible with the Windows BaseContainer named-object boundary; legacy token + Job Object cleanup is active, but filesystem and network containment are not enforced",
  }
}

function reportBoundary(policy: Resolved, backend: Backend): Report {
  if (policy.profile === "unrestricted") {
    return {
      backend: backend.kind,
      enforcement: "partial",
      profile: policy.profile,
      network: policy.network,
      roots: policy.roots,
      capabilities: {
        processBoundary: "host",
        fileSystem: "host",
        network: policy.network === "inherit" ? "inherited" : "host",
        processTree: "host",
      },
      reason: "unrestricted profile intentionally keeps host reachability; policy and gateway checks remain active",
    }
  }
  if (backend.kind === "windows-native") {
    const readOnly = policy.profile === "read-only"
    const baseContainer = !readOnly && backend.baseContainer.status === "available"
    if (baseContainer) {
      return {
        backend: backend.kind,
        enforcement: "full",
        profile: policy.profile,
        network: policy.network,
        roots: policy.roots,
        nativeBoundary: backend.baseContainer,
        capabilities: {
          processBoundary: "app-container",
          fileSystem: "app-container-paths",
          network: "app-container-policy",
          processTree: "job-kill-on-close",
        },
        reason:
          "Windows BaseContainer SBOX policy is available; approved workspace roots and default network policy are enforced by the OS",
      }
    }
    return {
      backend: backend.kind,
      enforcement: "partial",
      profile: policy.profile,
      network: policy.network,
      roots: policy.roots,
      nativeBoundary: backend.baseContainer,
      capabilities: {
        processBoundary: readOnly ? "low-integrity-token" : "host",
        fileSystem: readOnly ? "low-integrity-only" : "host",
        network: "host",
        processTree: "job-kill-on-close",
      },
      reason: readOnly
        ? `Restricted Token, low-integrity token and Job Object are active; path ACL and network containment are not yet active (${backend.baseContainer.reason})`
        : `Job Object and per-run workspace temp cleanup are active; workspace-write path ACL and network containment are not yet active (${backend.baseContainer.reason})`,
    }
  }
  if (backend.kind === "none") {
    return {
      backend: backend.kind,
      enforcement: "unavailable",
      profile: policy.profile,
      network: policy.network,
      roots: policy.roots,
      capabilities: {
        processBoundary: "none",
        fileSystem: "host",
        network: policy.network === "inherit" ? "inherited" : "host",
        processTree: "host",
      },
      reason: backend.reason,
    }
  }
  return {
    backend: backend.kind,
    enforcement: "full",
    profile: policy.profile,
    network: policy.network,
    roots: policy.roots,
    nativeBoundary: backend.capability,
    capabilities:
      backend.kind === "bubblewrap"
        ? {
            processBoundary: "pid-namespace",
            fileSystem: policy.profile === "read-only" ? "read-only-mounts" : "workspace-mounts",
            network: policy.network === "none" ? "unshared" : "inherited",
            processTree: "die-with-parent",
          }
        : {
            processBoundary: "seatbelt",
            fileSystem: "seatbelt-profile",
            network: policy.network === "none" ? "seatbelt" : "inherited",
            processTree: "seatbelt",
          },
    reason:
      backend.kind === "bubblewrap"
        ? "bubblewrap mounts and namespace isolation are active"
        : "macOS seatbelt profile is active",
  }
}

function report(policy: Resolved, backend: Backend): Report {
  const boundary = reportBoundary(policy, backend)
  return policy.readOnlyRoots === undefined ? boundary : { ...boundary, readOnlyRoots: policy.readOnlyRoots }
}

/**
 * Resolve the current host capability report without creating an execution
 * handle.  This is intentionally separate from `prepare`: status callers can
 * inspect policy and enforcement evidence while preserving the one report
 * builder used by actual sandbox execution.
 */
export function statusReport(input: StatusInput, backend: Backend = detectBackend()): Report {
  return report(SandboxPolicy.resolve(input), backend)
}

function makeInterface(): Interface {
  const backend = detectBackend()
  return {
    backend: () => backend,
    prepare: (input) =>
      Effect.gen(function* () {
        const policy = SandboxPolicy.resolve(input)
        const msysLegacy =
          backend.kind === "windows-native" &&
          backend.baseContainer.status === "available" &&
          isMsysShell(input.command.options.shell)
        const current = msysLegacy ? reportMsysLegacy(policy, backend) : report(policy, backend)
        if (policy.readOnlyRoots?.length && current.enforcement !== "full")
          return yield* new UnavailableError({
            message:
              "Explicit read-only dependency directories require a filesystem boundary; the selected sandbox cannot enforce it.",
            profile: policy.profile,
          })
        if (policy.profile === "read-only" && backend.kind === "none")
          return yield* new UnavailableError({ message: current.reason, profile: policy.profile })
        if (input.requireEnforcement && current.enforcement !== "full")
          return yield* new UnavailableError({ message: current.reason, profile: policy.profile })
        const command =
          msysLegacy && policy.profile !== "unrestricted"
            ? windowsNativeCommand(input.command, policy, backend, false)
            : prepareCommand(input.command, policy, backend)
        return { command, report: current }
      }),
  }
}

const layer = Layer.effect(Service, Effect.sync(makeInterface))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export * as SandboxRunner from "./runner"
