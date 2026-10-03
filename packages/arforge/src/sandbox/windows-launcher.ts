/*
 * Windows sandbox launcher.
 *
 * This file is executed by Bun only when SandboxRunner detects the native
 * Windows backend. It deliberately keeps the native boundary small: the
 * child receives a restricted, low-integrity primary token and is placed in a
 * Job Object with KILL_ON_JOB_CLOSE. The parent process still owns the
 * command's stdio, so the existing Effect ChildProcess pipeline remains the
 * single stream/timeout/cancellation owner.
 *
 * Read-only uses the restricted low-integrity token. Workspace-write uses the
 * caller's user token only when the host-gated BaseContainer API is absent;
 * when the runner has explicitly selected SBOX, the same stdio/Job Object /
 * TEMP cleanup invariants are retained while Windows applies the approved
 * roots and network policy. Unsupported hosts stay on the truthful partial
 * path and never receive a fake full-enforcement report.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { buildWindowsSandboxSpec } from "./windows-sandbox-spec"
import { probeWindowsNativeCapability } from "./windows-native-capability"

/** Internal self-hosted entry used by compiled Arforge binaries. */
export const WINDOWS_SANDBOX_HELPER_FLAG = "--arforge-windows-sandbox-helper"
/** Detached cleanup entry used when the launcher is interrupted. */
export const WINDOWS_SANDBOX_CLEANUP_FLAG = "--arforge-windows-sandbox-cleanup"

type BunFfi = {
  readonly dlopen: (path: string, definitions: Record<string, unknown>) => { readonly symbols: Record<string, any> }
  readonly ptr: (value: unknown) => unknown
}

const require = createRequire(import.meta.url)
const ffi = (): BunFfi => {
  if (!(process.versions as NodeJS.ProcessVersions & { bun?: string }).bun)
    throw new Error("Windows sandbox native launcher requires Bun FFI")
  try {
    return require("bun:ffi") as BunFfi
  } catch (error) {
    throw new Error(`Windows sandbox native launcher could not load Bun FFI: ${String(error)}`)
  }
}

type NativePointer = unknown
const pointer = (value: number) => value as unknown as NativePointer
const ptr = (value: unknown) => ffi().ptr(value)

const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const TOKEN_ADJUST_DEFAULT = 0x0080
const TOKEN_ADJUST_SESSIONID = 0x0100
const TOKEN_RIGHTS =
  TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID
const DISABLE_MAX_PRIVILEGE = 0x1
const TOKEN_INTEGRITY_LEVEL = 25
const SECURITY_MANDATORY_LOW_RID = "S-1-16-4096"
const TOKEN_MANDATORY_LABEL_NO_WRITE_UP = 0x1
const STARTF_USESTDHANDLES = 0x100
const CREATE_SUSPENDED = 0x4
const CREATE_UNICODE_ENVIRONMENT = 0x400
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const INFINITE = 0xffffffff
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12

// Resolve once, before native operations. Reopening kernel32 while reading
// GetLastError can overwrite the thread-local error from the failed call.
let kernel32Symbols: ReturnType<BunFfi["dlopen"]>["symbols"] | undefined
const kernel32 = {
  get symbols() {
    return (kernel32Symbols ??= ffi().dlopen("kernel32.dll", {
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
      CloseHandle: { args: ["ptr"], returns: "bool" },
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      GetCurrentProcess: { args: [], returns: "ptr" },
      GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "bool" },
      GetLastError: { args: [], returns: "u32" },
      GetStdHandle: { args: ["i32"], returns: "ptr" },
      LocalFree: { args: ["ptr"], returns: "ptr" },
      ResumeThread: { args: ["ptr"], returns: "u32" },
      SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "bool" },
      SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "bool" },
      TerminateJobObject: { args: ["ptr", "u32"], returns: "bool" },
      TerminateProcess: { args: ["ptr", "u32"], returns: "bool" },
      WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    }).symbols)
  },
}

