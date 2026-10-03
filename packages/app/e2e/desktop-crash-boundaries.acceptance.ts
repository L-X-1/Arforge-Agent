import { spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loadProductEnv } from "@arforge-ai/core/config/product-env"

const root = resolve(import.meta.dir, "../../..")
const unpacked = join(root, "packages/desktop/dist/win-unpacked")
const appExeName = (await readdir(unpacked)).find((name) => name.toLowerCase().endsWith(".exe"))
if (!appExeName) throw new Error(`packaged desktop executable is missing from ${unpacked}`)
const appExe = join(unpacked, appExeName)
const artifacts = join(root, "artifacts")
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))
type AcceptanceBackend = "sqlite" | "postgresql"
const acceptanceBackend: AcceptanceBackend =
  process.env.ARFORGE_ACCEPTANCE_BACKEND?.trim().toLowerCase() === "postgresql" ? "postgresql" : "sqlite"
if (acceptanceBackend === "postgresql") {
  loadProductEnv({ override: false })
  if (!process.env.ARFORGE_DB_URL?.trim()) {
    throw new Error("ARFORGE_DB_URL is required for the PostgreSQL packaged acceptance")
  }
}
const acceptancePostgresURL = process.env.ARFORGE_DB_URL?.trim() ?? ""

const availablePort = () =>
  new Promise<number>((done, fail) => {
    const server = createNetServer()
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        fail(new Error("could not reserve a local port"))
        return
      }
      server.close((error) => (error ? fail(error) : done(address.port)))
    })
  })

class CdpClient {
  private sequence = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()

  private constructor(
    private readonly socket: WebSocket,
    private readonly onEvent: (message: Record<string, unknown>) => void,
  ) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id)
        if (!request) return
        this.pending.delete(message.id)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve((message.result as Record<string, unknown>) ?? {})
        return
      }
      this.onEvent(message)
    })
  }

  static async connect(url: string, onEvent: (message: Record<string, unknown>) => void) {
    const socket = new WebSocket(url)
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("CDP WebSocket open timed out")), 30_000)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        done()
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        fail(new Error("CDP WebSocket open failed"))
      })
    })
    return new CdpClient(socket, onEvent)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.sequence
    return new Promise<Record<string, unknown>>((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    this.socket.close()
  }
}

type Desktop = {
  process: ChildProcess
  cdp: CdpClient
  origin: string
  rendererErrors: string[]
  failedRequests: string[]
  stdout: () => string
  stderr: () => string
  evaluate: <T>(expression: string) => Promise<T>
}

