/*
 * Windows native sandbox capability probe.
 *
 * This module intentionally probes the operating-system capability without
 * launching a child process.  The presence of processmodel.dll is not enough:
 * Windows can ship the export while the experimental BaseContainer feature is
 * disabled, in which case the API returns ERROR_CALL_NOT_IMPLEMENTED.  Keeping
 * that distinction in the report prevents the runner from presenting a
 * Restricted Token/Job Object wrapper as a complete filesystem or network
 * boundary.
 */
import { createRequire } from "node:module"

type BunFfi = {
  readonly dlopen: (path: string, definitions: Record<string, unknown>) => { readonly symbols: Record<string, any> }
  readonly ptr: (value: unknown) => unknown
}

const require = createRequire(import.meta.url)
const bunFfi = (): BunFfi | undefined => {
  if (!(process.versions as NodeJS.ProcessVersions & { bun?: string }).bun) return undefined
  try {
    return require("bun:ffi") as BunFfi
  } catch {
    return undefined
  }
}

const ffi = (): BunFfi =>
  bunFfi() ??
  (() => {
    throw new Error("Windows processmodel probe requires Bun FFI")
  })()
const ptr = (value: unknown) => ffi().ptr(value)

const ERROR_CALL_NOT_IMPLEMENTED = 120
const ERROR_NOT_SUPPORTED = 50
const SANDBOX_DLL = "processmodel.dll"

export type WindowsNativeCapabilityStatus = "available" | "disabled" | "unavailable" | "not-probed"

export type WindowsNativeCapability = {
  readonly api: "processmodel"
  readonly status: WindowsNativeCapabilityStatus
  /** Export was resolved, even when the feature is disabled by the host. */
  readonly exportPresent: boolean
  /** Optional OS-reported capability bitmask (when the newer query export exists). */
  readonly supportMask?: number
  /** Win32 error captured immediately after the non-launching probe. */
  readonly win32Error?: number
  readonly reason: string
}

type ProcessmodelSymbols = {
  readonly Experimental_CreateProcessInSandbox: (...args: ReadonlyArray<unknown>) => number
}

const notProbed = (reason: string): WindowsNativeCapability => ({
  api: "processmodel",
  status: "not-probed",
  exportPresent: false,
  reason,
})

const dllPath = () => {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  return root ? `${root.replace(/[\\/]+$/u, "")}\\System32\\${SANDBOX_DLL}` : SANDBOX_DLL
}

const loadProcessmodel = (): ProcessmodelSymbols => {
  const { dlopen } = ffi()
  // An absolute System32 path keeps capability detection from resolving a
  // same-named DLL from the working directory.  The fallback is useful on
  // minimal test hosts that do not expose SystemRoot to the process.
  try {
    return dlopen(dllPath(), {
      Experimental_CreateProcessInSandbox: {
        args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"],
        returns: "i32",
      },
    }).symbols as unknown as ProcessmodelSymbols
  } catch (error) {
    if (dllPath() === SANDBOX_DLL) throw error
    return dlopen(SANDBOX_DLL, {
      Experimental_CreateProcessInSandbox: {
        args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"],
        returns: "i32",
      },
    }).symbols as unknown as ProcessmodelSymbols
  }
}

const loadQuery = () => {
  const module = bunFfi()
  if (!module) return undefined
  try {
    return module.dlopen(dllPath(), {
      Experimental_QuerySandboxSupport: { args: ["ptr"], returns: "i32" },
    }).symbols.Experimental_QuerySandboxSupport as unknown as (capabilities: unknown) => number
  } catch {
    try {
      return module.dlopen(SANDBOX_DLL, {
        Experimental_QuerySandboxSupport: { args: ["ptr"], returns: "i32" },
      }).symbols.Experimental_QuerySandboxSupport as unknown as (capabilities: unknown) => number
    } catch {
      return undefined
    }
  }
}

const loadLastError = () => {
  const module = bunFfi()
  if (!module) return undefined
  try {
    return module.dlopen("kernel32.dll", { GetLastError: { args: [], returns: "u32" } }).symbols.GetLastError
  } catch {
    return undefined
  }
}