const advapi32 = {
  get symbols() {
    return ffi().dlopen("advapi32.dll", {
      ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "bool" },
      CreateProcessWithTokenW: {
        args: ["ptr", "u32", "ptr", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"],
        returns: "bool",
      },
      CreateProcessAsUserW: {
        args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"],
        returns: "bool",
      },
      CreateRestrictedToken: {
        args: ["ptr", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"],
        returns: "bool",
      },
      OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "bool" },
      SetTokenInformation: { args: ["ptr", "i32", "ptr", "u32"], returns: "bool" },
    }).symbols
  },
}

const loadProcessmodel = () => {
  const root = process.env.SystemRoot ?? process.env.WINDIR
  const path = root ? `${root.replace(/[\\/]+$/u, "")}\\System32\\processmodel.dll` : "processmodel.dll"
  return ffi().dlopen(path, {
    Experimental_CreateProcessInSandbox: {
      args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr", "u32", "ptr"],
      returns: "i32",
    },
  })
}

const loadUserenv = () =>
  ffi().dlopen("userenv.dll", {
    DeleteAppContainerProfile: { args: ["ptr"], returns: "i32" },
  })

type Input = {
  command: string
  args: string[]
  shell?: boolean | string
  cwd?: string
  profile?: "read-only" | "workspace-write" | "unrestricted"
  network?: "none" | "inherit"
  workspace?: string
  roots?: string[]
  readOnlyRoots?: string[]
  /** Parent runner selected the host-gated SBOX path after a successful probe. */
  baseContainer?: boolean
}

const lastError = (operation: string): Error =>
  new Error(`Windows sandbox ${operation} failed (Win32 error ${kernel32.symbols.GetLastError()})`)

const BASE_CONTAINER_PROFILE_PATTERN = /^ArforgeSandbox-[0-9]+-[0-9a-f-]+$/iu

/** Remove only identities generated by this launcher; never accept an arbitrary profile name. */
const deleteAppContainerProfile = (profileName: string) => {
  if (!BASE_CONTAINER_PROFILE_PATTERN.test(profileName))
    throw new Error("Windows sandbox cleanup rejected an untrusted AppContainer profile name")
  let userenv: ReturnType<typeof loadUserenv>
  try {
    userenv = loadUserenv()
  } catch (error) {
    throw new Error(`Windows sandbox could not load userenv.dll for AppContainer cleanup: ${String(error)}`)
  }
  const name = wide(profileName)
  const result = Number(userenv.symbols.DeleteAppContainerProfile(ptr(name)))
  // This API returns HRESULT, not BOOL/GetLastError. S_OK is zero, including
  // when a failed launch never created the profile. Preserve actual failures.
  if (result < 0) {
    throw new Error(`Windows sandbox DeleteAppContainerProfile failed (HRESULT 0x${(result >>> 0).toString(16)})`)
  }
}

const wide = (value: string) => {
  const result = new Uint16Array(value.length + 1)
  for (let index = 0; index < value.length; index++) result[index] = value.charCodeAt(index)
  return result
}

/** Build the UTF-16 environment block required by CreateProcess*. */
const environmentBlock = (tempDirectory: string | undefined) => {
  const source = process.env
  if (!tempDirectory) return
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) values.set(key, value)
  }
  if (tempDirectory) {
    values.set("TEMP", tempDirectory)
    values.set("TMP", tempDirectory)
  }
  const block = Array.from(values, ([key, value]) => `${key}=${value}`)
    .sort((a, b) => a.localeCompare(b))
    .join("\0")
  // Environment blocks are terminated by two NUL code units.
  return new Uint16Array([...block.split("").map((char) => char.charCodeAt(0)), 0, 0])
}

const canonicalWindowsPath = (value: string) => {
  const resolved = win32.resolve(value)
  const root = win32.parse(resolved).root
  return (resolved.toLowerCase() === root.toLowerCase() ? root : resolved.replace(/[\\/]+$/u, "")).toLowerCase()
}

