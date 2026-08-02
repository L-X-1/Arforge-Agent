import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  isBridgeEnvelope,
  isManagementMethod,
  isReadOnlyMethod,
  MAX_BRIDGE_LINE_BYTES,
  type BridgeEvent,
  type BridgeFailure,
  type BridgeRequest,
  type BridgeSuccess,
  type ReadOnlyMethod,
  type ManagementMethod,
} from "./protocol"

const DEFAULT_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 2_000
const MAX_STDERR_CHARS = 8_000

export function defaultPythonHome(userHome: string = homedir()) {
  return join(userHome, ".arforge")
}

export interface PythonBridgeOptions {
  /** Product runtime containing the Python package and development virtualenv. */
  readonly runtimeRoot?: string
  /** Workspace whose files and data scope the capability request. */
  readonly workspace: string
  readonly pythonExecutable?: string
  readonly home?: string
  readonly requestTimeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly onEvent?: (event: BridgeEvent) => void
}

export interface CallOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export class PythonBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "PythonBridgeError"
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

export class PythonBridgeClient {
  readonly #options: PythonBridgeOptions
  readonly #pending = new Map<string, Pending>()
  #child?: ChildProcessWithoutNullStreams
  #starting?: Promise<void>
  #closing?: Promise<void>
  #stdout = ""
  #stderr = ""
  #sequence = 0
  #requestQueue: Promise<void> = Promise.resolve()
  #closed = false

  constructor(options: PythonBridgeOptions) {
    this.#options = options
  }

