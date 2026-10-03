import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

export type UnixSandboxApi = "bubblewrap" | "seatbelt"
export type UnixNativeCapabilityStatus = "available" | "unavailable" | "not-probed"
export type UnixLiveProbe = "passed" | "failed" | "not-run"

/**
 * Landlock is intentionally reported as kernel support evidence, not as an
 * enforcement claim.  The current runner does not install Landlock rules;
 * bwrap/Seatbelt remain the only backends that can report full enforcement.
 */
export type LandlockCapability = {
  readonly status: UnixNativeCapabilityStatus
  readonly enforcement: "not-integrated"
  readonly evidence: "securityfs-present" | "securityfs-missing" | "not-probed"
  readonly reason: string
}

export type UnixNativeCapability = {
  readonly api: UnixSandboxApi
  readonly status: UnixNativeCapabilityStatus
  readonly executable: string
  readonly liveProbe: UnixLiveProbe
  readonly version?: string
  readonly landlock?: LandlockCapability
  readonly reason: string
}

type ProcessResult = {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly output: string
  readonly error?: Error
}

const LIVE_PROBE_TIMEOUT_MS = 2_500

function run(executable: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): ProcessResult {
  try {
    const result = spawnSync(executable, [...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LIVE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return {
      status: result.status,
      signal: result.signal,
      output: `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim(),
      ...(result.error ? { error: result.error } : {}),
    }
  } catch (error) {
    return {
      status: null,
      signal: null,
      output: "",
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

function formatFailure(result: ProcessResult) {
  if (result.error) return result.error.message
  if (result.signal) return `terminated by ${result.signal}`
  if (result.output) return result.output.replace(/\s+/gu, " ").slice(0, 240)
  return `exit code ${String(result.status)}`
}

function landlockCapability(platform: NodeJS.Platform): LandlockCapability {
  if (platform !== "linux" || process.platform !== "linux") {
    return {
      status: "not-probed",
      enforcement: "not-integrated",
      evidence: "not-probed",
      reason: "Landlock support is only probed on the live Linux host",
    }
  }
  if (existsSync("/sys/kernel/security/landlock")) {
    return {
      status: "available",
      enforcement: "not-integrated",
      evidence: "securityfs-present",
      reason: "Landlock securityfs is mounted, but Arforge does not install Landlock rules yet",
    }
  }
  return {
    status: "unavailable",
    enforcement: "not-integrated",
    evidence: "securityfs-missing",
    reason: "Landlock securityfs is not mounted; no Landlock enforcement evidence is available",
  }
}

function notProbed(api: UnixSandboxApi, executable: string, platform: NodeJS.Platform): UnixNativeCapability {
  return {
    api,
    status: "not-probed",
    executable,
    liveProbe: "not-run",
    ...(api === "bubblewrap" ? { landlock: landlockCapability(platform) } : {}),
    reason: `live ${api} probe skipped because the requested platform (${platform}) is not the current host (${process.platform})`,
  }
}

/**
 * Probe the actual execution boundary, not just whether an executable exists.
 * A path found on PATH is insufficient: user namespaces, network namespaces,
 * and Seatbelt policy loading can all be disabled independently by the host.
 */
export function probeUnixNativeCapability(
  api: UnixSandboxApi,
  executable: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): UnixNativeCapability {
  if (platform !== process.platform) return notProbed(api, executable, platform)

  // bubblewrap has a stable --version flag. Seatbelt's sandbox-exec does
  // not expose a portable version flag, so its policy-load probe is the
  // authoritative check and version remains intentionally omitted.
  const versionResult = api === "bubblewrap" ? run(executable, ["--version"], env) : undefined
  if (versionResult && (versionResult.error || versionResult.status !== 0)) {
    return {
      api,
      status: "unavailable",
      executable,
      liveProbe: "failed",
      ...(api === "bubblewrap" ? { landlock: landlockCapability(platform) } : {}),
      reason: `${api} was found but --version failed: ${formatFailure(versionResult)}`,
    }
  }

  const version = versionResult?.output
    .split(/\r?\n/gu)
    .find((line) => line.trim().length > 0)
    ?.trim()
  const probeArgs =
    api === "bubblewrap"
      ? [
          "--die-with-parent",
          "--new-session",
          "--unshare-pid",
          "--unshare-net",
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
          "/",
          "--",
          "/bin/true",
        ]
      : ["-p", '(version 1) (deny default) (allow process*) (allow file-read* (subpath "/"))', "--", "/usr/bin/true"]
  const liveResult = run(executable, probeArgs, env)
  const landlock = api === "bubblewrap" ? landlockCapability(platform) : undefined
  if (liveResult.error || liveResult.status !== 0) {
    return {
      api,
      status: "unavailable",
      executable,
      liveProbe: "failed",
      ...(version ? { version } : {}),
      ...(landlock ? { landlock } : {}),
      reason: `${api} was found but its live isolation probe failed: ${formatFailure(liveResult)}`,
    }
  }

  return {
    api,
    status: "available",
    executable,
    liveProbe: "passed",
    ...(version ? { version } : {}),
    ...(landlock ? { landlock } : {}),
    reason:
      api === "bubblewrap"
        ? "bubblewrap version and PID/network namespace probe passed; Landlock remains informational"
        : "sandbox-exec version and Seatbelt policy-load probe passed",
  }
}

export * as UnixNativeCapability from "./unix-native-capability"