const normalizeWorkspaceInput = (input: Input): Input => {
  if (input.profile !== "workspace-write") return input
  const workspace = input.workspace
  if (!workspace || !input.cwd) throw new Error("Windows workspace-write requires workspace and cwd")
  const rawRoots = input.roots ?? [workspace]
  const rawReadOnlyRoots = input.readOnlyRoots ?? []
  if ([workspace, input.cwd, ...rawRoots, ...rawReadOnlyRoots].some((value) => value.includes("\0")))
    throw new Error("Windows workspace-write path contains a NUL")
  if ([workspace, input.cwd, ...rawRoots, ...rawReadOnlyRoots].some((value) => !win32.isAbsolute(value)))
    throw new Error("Windows workspace-write paths must be absolute")

  const normalizedWorkspace = canonicalWindowsPath(workspace)
  const normalizedCwd = canonicalWindowsPath(input.cwd)
  const normalizedRoots = rawRoots.map(canonicalWindowsPath)
  const inside = (root: string, target: string) => {
    const relative = win32.relative(root, target)
    return relative.length === 0 || (!relative.startsWith("..") && !win32.isAbsolute(relative))
  }
  if (!normalizedRoots.some((root) => inside(root, normalizedCwd)))
    throw new Error("Windows workspace-write cwd is outside the approved roots")

  return {
    ...input,
    cwd: normalizedCwd,
    workspace: normalizedWorkspace,
    roots: normalizedRoots,
    ...(input.readOnlyRoots === undefined ? {} : { readOnlyRoots: rawReadOnlyRoots.map(canonicalWindowsPath) }),
  }
}

const workspaceTemp = (input: Input, profileName?: string) => {
  if (input.profile !== "workspace-write") return
  const workspace = input.workspace
  if (!workspace) throw new Error("Windows workspace-write requires workspace")
  const parent = workspace
  // Keep the temp directory under the approved workspace so tools cannot use
  // this seam as an additional host location. The parent is not recursively
  // changed; only this per-run directory is removed in the finally block.
  const directory = mkdtempSync(join(parent, ".arforge-sandbox-temp-"))
  spawnWorkspaceCleanupWorker(directory, profileName)
  return directory
}

const cleanupWorkspaceTemp = (directory: string | undefined) => {
  if (!directory) return
  let lastError: unknown
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  // PowerShell and policy helpers can release inherited TEMP handles just
  // after their top-level process exits. Retry only this exact per-run path so
  // normal completion does not leave an ACL/temp residue behind.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      Atomics.wait(waitBuffer, 0, 0, 50)
    }
  }
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch {
    throw new Error(`Windows sandbox temp cleanup failed for ${dirname(directory)}: ${String(lastError)}`)
  }
}

type CleanupInput = { readonly directory: string; readonly parentPid: number; readonly profileName?: string }

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Keep a cleanup worker outside the target Job Object. It is intentionally
 * tiny and bounded: if a launcher is killed, the worker waits for that exact
 * PID to disappear and then removes only the encoded per-run directory.
 */
const spawnWorkspaceCleanupWorker = (directory: string, profileName?: string) => {
  const payload = Buffer.from(
    JSON.stringify({
      directory,
      parentPid: process.pid,
      ...(profileName ? { profileName } : {}),
    } satisfies CleanupInput),
  ).toString("base64url")
  const source = fileURLToPath(import.meta.url)
  const selfHosted = /^arforge(?:\.exe)?$/iu.test(basename(process.execPath))
  const args = selfHosted ? [WINDOWS_SANDBOX_CLEANUP_FLAG, payload] : [source, WINDOWS_SANDBOX_CLEANUP_FLAG, payload]
  // Core's Windows cancellation path uses `taskkill /T`, which follows the
  // parent-PID tree even when Node/Bun was spawned with `detached: true`.
  // Start the actual worker through `start` so the short-lived cmd bridge
  // exits before the helper can be killed; the worker then has no helper
  // descendant relationship for taskkill to traverse.
  const worker = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "start", "", "/b", process.execPath, ...args], {
    cwd: tmpdir(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  })
  worker.unref()
}