async function launchDesktop(input: {
  workspace: string
  home: string
  profile: string
  databasePath?: string
  leaseTtlMs: number
  backend?: AcceptanceBackend
  testCrashBoundary?: "authorized-before-spawn" | "effect-before-observation"
  testMutationBoundary?: "before-settlement"
}): Promise<Desktop> {
  const backend = input.backend ?? acceptanceBackend
  const debugPort = await availablePort()
  let appStdout = ""
  let appStderr = ""
  const rendererErrors: string[] = []
  const failedRequests: string[] = []
  const appProcess = spawn(appExe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${input.profile}`], {
    cwd: input.workspace,
    env: {
      ...process.env,
      ARFORGE_HOME: input.home,
      XDG_DATA_HOME: join(input.home, "xdg-data"),
      XDG_CONFIG_HOME: join(input.home, "xdg-config"),
      XDG_STATE_HOME: join(input.home, "xdg-state"),
      XDG_CACHE_HOME: join(input.home, "xdg-cache"),
      ARFORGE_DATABASE_MODE: backend,
      ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
      ARFORGE_DURABLE_LEASE_TTL_MS: String(input.leaseTtlMs),
      ARFORGE_ACTION_LEASE_TTL_MS: String(input.leaseTtlMs),
      ARFORGE_DB: input.databasePath ?? "",
      ARFORGE_DB_URL: backend === "postgresql" ? acceptancePostgresURL : "",
      ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_MULTIAGENT_DB_URL: "",
      ARFORGE_TEST_CRASH_BOUNDARY: input.testCrashBoundary ?? "",
      ARFORGE_TEST_MUTATION_BOUNDARY: input.testMutationBoundary ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  appProcess.stdout?.on("data", (chunk) => (appStdout += String(chunk)))
  appProcess.stderr?.on("data", (chunk) => (appStderr += String(chunk)))

  const deadline = Date.now() + 120_000
  let endpoint = ""
  while (Date.now() < deadline) {
    try {
      const version = (await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) =>
        response.json(),
      )) as { webSocketDebuggerUrl?: string }
      if (version.webSocketDebuggerUrl) {
        endpoint = version.webSocketDebuggerUrl
        break
      }
    } catch {
      if (appProcess.exitCode !== null) break
      await sleep(250)
    }
  }
  if (!endpoint)
    throw new Error(
      `packaged desktop did not start (exit=${appProcess.exitCode})\nstdout:\n${appStdout}\nstderr:\n${appStderr}`,
    )

  const requests = new Map<string, string>()
  const observedApiOrigins = new Set<string>()
  let rendererSessionID = ""
  const cdp = await CdpClient.connect(endpoint, (message) => {
    const method = String(message.method ?? "")
    const params = (message.params as Record<string, unknown>) ?? {}
    if (/^(Runtime|Network)\./.test(method) && message.sessionId !== rendererSessionID) return
    if (method === "Runtime.exceptionThrown") rendererErrors.push(JSON.stringify(params.exceptionDetails ?? params))
    if (method === "Runtime.consoleAPICalled" && params.type === "error")
      rendererErrors.push(JSON.stringify(params.args ?? params))
    if (method === "Network.requestWillBeSent") {
      const request = params.request as Record<string, unknown> | undefined
      if (typeof params.requestId === "string" && typeof request?.url === "string") {
        requests.set(params.requestId, request.url)
        try {
          const url = new URL(request.url)
          if (url.pathname.startsWith("/api/")) observedApiOrigins.add(url.origin)
        } catch {}
      }
    }
    if (method === "Network.loadingFailed" && typeof params.requestId === "string") {
      const url = requests.get(params.requestId) ?? params.requestId
      const error = String(params.errorText ?? "failed")
      if (!(error === "net::ERR_ABORTED" && url.includes("/session"))) failedRequests.push(`${url}: ${error}`)
    }
  })

  let targetID = ""
  while (!targetID && Date.now() < deadline) {
    const targets = (await cdp.send("Target.getTargets")).targetInfos as Array<Record<string, unknown>>
    targetID = String(
      targets.find((target) => String(target.url ?? "").startsWith("arforge://renderer"))?.targetId ?? "",
    )
    if (!targetID) await sleep(250)
  }
  if (!targetID) throw new Error(`packaged renderer target is missing\n${appStdout}\n${appStderr}`)
  const attached = await cdp.send("Target.attachToTarget", { targetId: targetID, flatten: true })
  rendererSessionID = String(attached.sessionId ?? "")
  if (!rendererSessionID) throw new Error("packaged renderer CDP session is missing")
  for (const domain of ["Runtime", "Network", "Page"]) await cdp.send(`${domain}.enable`, {}, rendererSessionID)

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      rendererSessionID,
    )
    if (response.exceptionDetails)
      throw new Error(`renderer evaluation failed: ${JSON.stringify(response.exceptionDetails)}`)
    return ((response.result as Record<string, unknown>)?.value ?? undefined) as T
  }
  while (!observedApiOrigins.size && Date.now() < deadline) await sleep(250)
  while (!(await evaluate<boolean>(`!!document.querySelector('button[aria-label="打开 Arforge 设置"]')`))) {
    if (Date.now() >= deadline) throw new Error("packaged renderer did not become ready")
    await sleep(250)
  }
  const origin = observedApiOrigins.values().next().value ?? ""
  if (!origin) throw new Error("packaged renderer did not issue a local API request")
  return {
    process: appProcess,
    cdp,
    origin,
    rendererErrors,
    failedRequests,
    stdout: () => appStdout,
    stderr: () => appStderr,
    evaluate,
  }
}

async function stopDesktop(desktop: Desktop) {
  desktop.cdp.close()
  if (desktop.process.exitCode === null) desktop.process.kill()
  await Promise.race([
    new Promise<void>((done) => desktop.process.once("exit", () => done())),
    sleep(15_000).then(() => {
      throw new Error(`desktop process ${desktop.process.pid} did not exit after forced termination`)
    }),
  ])
}

async function stopProcess(child: ChildProcess, label: string) {
  if (child.exitCode !== null) return
  const exited = new Promise<void>((done) => child.once("exit", () => done()))
  child.kill()
  await Promise.race([
    exited,
    sleep(15_000).then(() => {
      throw new Error(`${label} process ${child.pid} did not exit after forced termination`)
    }),
  ])
}

type DurableRun = { runID: string; sessionID: string; status: string }
type DurableAction = {
  actionID: string
  runID: string | null
  name: string
  status: string
  observationStatus: string | null
  attemptsUsed: number
  mutationRecovery?: {
    transactionID: string
    phase: string
    decision: string
    requiresReview: boolean
  } | null
}
type PermissionRequest = { id: string; action: string; resources: string[] }

async function snapshot(origin: string, workspace: string) {
  const url = `${origin}/api/runtime-insight/snapshot?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&limit=100`
  const response = await fetch(url)
  if (!response.ok) {
    const detail = (await response.text()).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://<redacted>")
    throw new Error(`runtime snapshot failed with ${response.status}: ${detail.slice(0, 1000)}`)
  }
  return (await response.json()) as { durableRuns: DurableRun[]; durableActions: DurableAction[] }
}

async function sessionPermissions(origin: string, sessionID: string) {
  const response = await fetch(`${origin}/api/session/${encodeURIComponent(sessionID)}/permission`)
  if (!response.ok) throw new Error(`permission list failed with ${response.status}`)
  const body = (await response.json()) as { data?: PermissionRequest[] }
  return body.data ?? []
}

async function createSession(desktop: Desktop, workspace: string, prompt: string, grant: boolean) {
  const created = await fetch(`${desktop.origin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      location: { directory: workspace },
      model: { providerID: "test", id: "test-model" },
    }),
  })
  if (!created.ok) throw new Error(`session creation failed with ${created.status}`)
  const createdBody = (await created.json()) as { data?: { id?: string } }
  const sessionID = createdBody.data?.id
  if (!sessionID) throw new Error("session creation returned no ID")
  if (grant) {
    const granted = await fetch(
      `${desktop.origin}/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(workspace)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: [{ permission: "edit", pattern: "*", action: "allow" }] }),
      },
    )
    if (!granted.ok) throw new Error(`edit grant failed with ${granted.status}`)
  }
  const prompted = await fetch(`${desktop.origin}/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text: prompt } }),
  })
  if (!prompted.ok) throw new Error(`session prompt failed with ${prompted.status}`)
  return sessionID
}