  get running() {
    return Boolean(this.#child && this.#child.exitCode === null && !this.#child.killed)
  }

  async start() {
    if (this.running) return
    if (this.#starting) return this.#starting
    this.#starting = this.#start()
    try {
      await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async call<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: CallOptions = {},
  ): Promise<T> {
    if (!isReadOnlyMethod(method)) {
      throw new PythonBridgeError("METHOD_NOT_ALLOWED", `Python capability method is not read-only: ${method}`)
    }
    return this.#request(method, params, options)
  }

  /**
   * Calls one explicitly allowlisted local management operation.
   *
   * This stays separate from `call` so read-only consumers cannot
   * accidentally acquire profile or workspace mutation authority.
   */
  async mutate<T = unknown>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: CallOptions = {},
  ): Promise<T> {
    if (!isManagementMethod(method)) {
      throw new PythonBridgeError("METHOD_NOT_ALLOWED", `Python management method is not allowlisted: ${method}`)
    }
    return this.#request(method, params, options)
  }

  async #request<T>(
    method: ReadOnlyMethod | ManagementMethod,
    params: Readonly<Record<string, unknown>>,
    options: CallOptions,
  ): Promise<T> {
    if (this.#closed) throw new PythonBridgeError("BRIDGE_CLOSED", "Python capability bridge is closed")
    let release!: () => void
    const previous = this.#requestQueue
    this.#requestQueue = new Promise<void>((resolvePromise) => {
      release = resolvePromise
    })
    await previous
    try {
      if (this.#closed) throw new PythonBridgeError("BRIDGE_CLOSED", "Python capability bridge is closed")
      return await this.#requestNow<T>(method, params, options)
    } finally {
      release()
    }
  }

  async #requestNow<T>(
    method: ReadOnlyMethod | ManagementMethod,
    params: Readonly<Record<string, unknown>>,
    options: CallOptions,
  ): Promise<T> {
    await this.start()
    const child = this.#child
    if (!child || !this.running) throw new PythonBridgeError("BRIDGE_NOT_RUNNING", "Python capability bridge is not running")

    const id = `agent-python-${++this.#sequence}`
    const timeoutMs = boundedTimeout(options.timeoutMs ?? this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    const request: BridgeRequest = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      id,
      method,
      params,
    }
    const line = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(line, "utf8") > MAX_BRIDGE_LINE_BYTES) {
      throw new PythonBridgeError("REQUEST_TOO_LARGE", "Python capability request exceeds the Bridge line limit")
    }
    if (options.signal?.aborted) throw abortError()

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = options.signal
        ? () => {
            this.#settle(id, abortError())
          }
        : undefined
      const timer = setTimeout(() => {
        // The Bridge is a serial JSONL worker. A timed-out request keeps
        // occupying that worker even after its Promise is rejected, so every
        // later request would otherwise queue behind an operation whose
        // completion is no longer bounded. Recycle the worker and fail all
        // concurrent callers explicitly; the next request starts a clean
        // process.
        this.#fatal(
          new PythonBridgeError("REQUEST_TIMEOUT", `Python capability request timed out after ${timeoutMs}ms`),
        )
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timer,
        signal: options.signal,
        onAbort,
      })
      if (onAbort) options.signal?.addEventListener("abort", onAbort, { once: true })
      child.stdin.write(line, "utf8", (error) => {
        if (error) this.#settle(id, new PythonBridgeError("BRIDGE_WRITE_FAILED", "Failed to write to Python bridge", error))
      })
    })
  }

  async close() {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#closing = this.#close()
    try {
      await this.#closing
    } finally {
      this.#closing = undefined
    }
  }

  async #start() {
    const workspace = await canonicalDirectory(this.#options.workspace)
    const runtimeRoot = this.#options.runtimeRoot
      ? await canonicalDirectory(this.#options.runtimeRoot)
      : workspace
    const python = await resolvePython(runtimeRoot, this.#options.pythonExecutable)
    const home = this.#options.home ? resolve(this.#options.home) : defaultPythonHome()
    const child = spawn(python, ["-m", "arforge.bridge"], {
      cwd: workspace,
      env: {
        ...process.env,
        ...this.#options.env,
        ARFORGE_BRIDGE_MODE: "capability",
        ARFORGE_WORKSPACE: workspace,
        ARFORGE_HOME: home,
        PYTHONUTF8: "1",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.#child = child
    this.#stdout = ""
    this.#stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.#consumeStdout(chunk))
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = redact(`${this.#stderr}${chunk}`).slice(-MAX_STDERR_CHARS)
    })
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#failAll(
        new PythonBridgeError(
          "BRIDGE_EXITED",
          `Python capability bridge exited (code=${code ?? "null"}, signal=${signal ?? "none"})${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`,
        ),
      )
    })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise)
      child.once("error", (error) => {
        if (this.#child === child) this.#child = undefined
        rejectPromise(new PythonBridgeError("BRIDGE_START_FAILED", "Failed to start Python capability bridge", error))
      })
    })
  }

  #consumeStdout(chunk: string) {
    this.#stdout += chunk
    if (Buffer.byteLength(this.#stdout, "utf8") > MAX_BRIDGE_LINE_BYTES && !this.#stdout.includes("\n")) {
      this.#fatal(new PythonBridgeError("RESPONSE_TOO_LARGE", "Python bridge emitted an oversized response line"))
      return
    }
    while (true) {
      const index = this.#stdout.indexOf("\n")
      if (index === -1) return
      const line = this.#stdout.slice(0, index).trim()
      this.#stdout = this.#stdout.slice(index + 1)
      if (!line) continue
      if (Buffer.byteLength(line, "utf8") > MAX_BRIDGE_LINE_BYTES) {
        this.#fatal(new PythonBridgeError("RESPONSE_TOO_LARGE", "Python bridge emitted an oversized response line"))
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        this.#fatal(new PythonBridgeError("INVALID_RESPONSE", "Python bridge emitted invalid JSON", error))
        return
      }
      if (!isBridgeEnvelope(parsed)) {
        this.#fatal(new PythonBridgeError("INVALID_RESPONSE", "Python bridge emitted an invalid protocol envelope"))
        return
      }
      if (isEvent(parsed)) {
        this.#options.onEvent?.(parsed)
        continue
      }
      this.#handleResponse(parsed)
    }
  }

  #handleResponse(response: BridgeSuccess | BridgeFailure) {
    const pending = this.#pending.get(response.id)
    if (!pending) return
    if (response.ok) {
      this.#settle(response.id, undefined, response.data)
      return
    }
    this.#settle(response.id, new PythonBridgeError(response.error.code, response.error.message))
  }

  #settle(id: string, error?: Error, value?: unknown) {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  #fatal(error: Error) {
    this.#failAll(error)
    this.#child?.kill()
  }

  #failAll(error: Error) {
    for (const id of this.#pending.keys()) this.#settle(id, error)
  }

  async #close() {
    const child = this.#child
    if (!child) return
    this.#failAll(new PythonBridgeError("BRIDGE_CLOSED", "Python capability bridge closed"))
    const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()))
    child.stdin.end()
    await Promise.race([
      exited,
      new Promise<void>((resolvePromise) =>
        setTimeout(() => {
          if (child.exitCode === null) child.kill()
          resolvePromise()
        }, CLOSE_TIMEOUT_MS),
      ),
    ])
    if (this.#child === child && child.exitCode !== null) this.#child = undefined
  }
}

async function canonicalDirectory(input: string) {
  if (!input.trim()) throw new PythonBridgeError("INVALID_WORKSPACE", "Python capability workspace is required")
  const path = await realpath(resolve(input))
  const info = await stat(path)
  if (!info.isDirectory()) throw new PythonBridgeError("INVALID_WORKSPACE", "Python capability workspace must be a directory")
  return path
}

async function resolvePython(workspace: string, configured?: string) {
  const candidate = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(workspace, configured)
    : join(workspace, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
  try {
    await access(candidate)
    return await realpath(candidate)
  } catch (error) {
    throw new PythonBridgeError("PYTHON_NOT_FOUND", `Python capability runtime not found: ${candidate}`, error)
  }
}

function boundedTimeout(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.max(100, Math.min(300_000, Math.trunc(value)))
}

function abortError() {
  return new PythonBridgeError("REQUEST_ABORTED", "Python capability request was aborted")
}

function redact(value: string) {
  return value
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\b(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED_SECRET]")
}

function isEvent(
  value: BridgeEvent | BridgeFailure | BridgeSuccess,
): value is BridgeEvent {
  return "event" in value && value.event
}