export const runWindowsSandboxCleanup = (encoded: string | undefined) => {
  if (!encoded) throw new Error("Windows sandbox cleanup requires an encoded payload")
  const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CleanupInput
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 600; attempt++) {
    if (!isProcessAlive(input.parentPid)) {
      let cleanupFailure: unknown
      try {
        cleanupWorkspaceTemp(input.directory)
      } catch (error) {
        cleanupFailure = error
      }
      try {
        if (input.profileName) deleteAppContainerProfile(input.profileName)
      } catch (error) {
        cleanupFailure ??= error
      }
      if (cleanupFailure) throw cleanupFailure
      return 0
    }
    Atomics.wait(waitBuffer, 0, 0, 100)
  }
  // A live parent after the bounded wait is not safe to delete around.
  return 1
}

const setPointer = (buffer: Uint8Array, offset: number, value: number) => {
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(offset, BigInt(value), true)
}

/** The 64-bit STARTUPINFOW layout is shared by both native launch paths. */
const startupInfo = () => {
  const startup = new Uint8Array(104)
  const view = new DataView(startup.buffer)
  view.setUint32(0, startup.byteLength, true)
  // dwFlags is at byte 60. Byte 68 is padding before lpReserved2; setting it
  // leaves STARTF_USESTDHANDLES clear and silently disconnects redirected I/O.
  view.setUint32(60, STARTF_USESTDHANDLES, true)
  const native = kernel32.symbols
  const handles = [
    Number(native.GetStdHandle(STD_INPUT_HANDLE)),
    Number(native.GetStdHandle(STD_OUTPUT_HANDLE)),
    Number(native.GetStdHandle(STD_ERROR_HANDLE)),
  ]
  for (const [index, handle] of handles.entries()) {
    if (handle && !native.SetHandleInformation(pointer(handle), 1, 1)) throw lastError("SetHandleInformation(stdio)")
    setPointer(startup, 80 + index * 8, handle)
  }
  return startup
}

/** Quote one argument for the Windows command line parser used by CreateProcessWithTokenW. */
const quoteArgument = (value: string) => {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value
  let result = '"'
  let slashes = 0
  for (const char of value) {
    if (char === "\\") {
      slashes++
      continue
    }
    if (char === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"'
      slashes = 0
      continue
    }
    result += "\\".repeat(slashes) + char
    slashes = 0
  }
  result += "\\".repeat(slashes * 2) + '"'
  return result
}

const target = (input: Input): { executable: string; args: string[]; rawCommand?: string } => {
  if (input.shell === undefined || input.shell === false) return { executable: input.command, args: input.args }
  if (input.args.length > 0) throw new Error("Windows sandbox cannot wrap a shell command with positional arguments")
  const shell = typeof input.shell === "string" ? input.shell : "cmd.exe"
  const name = shell.toLowerCase()
  if (name.includes("powershell") || name.endsWith("pwsh.exe"))
    return { executable: shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command] }
  if (/(^|[\\/])(bash|sh)(?:\.exe)?$/u.test(name)) return { executable: shell, args: ["-c", input.command] }
  // cmd.exe parses the text following /c itself. Passing it through the
  // C-runtime quote/escape rules would turn embedded quotes into backslashes
  // and can change a valid redirect into a "filename syntax" error.
  return { executable: shell, args: ["/d", "/s", "/c"], rawCommand: input.command }
}