async function replyPermission(origin: string, sessionID: string, requestID: string) {
  const response = await fetch(
    `${origin}/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    },
  )
  if (!response.ok) throw new Error(`permission reply failed with ${response.status}`)
}

async function waitFor<T>(label: string, timeoutMs: number, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await sleep(250)
  }
  throw new Error(`acceptance condition timed out: ${label}`)
}

async function openRuntimeInsight(desktop: Desktop) {
  await desktop.evaluate(
    `(document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
  )
  await waitFor("advanced settings controls", 120_000, async () =>
    (await desktop.evaluate<boolean>(
      `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具|收起高级工具|Hide advanced tools|收合進階工具/i.test(node.textContent || ''))`,
    ))
      ? true
      : undefined,
  )
  await desktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/i.test(node.textContent || ''))?.click()`,
  )
  const extensionsTab = '[data-slot="tabs-v2-trigger"][data-value="arforge-extensions"]'
  await waitFor("workflow settings tab", 120_000, async () =>
    (await desktop.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(extensionsTab)})`)) ? true : undefined,
  )
  await desktop.evaluate(`document.querySelector(${JSON.stringify(extensionsTab)})?.click()`)
  await waitFor("workflow management", 120_000, async () =>
    (await desktop.evaluate<boolean>(`!!document.querySelector('[data-testid="workflow-management"]')`))
      ? true
      : undefined,
  )
  const runtimeTab = '[data-slot="tabs-v2-trigger"][data-value="arforge-runtime"]'
  await waitFor("runtime insight tab", 120_000, async () =>
    (await desktop.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(runtimeTab)})`)) ? true : undefined,
  )
  await desktop.evaluate(`document.querySelector(${JSON.stringify(runtimeTab)})?.click()`)
  await waitFor("runtime insight workbench", 120_000, async () =>
    (await desktop.evaluate<boolean>(`!!document.querySelector('[data-testid="runtime-insight-workbench"]')`))
      ? true
      : undefined,
  )
  await waitFor("runtime insight loaded", 120_000, async () =>
    (await desktop.evaluate<boolean>(
      `document.querySelector('[data-testid="runtime-insight-workbench"]')?.getAttribute('aria-busy') === 'false'`,
    ))
      ? true
      : undefined,
  )
}

async function configureWorkspace(workspace: string, marker: string, llmURL: string) {
  await writeFile(
    join(workspace, "arforge.json"),
    JSON.stringify({
      $schema: "urn:arforge:config",
      shell: "bash",
      formatter: false,
      lsp: false,
      provider: {
        test: {
          name: "Step 2.12 Crash Boundary Acceptance",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: llmURL },
        },
      },
    }),
    "utf8",
  )
  await writeFile(join(workspace, "acceptance-marker.txt"), marker, "utf8")
}

async function createFakeLLM(toolTarget: string, marker: string, mode: string) {
  let approved = false
  let taskRequestCount = 0
  const pendingApproval = mode.startsWith("pending-approval")
  const toolName = pendingApproval ? "bash" : "write"
  const toolInput = pendingApproval
    ? { command: "exit 0", timeout: 10_000 }
    : { path: toolTarget, content: `${mode}\n` }
  const writeTool = (response: import("node:http").ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-boundary-tool","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      JSON.stringify({
        id: "chatcmpl-boundary-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_step_2_12_boundary",
                  type: "function",
                  function: { name: toolName, arguments: JSON.stringify(toolInput) },
                },
              ],
            },
          },
        ],
      }),
      '{"id":"chatcmpl-boundary-tool","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  }
  const complete = (response: import("node:http").ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-boundary-final","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      '{"id":"chatcmpl-boundary-final","object":"chat.completion.chunk","choices":[{"delta":{"content":"Step 2.12 boundary acceptance complete"}}]}',
      '{"id":"chatcmpl-boundary-final","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  }
  const server = createHttpServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    // The resumed provider envelope may omit the original user text after a
    // crash, but title requests are still distinguishable and must not receive
    // a tool call. All other isolated acceptance requests are task turns.
    const task = !body.includes("Generate a title for this conversation")
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" || !task) {
      complete(response)
      return
    }
    taskRequestCount += 1
    if (mode.startsWith("pending-approval") && approved) return complete(response)
    if (mode === "junction-reparse" && taskRequestCount > 1) return complete(response)
    if (taskRequestCount <= 2) return writeTool(response)
    return complete(response)
  })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => done())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake LLM server did not bind")
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    approve: () => {
      approved = true
    },
    requestCount: () => taskRequestCount,
  }
}

async function runScenario(
  mode:
    | "pending-approval"
    | "pending-approval-cancel"
    | "authorized-before-spawn"
    | "effect-before-observation"
    | "mutation-before-settlement"
    | "junction-reparse",
) {
  const temp = await mkdtemp(join(tmpdir(), `arforge-step-2-12-${mode}-`))
  const home = join(temp, "home")
  const workspace = join(temp, "workspace")
  const profile = join(temp, "electron-profile")
  const toolTarget = join(workspace, "boundary-marker.txt")
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(profile, { recursive: true }),
  ])
  let llm: Awaited<ReturnType<typeof createFakeLLM>> | undefined
  let first: Desktop | undefined
  let recovered: Desktop | undefined
  let boundarySeed: ChildProcess | undefined
  let boundarySeedStdout = ""
  let boundarySeedStderr = ""
  try {
    const marker = `step-2-12-${mode}`
    let toolPath = toolTarget
    let outsideTarget = ""
    const databasePath = join(temp, "runtime-insight.db")
    if (mode === "junction-reparse") {
      const outside = join(temp, "outside")
      const junction = join(workspace, "junction")
      await mkdir(outside, { recursive: true })
      await symlink(outside, junction, "junction")
      toolPath = "junction/escape.txt"
      outsideTarget = join(outside, "escape.txt")
    }
    llm = await createFakeLLM(toolPath, marker, mode)
    await configureWorkspace(workspace, marker, llm.url)
    first = await launchDesktop({
      workspace,
      home,
      profile,
      leaseTtlMs: 3_000,
      ...(mode === "mutation-before-settlement" ? { databasePath } : {}),
      ...(mode === "authorized-before-spawn" || mode === "effect-before-observation"
        ? { testCrashBoundary: mode }
        : mode === "mutation-before-settlement"
          ? { testMutationBoundary: "before-settlement" as const }
          : {}),
    })

    if (String(mode) === "mutation-before-settlement") {
      await writeFile(toolTarget, "desktop-runtime-insight-preimage\n", "utf8")
      boundarySeed = spawn(
        process.execPath,
        [join(import.meta.dir, "desktop-runtime-insight-seed.ts"), databasePath, workspace, "boundary-marker.txt"],
        {
          cwd: root,
          env: {
            ...process.env,
            ARFORGE_HOME: join(profile, "runtime"),
            ARFORGE_DB: databasePath,
            ARFORGE_DB_URL: "",
            ARFORGE_DB_ADMIN_URL: "",
            ARFORGE_DATABASE_MODE: "local",
            ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
            ARFORGE_DURABLE_LEASE_TTL_MS: "30000",
            ARFORGE_ACTION_LEASE_TTL_MS: "30000",
            ARFORGE_TEST_MUTATION_BOUNDARY: "before-settlement",
            ARFORGE_TEST_BOUNDARY_READY_FILE: join(temp, "boundary-seed-ready.json"),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      )
      boundarySeed.stdout?.on("data", (chunk) => (boundarySeedStdout += String(chunk)))
      boundarySeed.stderr?.on("data", (chunk) => (boundarySeedStderr += String(chunk)))
      const before = await waitFor("mutation-before-settlement boundary", 90_000, async () => {
        if (boundarySeed?.exitCode !== null)
          throw new Error(
            `mature mutation boundary seed exited early (code=${boundarySeed?.exitCode})\nstdout:\n${boundarySeedStdout}\nstderr:\n${boundarySeedStderr}`,
          )
        const ready = await readFile(join(temp, "boundary-seed-ready.json"), "utf8").catch(() => "")
        if (!ready) return undefined
        if ((await readFile(toolTarget, "utf8").catch(() => "")) !== "desktop-runtime-insight-postimage\n")
          return undefined
        const parsed = JSON.parse(ready) as { actionID?: string }
        return typeof parsed.actionID === "string" ? { actionID: parsed.actionID } : undefined
      })
      await stopProcess(boundarySeed, "mature mutation boundary seed")
      boundarySeed = undefined
      await stopDesktop(first)
      first = undefined
      await sleep(35_000)
      recovered = await launchDesktop({ workspace, home, profile, databasePath, leaseTtlMs: 3_000 })
      const result = await waitFor("mutation-before-settlement recovery block", 90_000, async () => {
        const current = await snapshot(recovered!.origin, workspace)
        const action = current.durableActions.find((item) => item.actionID === before.actionID)
        return action?.mutationRecovery?.requiresReview ? { action } : undefined
      })

      await openRuntimeInsight(recovered)
      const actionID = result.action.actionID
      const recordSelector = `[data-testid="durable-action-record"][data-action-id=${JSON.stringify(actionID)}]`
      await waitFor("mutation recovery action card", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(recordSelector)})`))
          ? true
          : undefined,
      )
      const initialText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
      )
      if (!/需要检查|requires review|outcome_unknown|postprocessing|检查/i.test(initialText))
        throw new Error(`mutation recovery card did not expose a review state: ${initialText}`)
      const inspectSelector = `${recordSelector} [data-testid="durable-action-inspect-targets"]`
      await recovered.evaluate(`document.querySelector(${JSON.stringify(inspectSelector)})?.click()`)
      const inspectionSelector = `${recordSelector} [data-testid="durable-action-inspection"]`
      await waitFor("mutation recovery inspection", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(inspectionSelector)})`))
          ? true
          : undefined,
      )
      const inspectionText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(inspectionSelector)})?.innerText || ''`,
      )
      if (!inspectionText.includes("boundary-marker.txt") || !/postimage|已写入|written|当前目标/i.test(inspectionText))
        throw new Error(`mutation recovery inspection is not understandable: ${inspectionText}`)
      const requireRollbackSelector = `${recordSelector} [data-testid="durable-action-review-require_rollback"]`
      await recovered.evaluate(`document.querySelector(${JSON.stringify(requireRollbackSelector)})?.click()`)
      await waitFor("mutation rollback-required review", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(recordSelector)})?.innerText?.includes('rollback_required') || /需要回滚|requires rollback|rollback required/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
        ))
          ? true
          : undefined,
      )
      const rollbackSelector = `${recordSelector} [data-testid="durable-action-rollback"]`
      await waitFor("guarded rollback action", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(rollbackSelector)})`))
          ? true
          : undefined,
      )
      await recovered.evaluate(`document.querySelector(${JSON.stringify(rollbackSelector)})?.click()`)
      await waitFor("guarded rollback completion", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `!document.querySelector(${JSON.stringify(rollbackSelector)}) && /rolled back|已回滚|回滚完成/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
        ))
          ? true
          : undefined,
      )
      if ((await readFile(toolTarget, "utf8")) !== "desktop-runtime-insight-preimage\n")
        throw new Error("guarded rollback did not restore the mutation preimage")

      await recovered.evaluate("location.reload()")
      await waitFor("mutation recovery refresh ready", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || '') || /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))`,
        ))
          ? true
          : undefined,
      )
      await recovered.evaluate(
        `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))?.click()`,
      )
      await waitFor("mutation recovery refresh settings", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || ''))`,
        ))
          ? true
          : undefined,
      )
      await openRuntimeInsight(recovered)
      await waitFor("rolled-back action after refresh", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(recordSelector)})`))
          ? true
          : undefined,
      )
      const refreshedText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
      )
      if (
        (await recovered.evaluate<boolean>(
          `!!document.querySelector(${JSON.stringify(`${recordSelector} [data-testid="durable-action-review-controls"]`)})`,
        )) ||
        !/rolled back|已回滚|回滚完成/i.test(refreshedText)
      )
        throw new Error(`refresh did not preserve rolled-back state: ${refreshedText}`)
      return {
        mode,
        requestCount: 0,
        actionStatus: result.action.status,
        mutationPhaseBeforeReview: "postprocessing",
        mutationPhaseAfterRollback: "rolled_back",
        inspected: true,
        rollbackExecuted: true,
        preimageRestored: true,
        refreshPreservedRollback: true,
        recovered: true,
      }
    }

    const sessionID = await createSession(first, workspace, marker, !mode.startsWith("pending-approval"))

    if (mode === "pending-approval-cancel") {
      const pending = await waitFor("pending approval before user cancel", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "bash")
        return action?.status === "awaiting_approval" ? { action } : undefined
      })
      const aborted = await fetch(`${first.origin}/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        method: "POST",
      })
      if (!aborted.ok)
        throw new Error(`session cancellation failed with ${aborted.status}: ${(await aborted.text()).slice(0, 500)}`)
      const cancelled = await waitFor("durable pending action cancellation", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "bash")
        return action?.status === "cancelled" ? { action } : undefined
      })
      if (
        await stat(toolTarget)
          .then(() => true)
          .catch(() => false)
      )
        throw new Error("pending approval cancellation produced an unexpected side effect")
      return {
        mode,
        requestCount: llm.requestCount(),
        actionStatus: cancelled.action.status,
        cancelledBeforeExecution: true,
        pendingActionID: pending.action.actionID,
        recovered: false,
      }
    }

    if (mode === "pending-approval") {
      const pending = await waitFor("pending approval before crash", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "bash")
        return action?.status === "awaiting_approval" ? { action } : undefined
      })
      await stopDesktop(first)
      first = undefined
      await sleep(4_000)
      recovered = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
      const recoveredRequest = await waitFor("pending approval re-presented after restart", 90_000, async () => {
        const requests = await sessionPermissions(recovered!.origin, sessionID)
        return requests[0]
      })
      llm.approve()
      await replyPermission(recovered.origin, sessionID, recoveredRequest.id)
      const result = await waitFor("pending approval completion", 90_000, async () => {
        const current = await snapshot(recovered!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const actions = current.durableActions.filter((item) => item.runID === run?.runID && item.name === "bash")
        return run?.status === "completed" && actions.length === 1 && actions[0]?.status === "settled"
          ? { run, actions }
          : undefined
      })
      if (
        await stat(toolTarget)
          .then(() => true)
          .catch(() => false)
      )
        throw new Error("pending approval scenario produced an unexpected side effect")
      return { mode, requestCount: llm.requestCount(), actionStatus: result.actions[0]?.status, recovered: true }
    }

    if (mode === "authorized-before-spawn") {
      await waitFor("authorized-before-spawn boundary", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "write")
        return action?.status === "authorized" ? action : undefined
      })
      await stopDesktop(first)
      first = undefined
      await sleep(4_000)
      recovered = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
      const result = await waitFor("authorized-before-spawn recovery", 90_000, async () => {
        const current = await snapshot(recovered!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const actions = current.durableActions.filter((item) => item.runID === run?.runID && item.name === "write")
        return run?.status === "completed" && actions.length === 1 && actions[0]?.status === "settled"
          ? { run, actions }
          : undefined
      })
      if ((await readFile(toolTarget, "utf8")) !== "authorized-before-spawn\n")
        throw new Error("authorized recovery write missing")
      return { mode, requestCount: llm.requestCount(), actionStatus: result.actions[0]?.status, recovered: true }
    }

    if (mode === "effect-before-observation") {
      const before = await waitFor("effect-before-observation boundary", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "write")
        try {
          await stat(toolTarget)
          return action?.status === "executing" ? action : undefined
        } catch {
          return undefined
        }
      })
      const mtimeBefore = (await stat(toolTarget)).mtimeMs
      await stopDesktop(first)
      first = undefined
      await sleep(4_000)
      recovered = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
      const result = await waitFor("effect-before-observation recovery block", 90_000, async () => {
        const current = await snapshot(recovered!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const actions = current.durableActions.filter((item) => item.runID === run?.runID && item.name === "write")
        return run?.status === "failed" && actions.length === 1 && actions[0]?.status === "blocked"
          ? { run, actions }
          : undefined
      })
      const mtimeAfter = (await stat(toolTarget)).mtimeMs
      if (mtimeAfter !== mtimeBefore) throw new Error("guarded write changed after effect-before-observation recovery")
      if ((await readFile(toolTarget, "utf8")) !== "effect-before-observation\n")
        throw new Error("effect-before-observation artifact changed")
      return {
        mode,
        requestCount: llm.requestCount(),
        actionStatus: result.actions[0]?.status,
        attemptsUsed: result.actions[0]?.attemptsUsed,
        recovered: true,
        initialStatus: before.status,
      }
    }

    if (String(mode) === "mutation-before-settlement") {
      const before = await waitFor("mutation-before-settlement boundary", 90_000, async () => {
        const current = await snapshot(first!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const action = current.durableActions.find((item) => item.runID === run?.runID && item.name === "write")
        if (action?.status !== "executing" || action.mutationRecovery?.phase !== "postprocessing") return undefined
        if ((await readFile(toolTarget, "utf8").catch(() => "")) !== "mutation-before-settlement\n") return undefined
        return { run, action }
      })
      await stopDesktop(first!)
      first = undefined
      await sleep(4_000)
      recovered = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
      const result = await waitFor("mutation-before-settlement recovery block", 90_000, async () => {
        const current = await snapshot(recovered!.origin, workspace)
        const run = current.durableRuns.find((item) => item.sessionID === sessionID)
        const actions = current.durableActions.filter((item) => item.runID === run?.runID && item.name === "write")
        const action = actions[0]
        return run?.status === "failed" && action?.status === "blocked" && action.mutationRecovery?.requiresReview
          ? { run, action }
          : undefined
      })

      await openRuntimeInsight(recovered)
      const actionID = result.action.actionID
      const recordSelector = `[data-testid="durable-action-record"][data-action-id=${JSON.stringify(actionID)}]`
      await waitFor("mutation recovery action card", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(recordSelector)})`))
          ? true
          : undefined,
      )
      const initialText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
      )
      if (!/需要检查|requires review|outcome_unknown|postprocessing|检查/i.test(initialText))
        throw new Error(`mutation recovery card did not expose a review state: ${initialText}`)
      const inspectSelector = `${recordSelector} [data-testid="durable-action-inspect-targets"]`
      await recovered.evaluate(`document.querySelector(${JSON.stringify(inspectSelector)})?.click()`)
      const inspectionSelector = `${recordSelector} [data-testid="durable-action-inspection"]`
      await waitFor("mutation recovery inspection", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(inspectionSelector)})`))
          ? true
          : undefined,
      )
      const inspectionText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(inspectionSelector)})?.innerText || ''`,
      )
      if (!inspectionText.includes("boundary-marker.txt") || !/postimage|已写入|written|当前目标/i.test(inspectionText))
        throw new Error(`mutation recovery inspection is not understandable: ${inspectionText}`)
      const requireRollbackSelector = `${recordSelector} [data-testid="durable-action-review-require_rollback"]`
      await recovered.evaluate(`document.querySelector(${JSON.stringify(requireRollbackSelector)})?.click()`)
      await waitFor("mutation rollback-required review", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `document.querySelector(${JSON.stringify(recordSelector)})?.innerText?.includes('rollback_required') || /需要回滚|requires rollback|rollback required/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
        ))
          ? true
          : undefined,
      )
      const rollbackSelector = `${recordSelector} [data-testid="durable-action-rollback"]`
      await waitFor("guarded rollback action", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(rollbackSelector)})`))
          ? true
          : undefined,
      )
      await recovered.evaluate(`document.querySelector(${JSON.stringify(rollbackSelector)})?.click()`)
      await waitFor("guarded rollback completion", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `!document.querySelector(${JSON.stringify(rollbackSelector)}) && /rolled back|已回滚|回滚完成/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
        ))
          ? true
          : undefined,
      )
      if ((await readFile(toolTarget, "utf8")) !== "mutation-before-settlement-preimage\n")
        throw new Error("guarded rollback did not restore the mutation preimage")

      await recovered.evaluate("location.reload()")
      await waitFor("mutation recovery refresh ready", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || '') || /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))`,
        ))
          ? true
          : undefined,
      )
      await recovered.evaluate(
        `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))?.click()`,
      )
      await waitFor("mutation recovery refresh settings", 90_000, async () =>
        (await recovered!.evaluate<boolean>(
          `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || '')`,
        ))
          ? true
          : undefined,
      )
      await openRuntimeInsight(recovered)
      await waitFor("rolled-back action after refresh", 90_000, async () =>
        (await recovered!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(recordSelector)})`))
          ? true
          : undefined,
      )
      const refreshedText = await recovered.evaluate<string>(
        `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
      )
      if (
        (await recovered.evaluate<boolean>(
          `!!document.querySelector(${JSON.stringify(`${recordSelector} [data-testid="durable-action-review-controls"]`)})`,
        )) ||
        !/rolled back|已回滚|回滚完成/i.test(refreshedText)
      )
        throw new Error(`refresh did not preserve rolled-back state: ${refreshedText}`)
      return {
        mode,
        requestCount: llm.requestCount(),
        actionStatus: result.action.status,
        mutationPhaseBeforeReview: before.action.mutationRecovery?.phase,
        mutationPhaseAfterRollback: "rolled_back",
        inspected: true,
        rollbackExecuted: true,
        preimageRestored: true,
        refreshPreservedRollback: true,
        recovered: true,
      }
    }

    const result = await waitFor("junction/reparse rejection", 90_000, async () => {
      const current = await snapshot(first!.origin, workspace)
      const run = current.durableRuns.find((item) => item.sessionID === sessionID)
      const actions = current.durableActions.filter((item) => item.runID === run?.runID && item.name === "write")
      // The canonical registry rejects an unresolved junction target during
      // static preflight, before ActionGateway creates a durable action. Keep
      // accepting the older durable-failure projection as well so this guard
      // remains valid across persisted fixtures and both pipeline generations.
      const rejectedBeforeAction = actions.length === 0
      const rejectedDurably = actions.some((item) => item.observationStatus === "failed" || item.status === "blocked")
      return run && ["failed", "completed"].includes(run.status) && (rejectedBeforeAction || rejectedDurably)
        ? { run, actions }
        : undefined
    })
    if (
      !outsideTarget ||
      (await stat(outsideTarget)
        .then(() => true)
        .catch(() => false))
    )
      throw new Error("junction/reparse escape target was created")
    if (
      result.actions.length > 0 &&
      !result.actions.some((item) => item.observationStatus === "failed" || item.status === "blocked")
    )
      throw new Error("junction/reparse write was not durably rejected")
    return {
      mode,
      requestCount: llm.requestCount(),
      actionStatus: result.actions[0]?.status,
      rejection: result.actions.length === 0 ? "preflight-static-path" : "durable-action",
      recovered: false,
    }
  } finally {
    if (boundarySeed) await stopProcess(boundarySeed, "mature mutation boundary seed").catch(() => undefined)
    if (first) await stopDesktop(first).catch(() => undefined)
    if (recovered) await stopDesktop(recovered).catch(() => undefined)
    if (llm?.server) await new Promise<void>((done) => (llm!.server as HttpServer).close(() => done()))
    if (process.env.ARFORGE_KEEP_ACCEPTANCE_PROFILE === "1") console.log(`boundary profile retained: ${temp}`)
    else await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

const allScenarios = [
  "pending-approval",
  "pending-approval-cancel",
  "authorized-before-spawn",
  "effect-before-observation",
  "mutation-before-settlement",
  "junction-reparse",
] as const
const requestedScenario = process.env.ARFORGE_CRASH_BOUNDARY_SCENARIO?.trim()
const scenarios = requestedScenario ? allScenarios.filter((scenario) => scenario === requestedScenario) : allScenarios
if (requestedScenario && scenarios.length === 0)
  throw new Error(`unknown crash-boundary scenario: ${requestedScenario}`)
const results = []
for (const scenario of scenarios) {
  results.push(await runScenario(scenario))
  console.log(`${scenario}: passed`)
}
await mkdir(artifacts, { recursive: true })
const artifactName =
  acceptanceBackend === "postgresql"
    ? "desktop-step-2-12-crash-boundaries-postgres-audit.json"
    : "desktop-step-2-12-crash-boundaries-audit.json"
await writeFile(
  join(artifacts, artifactName),
  JSON.stringify({ schemaVersion: 1, packagedDesktop: true, backend: acceptanceBackend, scenarios: results }, null, 2),
)