/**
 * Probe the BaseContainer API on the current Windows host.
 *
 * `platform` is injectable so policy tests can exercise the non-Windows
 * branch without loading Windows DLLs.  The probe is deliberately opt-out
 * through an environment variable for diagnostics; disabling it never turns
 * into an enforcement claim.
 */
export const probeWindowsNativeCapability = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): WindowsNativeCapability => {
  if (platform !== "win32") return notProbed("Windows processmodel probe skipped on a non-Windows host")
  if (process.platform !== "win32")
    return notProbed("Windows processmodel probe skipped because the current host is not Windows")
  if (env.ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER === "1") {
    return {
      api: "processmodel",
      status: "disabled",
      exportPresent: false,
      reason: "BaseContainer probe disabled by ARFORGE_SANDBOX_DISABLE_BASE_CONTAINER",
    }
  }

  let symbols: ProcessmodelSymbols
  try {
    symbols = loadProcessmodel()
  } catch (error) {
    return {
      api: "processmodel",
      status: "unavailable",
      exportPresent: false,
      reason: `processmodel.dll or Experimental_CreateProcessInSandbox is unavailable: ${String(error)}`,
    }
  }

  const supportMaskBuffer = new BigUint64Array(1)
  let supportMask: number | undefined
  const query = loadQuery()
  if (query) {
    try {
      if (query(ptr(supportMaskBuffer)) !== 0) supportMask = Number(supportMaskBuffer[0])
    } catch {
      // The query export is optional and must not turn an otherwise usable
      // create API into a false negative.
    }
  }

  // All pointer arguments are null and the output buffer is private.  A
  // successful result would be unexpected; no command line or process is
  // supplied, so this call cannot intentionally launch a child.
  const processInformation = new Uint8Array(24)
  // Resolve this before invoking the processmodel export.  Loading another DLL
  // after the call is allowed to overwrite the thread-local last-error slot.
  const getLastError = loadLastError()
  let result = 0
  try {
    result = symbols.Experimental_CreateProcessInSandbox(
      null,
      null,
      null,
      null,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      0,
      ptr(processInformation),
    )
  } catch (error) {
    return {
      api: "processmodel",
      status: "unavailable",
      exportPresent: true,
      ...(supportMask === undefined ? {} : { supportMask }),
      reason: `Experimental_CreateProcessInSandbox probe failed before Win32 status was returned: ${String(error)}`,
    }
  }

  const win32Error = typeof getLastError === "function" ? Number(getLastError()) : undefined
  if (result !== 0) {
    return {
      api: "processmodel",
      status: "available",
      exportPresent: true,
      ...(supportMask === undefined ? {} : { supportMask }),
      ...(win32Error === undefined ? {} : { win32Error }),
      reason: "processmodel.dll exported the BaseContainer API and accepted the non-launching probe",
    }
  }

  if (win32Error === ERROR_CALL_NOT_IMPLEMENTED || win32Error === ERROR_NOT_SUPPORTED) {
    return {
      api: "processmodel",
      status: "disabled",
      exportPresent: true,
      ...(supportMask === undefined ? {} : { supportMask }),
      ...(win32Error === undefined ? {} : { win32Error }),
      reason:
        "processmodel.dll exports Experimental_CreateProcessInSandbox, but the host has not enabled the BaseContainer feature",
    }
  }

  // Invalid-parameter style errors indicate that the export executed far
  // enough for the feature gate to be active.  The real launch still remains
  // a separate, fail-closed path.
  return {
    api: "processmodel",
    status: "available",
    exportPresent: true,
    ...(supportMask === undefined ? {} : { supportMask }),
    ...(win32Error === undefined ? {} : { win32Error }),
    reason: `BaseContainer API is present; the non-launching probe returned Win32 error ${win32Error ?? "unknown"}`,
  }
}

export * as WindowsNativeCapability from "./windows-native-capability"