const restrictedToken = () => {
  const source = new BigUint64Array(1)
  if (!advapi32.symbols.OpenProcessToken(kernel32.symbols.GetCurrentProcess(), TOKEN_RIGHTS, ptr(source)))
    throw lastError("OpenProcessToken")

  const restricted = new BigUint64Array(1)
  if (
    !advapi32.symbols.CreateRestrictedToken(Number(source[0]), DISABLE_MAX_PRIVILEGE, 0, 0, 0, 0, 0, 0, ptr(restricted))
  ) {
    kernel32.symbols.CloseHandle(pointer(Number(source[0])))
    throw lastError("CreateRestrictedToken")
  }
  kernel32.symbols.CloseHandle(pointer(Number(source[0])))

  // Low integrity denies write-up into ordinary medium-integrity user files.
  // This is the real read-only boundary used by the current Windows slice.
  const sidText = wide(SECURITY_MANDATORY_LOW_RID)
  const sid = new BigUint64Array(1)
  if (!advapi32.symbols.ConvertStringSidToSidW(ptr(sidText), ptr(sid))) {
    kernel32.symbols.CloseHandle(pointer(Number(restricted[0])))
    throw lastError("ConvertStringSidToSidW")
  }
  const label = new Uint8Array(16)
  setPointer(label, 0, Number(sid[0]))
  new DataView(label.buffer).setUint32(8, TOKEN_MANDATORY_LABEL_NO_WRITE_UP, true)
  const applied = advapi32.symbols.SetTokenInformation(
    pointer(Number(restricted[0])),
    TOKEN_INTEGRITY_LEVEL,
    ptr(label),
    label.byteLength,
  )
  kernel32.symbols.LocalFree(pointer(Number(sid[0])))
  if (!applied) {
    kernel32.symbols.CloseHandle(pointer(Number(restricted[0])))
    throw lastError("SetTokenInformation(TokenIntegrityLevel)")
  }
  return Number(restricted[0])
}

/** Obtain the current primary token for workspace-write process-tree wrapping. */
const currentToken = () => {
  const source = new BigUint64Array(1)
  if (!advapi32.symbols.OpenProcessToken(kernel32.symbols.GetCurrentProcess(), TOKEN_RIGHTS, ptr(source)))
    throw lastError("OpenProcessToken")
  return Number(source[0])
}

const baseContainerProfileName = () => `ArforgeSandbox-${process.pid}-${randomUUID()}`

/**
 * Launch a workspace-write command through the OS BaseContainer API.
 *
 * This path is selected only after the parent runner's non-launching capability
 * probe succeeds and the helper repeats the probe locally.  A failed SBOX call
 * is an execution failure; it never silently falls back to the unrestricted
 * current-user token after the parent has reported full enforcement.
 */
const launchBaseContainer = (input: Input) => {
  const child = target(input)
  const profileName = baseContainerProfileName()
  let tempDirectory: string | undefined
  let job = 0
  let process = 0
  let thread = 0
  let settled = false
  let exitCode = 1
  try {
    tempDirectory = workspaceTemp(input, profileName)
    const environment = environmentBlock(tempDirectory)
    job = Number(kernel32.symbols.CreateJobObjectW(null, null))
    if (!job) throw lastError("CreateJobObjectW")

    const limits = new Uint8Array(144)
    new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
    if (
      !kernel32.symbols.SetInformationJobObject(
        pointer(job),
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limits),
        limits.byteLength,
      )
    )
      throw lastError("SetInformationJobObject")

    const startup = startupInfo()

    const info = new Uint8Array(24)
    const commandLine = wide(
      [child.executable, ...child.args].map(quoteArgument).join(" ") +
        (child.rawCommand === undefined ? "" : ` ${child.rawCommand}`),
    )
    const cwd = input.cwd ? wide(input.cwd) : undefined
    const identity = wide(profileName)
    const roots = input.roots ?? (input.workspace ? [input.workspace] : [])
    const specification = buildWindowsSandboxSpec({
      roots,
      readOnlyRoots: input.readOnlyRoots,
      network: input.network ?? "inherit",
    })
    const processmodel = loadProcessmodel()
    const created = processmodel.symbols.Experimental_CreateProcessInSandbox(
      null,
      ptr(commandLine),
      null,
      null,
      // This experimental API forwards the explicit STARTUPINFO handles;
      // general inheritance is unsupported (ERROR_NOT_SUPPORTED on this host).
      0,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      environment ? ptr(environment) : null,
      cwd ? ptr(cwd) : null,
      ptr(startup),
      ptr(identity),
      ptr(specification),
      specification.byteLength,
      ptr(info),
    )
    if (!created) throw lastError("Experimental_CreateProcessInSandbox")

    const infoView = new DataView(info.buffer)
    process = Number(infoView.getBigUint64(0, true))
    thread = Number(infoView.getBigUint64(8, true))
    if (!process || !thread) throw new Error("Windows BaseContainer returned invalid process handles")
    if (!kernel32.symbols.AssignProcessToJobObject(pointer(job), pointer(process)))
      throw lastError("AssignProcessToJobObject(BaseContainer)")
    if (kernel32.symbols.ResumeThread(pointer(thread)) === 0xffffffff) throw lastError("ResumeThread(BaseContainer)")
    kernel32.symbols.CloseHandle(pointer(thread))
    thread = 0

    kernel32.symbols.WaitForSingleObject(pointer(process), INFINITE)
    const code = new Uint32Array(1)
    if (!kernel32.symbols.GetExitCodeProcess(pointer(process), ptr(code)))
      throw lastError("GetExitCodeProcess(BaseContainer)")
    settled = true
    exitCode = code[0] ?? 1
  } finally {
    if (!settled && process) kernel32.symbols.TerminateProcess(pointer(process), 1)
    if (job) {
      kernel32.symbols.TerminateJobObject(pointer(job), settled ? exitCode : 1)
      kernel32.symbols.WaitForSingleObject(pointer(job), 5000)
    }
    if (thread) kernel32.symbols.CloseHandle(pointer(thread))
    if (process) kernel32.symbols.CloseHandle(pointer(process))
    if (job) kernel32.symbols.CloseHandle(pointer(job))

    let cleanupFailure: unknown
    try {
      deleteAppContainerProfile(profileName)
    } catch (error) {
      cleanupFailure = error
    }
    try {
      cleanupWorkspaceTemp(tempDirectory)
    } catch (error) {
      cleanupFailure ??= error
    }
    if (cleanupFailure) throw cleanupFailure
  }
  return exitCode
}

const launchLegacy = (input: Input) => {
  const normalizedInput = normalizeWorkspaceInput(input)
  const child = target(normalizedInput)
  let tempDirectory: string | undefined
  let token = 0
  let job = 0
  let process = 0
  let thread = 0
  let settled = false
  let exitCode = 1
  try {
    tempDirectory = workspaceTemp(normalizedInput)
    const environment = environmentBlock(tempDirectory)
    token = normalizedInput.profile === "workspace-write" ? currentToken() : restrictedToken()
    job = Number(kernel32.symbols.CreateJobObjectW(null, null))
    if (!job) throw lastError("CreateJobObjectW")

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION has LimitFlags at byte offset 16.
    const limits = new Uint8Array(144)
    new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
    if (
      !kernel32.symbols.SetInformationJobObject(
        pointer(job),
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limits),
        limits.byteLength,
      )
    )
      throw lastError("SetInformationJobObject")

    const startup = startupInfo()

    const info = new Uint8Array(24)
    const executable = wide(child.executable)
    const commandLine = wide(
      [child.executable, ...child.args].map(quoteArgument).join(" ") +
        (child.rawCommand === undefined ? "" : ` ${child.rawCommand}`),
    )
    const cwd = normalizedInput.cwd ? wide(normalizedInput.cwd) : undefined
    const cwdPointer = cwd ? ptr(cwd) : null
    let created = advapi32.symbols.CreateProcessWithTokenW(
      pointer(token),
      0,
      null,
      ptr(commandLine),
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      environment ? ptr(environment) : null,
      cwdPointer,
      ptr(startup),
      ptr(info),
    )
    if (!created) {
      // Some hardened user sessions do not grant SeImpersonatePrivilege,
      // which CreateProcessWithTokenW requires. A restricted primary token
      // can still be launched through CreateProcessAsUserW when the host
      // grants the corresponding user-token privilege.
      created = advapi32.symbols.CreateProcessAsUserW(
        pointer(token),
        null,
        ptr(commandLine),
        null,
        null,
        1,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        environment ? ptr(environment) : null,
        cwdPointer,
        ptr(startup),
        ptr(info),
      )
    }
    if (!created) throw lastError("CreateProcessWithTokenW/CreateProcessAsUserW")

    const infoView = new DataView(info.buffer)
    process = Number(infoView.getBigUint64(0, true))
    thread = Number(infoView.getBigUint64(8, true))
    if (!process || !thread) throw new Error("Windows sandbox returned invalid process handles")
    if (!kernel32.symbols.AssignProcessToJobObject(pointer(job), pointer(process)))
      throw lastError("AssignProcessToJobObject")
    if (kernel32.symbols.ResumeThread(pointer(thread)) === 0xffffffff) throw lastError("ResumeThread")
    kernel32.symbols.CloseHandle(pointer(thread))
    thread = 0

    kernel32.symbols.WaitForSingleObject(pointer(process), INFINITE)
    const code = new Uint32Array(1)
    if (!kernel32.symbols.GetExitCodeProcess(pointer(process), ptr(code))) throw lastError("GetExitCodeProcess")
    settled = true
    exitCode = code[0] ?? 1
  } finally {
    if (!settled && process) kernel32.symbols.TerminateProcess(pointer(process), 1)
    if (job) {
      // A shell can leave policy/helper descendants alive after its top-level
      // process exits. Kill and wait for the whole job before removing TEMP;
      // otherwise Windows may still hold those files open during cleanup.
      kernel32.symbols.TerminateJobObject(pointer(job), settled ? exitCode : 1)
      kernel32.symbols.WaitForSingleObject(pointer(job), 5000)
    }
    if (thread) kernel32.symbols.CloseHandle(pointer(thread))
    if (process) kernel32.symbols.CloseHandle(pointer(process))
    if (job) kernel32.symbols.CloseHandle(pointer(job))
    if (token) kernel32.symbols.CloseHandle(pointer(token))
    cleanupWorkspaceTemp(tempDirectory)
  }
  return exitCode
}

const launch = (input: Input) => {
  const normalizedInput = normalizeWorkspaceInput(input)
  if (normalizedInput.readOnlyRoots?.length && !normalizedInput.baseContainer)
    throw new Error("Explicit read-only dependency directories require the BaseContainer filesystem boundary")
  if (normalizedInput.baseContainer) {
    const capability = probeWindowsNativeCapability()
    if (capability.status !== "available")
      throw new Error(`Windows BaseContainer was selected but is not available: ${capability.reason}`)
    return launchBaseContainer(normalizedInput)
  }
  return launchLegacy(normalizedInput)
}

export const runWindowsSandboxLauncher = (encoded: string | undefined) => {
  if (!encoded) throw new Error("Windows sandbox launcher requires an encoded command payload")
  const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Input
  return launch(input)
}

// Direct source execution remains supported for development and live tests.
// The compiled CLI calls these functions through private flags.
if (process.argv[1]?.toLowerCase().includes("windows-launcher")) {
  process.exitCode =
    process.argv[2] === WINDOWS_SANDBOX_CLEANUP_FLAG
      ? runWindowsSandboxCleanup(process.argv[3])
      : runWindowsSandboxLauncher(process.argv[2])
}
