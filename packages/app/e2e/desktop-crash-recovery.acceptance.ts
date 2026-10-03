import { spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const unpacked = join(root, "packages/desktop/dist/win-unpacked")
const appExeName = (await readdir(unpacked)).find((name) => name.toLowerCase().endsWith(".exe"))
if (!appExeName) throw new Error(`packaged desktop executable is missing from ${unpacked}`)
const appExe = join(unpacked, appExeName)
const artifacts = join(root, "artifacts")
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))

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
  waitFor: (expression: string, timeout?: number) => Promise<void>
  capture: (name: string) => Promise<void>
}

async function launchDesktop(input: {
  workspace: string
  home: string
  profile: string
  leaseTtlMs: number
}): Promise<Desktop> {
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
      ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
      ARFORGE_DURABLE_LEASE_TTL_MS: String(input.leaseTtlMs),
      ARFORGE_DB_URL: "",
      ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_MULTIAGENT_DB_URL: "",
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
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    rendererSessionID,
  )

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
  const waitFor = async (expression: string, timeout = 60_000) => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await evaluate<boolean>(expression)) return
      await sleep(250)
    }
    const diagnostics = await evaluate<unknown>(
      `({ url: location.href, body: document.body?.innerText?.slice(0, 5000) })`,
    )
    throw new Error(
      `renderer condition timed out: ${expression}\n${JSON.stringify({ diagnostics, rendererErrors, failedRequests, appStdout: appStdout.slice(-10000), appStderr: appStderr.slice(-10000) }, null, 2)}`,
    )
  }
  const capture = async (name: string) => {
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, rendererSessionID)
    await writeFile(join(artifacts, name), Buffer.from(String(screenshot.data), "base64"))
  }

  await waitFor(`!!document.querySelector('button[aria-label="打开 Arforge 设置"]')`, 60_000)
  let origin = ""
  while (!origin && Date.now() < deadline) {
    origin = observedApiOrigins.values().next().value ?? ""
    if (!origin) await sleep(250)
  }
  if (!origin) throw new Error("packaged renderer did not issue a request to its local TypeScript API")
  return {
    process: appProcess,
    cdp,
    origin,
    rendererErrors,
    failedRequests,
    stdout: () => appStdout,
    stderr: () => appStderr,
    evaluate,
    waitFor,
    capture,
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

type DurableRun = {
  runID: string
  sessionID: string
  status: string
  attemptsUsed: number
  maxAttempts: number
  durationMsUsed: number
  maxDurationMs: number
  costMicrosUsed: number
  maxCostMicros: number
  activeAttempt: { attempt: number; startedAt: number } | null
  lastLeaseGeneration: number | null
  lease: { generation: number; ownerID: string; expiresAt: number } | null
}

type DurableAction = {
  actionID: string
  runID: string | null
  name: string
  status: string
  authority: string
  riskTier: string
  observationStatus: string | null
  resultReplayable: boolean
  outputDigest: string | null
  outputByteLength: number | null
  attemptsUsed: number
  maxAttempts: number
  durationMsUsed: number
  maxDurationMs: number
  costMicrosUsed: number
  maxCostMicros: number
}

async function snapshot(origin: string, workspace: string) {
  const url = `${origin}/api/runtime-insight/snapshot?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&limit=100`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`runtime snapshot failed with ${response.status}: ${await response.text()}`)
  return (await response.json()) as { durableRuns: DurableRun[]; durableActions: DurableAction[] }
}

async function createCrashLlmServer(toolTarget: string) {
  let taskRequestCount = 0
  let crashBoundaryResolve: (() => void) | undefined
  const crashBoundary = new Promise<void>((done) => (crashBoundaryResolve = done))
  const requests: Array<{ path: string; body: string; task: boolean }> = []
  const complete = (response: import("node:http").ServerResponse, text: string) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-recovery","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      JSON.stringify({
        id: "chatcmpl-recovery",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      }),
      '{"id":"chatcmpl-recovery","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  }
  const callWriteTool = (response: import("node:http").ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-recovery-tool","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      JSON.stringify({
        id: "chatcmpl-recovery-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_durable_write_acceptance",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: toolTarget, content: "durable-action-ok\n" }),
                  },
                },
              ],
            },
          },
        ],
      }),
      '{"id":"chatcmpl-recovery-tool","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  }
  const server = createHttpServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      requests.push({ path: request.url ?? "", body, task: false })
      response.writeHead(404).end()
      return
    }
    const task =
      body.includes("执行崩溃恢复验收，不得重复副作用") && !body.includes("Generate a title for this conversation")
    requests.push({ path: request.url, body, task })
    if (!task) {
      complete(response, "崩溃恢复验收")
      return
    }
    taskRequestCount += 1
    if (taskRequestCount === 1) {
      callWriteTool(response)
      return
    }
    if (taskRequestCount === 2) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      response.write(
        'data: {"id":"chatcmpl-recovery","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      )
      crashBoundaryResolve?.()
      // The write Action is already settled and its result is durable. Hold
      // the model continuation open so the desktop is killed after the side
      // effect, then make recovery replay the same tool call ID.
      return
    }
    if (taskRequestCount === 3) {
      callWriteTool(response)
      return
    }
    complete(response, "崩溃恢复与持久动作验证成功")
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
    crashBoundary,
    requestCount: () => taskRequestCount,
    requests,
  }
}

const temp = await mkdtemp(join(tmpdir(), "arforge-desktop-crash-recovery-"))
const home = join(temp, "home")
const workspace = join(temp, "workspace")
const profile = join(temp, "electron-profile")
const toolTarget = join(workspace, "durable-action-marker.txt")
const credentialDirectory = join(profile, "runtime")
const providerPlaintextSecret = "packaged-provider-legacy-secret"
const mcpRemovedPlaintextSecret = "packaged-mcp-removed-secret"
const mcpRetainedPlaintextSecret = "packaged-mcp-retained-secret"
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(credentialDirectory, { recursive: true }),
  mkdir(artifacts, { recursive: true }),
])
await Promise.all([
  writeFile(
    join(credentialDirectory, "auth.json"),
    JSON.stringify({ test: { type: "api", key: providerPlaintextSecret } }),
    "utf8",
  ),
  writeFile(
    join(credentialDirectory, "mcp-auth.json"),
    JSON.stringify({
      "legacy-remove": { tokens: { accessToken: mcpRemovedPlaintextSecret } },
      "legacy-retain": { tokens: { accessToken: mcpRetainedPlaintextSecret } },
    }),
    "utf8",
  ),
])

let llm: Awaited<ReturnType<typeof createCrashLlmServer>> | undefined
let firstDesktop: Desktop | undefined
let recoveredDesktop: Desktop | undefined
try {
  llm = await createCrashLlmServer(toolTarget)
  await writeFile(
    join(workspace, "arforge.json"),
    JSON.stringify({
      $schema: "urn:arforge:config",
      formatter: false,
      lsp: false,
      provider: {
        test: {
          name: "Crash Recovery Acceptance",
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
          options: { apiKey: "test-key", baseURL: llm.url },
        },
      },
    }),
  )

  firstDesktop = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
  const credentialMigration = await firstDesktop.evaluate<{
    providerStatus: number
    mcpAddStatus: number
    mcpRemoveStatus: number
    details: string
  }>(`(async () => {
    const directory = encodeURIComponent(${JSON.stringify(workspace)});
    const provider = await fetch(${JSON.stringify(firstDesktop.origin + "/api/provider")} + '?directory=' + directory);
    const providerText = await provider.text();
    const added = await fetch(${JSON.stringify(firstDesktop.origin + "/mcp")} + '?directory=' + directory, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'legacy-remove', config: { type: 'local', command: ['unused'], enabled: false } })
    });
    const addText = await added.text();
    const removed = await fetch(${JSON.stringify(firstDesktop.origin + "/mcp/legacy-remove/auth")} + '?directory=' + directory, { method: 'DELETE' });
    const removeText = await removed.text();
    return {
      providerStatus: provider.status,
      mcpAddStatus: added.status,
      mcpRemoveStatus: removed.status,
      details: [providerText, addText, removeText].map((text) => text.slice(0, 500)).join(' | ')
    };
  })()`)
  if (
    credentialMigration.providerStatus >= 400 ||
    credentialMigration.mcpAddStatus >= 400 ||
    credentialMigration.mcpRemoveStatus >= 400
  )
    throw new Error(`packaged credential migration could not be exercised: ${JSON.stringify(credentialMigration)}`)

  const providerCredentialRaw = await readFile(join(credentialDirectory, "auth.json"), "utf8")
  const mcpCredentialRaw = await readFile(join(credentialDirectory, "mcp-auth.json"), "utf8")
  const providerCredentialEnvelope = JSON.parse(providerCredentialRaw) as Record<string, unknown>
  const mcpCredentialEnvelope = JSON.parse(mcpCredentialRaw) as Record<string, unknown>
  if (
    providerCredentialRaw.includes(providerPlaintextSecret) ||
    mcpCredentialRaw.includes(mcpRemovedPlaintextSecret) ||
    mcpCredentialRaw.includes(mcpRetainedPlaintextSecret) ||
    providerCredentialEnvelope.kind !== "arforge-protected-json" ||
    mcpCredentialEnvelope.kind !== "arforge-protected-json" ||
    providerCredentialEnvelope.provider !== "windows-dpapi-current-user" ||
    mcpCredentialEnvelope.provider !== "windows-dpapi-current-user"
  )
    throw new Error(
      `packaged credentials were not migrated to Windows protected storage: ${JSON.stringify({ provider: providerCredentialEnvelope, mcp: mcpCredentialEnvelope })}`,
    )

  const admitted = await firstDesktop.evaluate<{
    createStatus: number
    grantStatus: number
    promptStatus: number
    sessionID?: string
    body?: string
  }>(`(async () => {
    const created = await fetch(${JSON.stringify(firstDesktop.origin + "/api/session")}, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        location: { directory: ${JSON.stringify(workspace)} },
        model: { providerID: 'test', id: 'test-model' }
      })
    });
    const createBody = await created.text();
    if (!created.ok) return { createStatus: created.status, grantStatus: 0, promptStatus: 0, body: createBody };
    const sessionID = JSON.parse(createBody).data.id;
    const granted = await fetch(${JSON.stringify(firstDesktop.origin + "/session/")} + encodeURIComponent(sessionID) + '?directory=' + encodeURIComponent(${JSON.stringify(workspace)}), {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission: [{ permission: 'edit', pattern: '*', action: 'allow' }] })
    });
    const grantBody = await granted.text();
    if (!granted.ok) return { createStatus: created.status, grantStatus: granted.status, promptStatus: 0, sessionID, body: grantBody };
    const prompted = await fetch(${JSON.stringify(firstDesktop.origin + "/api/session/")} + encodeURIComponent(sessionID) + '/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: {
          text: '执行崩溃恢复验收，不得重复副作用'
        }
      })
    });
    return { createStatus: created.status, grantStatus: granted.status, promptStatus: prompted.status, sessionID, body: await prompted.text() };
  })()`)
  if (
    admitted.createStatus >= 400 ||
    admitted.grantStatus >= 400 ||
    admitted.promptStatus >= 400 ||
    !admitted.sessionID
  )
    throw new Error(`real Session admission failed: ${JSON.stringify(admitted)}`)

  const providerDeadline = Date.now() + 60_000
  let providerWaitRun: DurableRun | undefined
  let beforeCrashAction: DurableAction | undefined
  let latestProviderSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined
  while (Date.now() < providerDeadline) {
    const current = await snapshot(firstDesktop.origin, workspace)
    latestProviderSnapshot = current
    providerWaitRun = current.durableRuns.find((run) => run.sessionID === admitted.sessionID)
    beforeCrashAction = current.durableActions.find(
      (action) => action.runID === providerWaitRun?.runID && action.name === "write" && action.status === "settled",
    )
    if (llm.requestCount() >= 2 && beforeCrashAction) break
    if (providerWaitRun?.status === "failed") break
    await sleep(250)
  }
  if (llm.requestCount() < 2 || !beforeCrashAction)
    throw new Error(
      `the pre-crash write did not settle before the held continuation\n${JSON.stringify({ run: providerWaitRun, action: beforeCrashAction, durableActions: latestProviderSnapshot?.durableActions, providerRequests: llm.requests }, null, 2)}\n${firstDesktop.stdout()}\n${firstDesktop.stderr()}`,
    )
  let beforeCrash: DurableRun | undefined
  const beforeDeadline = Date.now() + 15_000
  while (!beforeCrash && Date.now() < beforeDeadline) {
    beforeCrash = (await snapshot(firstDesktop.origin, workspace)).durableRuns.find(
      (run) => run.sessionID === admitted.sessionID,
    )
    if (!beforeCrash) await sleep(250)
  }
  if (
    !beforeCrash ||
    beforeCrash.status !== "running" ||
    beforeCrash.attemptsUsed !== 1 ||
    beforeCrash.activeAttempt?.attempt !== 1 ||
    !beforeCrash.lease
  )
    throw new Error(
      `pre-crash Run did not own an active first attempt: ${JSON.stringify({ beforeCrash, taskRequestCount: llm.requestCount(), providerRequests: llm.requests }, null, 2)}`,
    )
  const originalRunID = beforeCrash.runID
  const originalLeaseGeneration = beforeCrash.lease.generation
  if (!beforeCrashAction.resultReplayable || !beforeCrashAction.outputDigest)
    throw new Error(`the settled write result was not replayable before crash: ${JSON.stringify(beforeCrashAction)}`)
  const writeMtimeBeforeCrash = (await stat(toolTarget)).mtimeMs

  // Desktop uses a memory router and restores the last route from the
  // per-window renderer store. Persist the recovered session route before the
  // forced crash so the restarted process opens the same session and its
  // control-center evidence instead of the first-run home screen.
  const windowID = await firstDesktop.evaluate<string>(`window.api.getWindowID?.() || "browser"`)
  // The built-in Electron sidecar is keyed as `sidecar` in the renderer even
  // though its HTTP origin is an ephemeral loopback port.
  const serverKey = Buffer.from("sidecar", "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "")
  const recoveredSessionPath = `/server/${serverKey}/session/${admitted.sessionID}`
  await firstDesktop.evaluate(
    `localStorage.setItem(${JSON.stringify(`arforge.desktop.window.${windowID}.last-active-url`)}, ${JSON.stringify(recoveredSessionPath)})`,
  )

  await stopDesktop(firstDesktop)
  firstDesktop = undefined
  if (llm.requestCount() !== 2)
    throw new Error(`the original desktop duplicated the provider request before restart: ${llm.requestCount()}`)

  recoveredDesktop = await launchDesktop({ workspace, home, profile, leaseTtlMs: 3_000 })
  const recoveryDeadline = Date.now() + 90_000
  let recoveredRun: DurableRun | undefined
  let allRuns: DurableRun[] = []
  while (Date.now() < recoveryDeadline) {
    let current: Awaited<ReturnType<typeof snapshot>>
    try {
      current = await snapshot(recoveredDesktop.origin, workspace)
    } catch (error) {
      if (recoveredDesktop.process.exitCode !== null)
        throw new Error(
          `recovered desktop exited while settling the tool action (exit=${recoveredDesktop.process.exitCode}): ${String(error)}\nstdout:\n${recoveredDesktop.stdout()}\nstderr:\n${recoveredDesktop.stderr()}`,
        )
      await sleep(250)
      continue
    }
    allRuns = current.durableRuns.filter((run) => run.sessionID === admitted.sessionID)
    recoveredRun = allRuns.find((run) => run.runID === originalRunID)
    if (llm.requestCount() >= 4 && recoveredRun?.status === "completed") break
    await sleep(250)
  }
  if (llm.requestCount() !== 4)
    throw new Error(
      `recovery must replay the model's tool call without repeating its side effect, then continue once; received ${llm.requestCount()} provider requests`,
    )
  if (allRuns.length !== 1 || !recoveredRun || recoveredRun.runID !== originalRunID)
    throw new Error(`recovery created a parallel Run instead of resuming the original: ${JSON.stringify(allRuns)}`)
  if (
    recoveredRun.status !== "completed" ||
    recoveredRun.attemptsUsed !== 2 ||
    recoveredRun.activeAttempt !== null ||
    recoveredRun.durationMsUsed <= 0
  )
    throw new Error(`recovered Run did not settle its second attempt: ${JSON.stringify(recoveredRun)}`)
  if (recoveredRun.lease)
    throw new Error(`completed Run retained an execution lease: ${JSON.stringify(recoveredRun.lease)}`)
  if (recoveredRun.lastLeaseGeneration === null || recoveredRun.lastLeaseGeneration <= originalLeaseGeneration)
    throw new Error(
      `recovery did not advance the durable lease generation: ${JSON.stringify({ originalLeaseGeneration, recovered: recoveredRun.lastLeaseGeneration })}`,
    )
  if ((await readFile(toolTarget, "utf8")) !== "durable-action-ok\n")
    throw new Error("the recovered mature write tool did not create the expected artifact")
  const writeMtimeAfterRecovery = (await stat(toolTarget)).mtimeMs
  if (writeMtimeAfterRecovery !== writeMtimeBeforeCrash)
    throw new Error(
      `the settled write side effect ran again during recovery: ${JSON.stringify({ writeMtimeBeforeCrash, writeMtimeAfterRecovery })}`,
    )
  const recoveredSnapshot = await snapshot(recoveredDesktop.origin, workspace)
  const writeActions = recoveredSnapshot.durableActions.filter(
    (action) => action.runID === originalRunID && action.name === "write",
  )
  if (
    writeActions.length !== 1 ||
    writeActions[0]?.riskTier !== "L2" ||
    writeActions[0]?.authority !== "scoped_grant" ||
    writeActions[0]?.status !== "settled" ||
    writeActions[0]?.observationStatus !== "succeeded" ||
    writeActions[0]?.resultReplayable !== true ||
    writeActions[0]?.attemptsUsed !== 1 ||
    writeActions[0]?.durationMsUsed < 0 ||
    writeActions[0]?.costMicrosUsed !== 0 ||
    !writeActions[0]?.outputDigest
  )
    throw new Error(`packaged mature write did not settle through the Action Gateway: ${JSON.stringify(writeActions)}`)

  // Open the recovered session through the real desktop memory-router path
  // before inspecting user-facing control-center evidence. This also clears
  // the first-launch overlay in a fresh isolated profile.
  await recoveredDesktop.evaluate(`window.api.storeGet('arforge.global.dat', 'server').then((raw) => {
    const state = raw ? JSON.parse(raw) : {};
    state.projects = { ...(state.projects || {}), local: [{ worktree: ${JSON.stringify(workspace)}, expanded: true }] };
    state.lastProject = { ...(state.lastProject || {}), local: ${JSON.stringify(workspace)} };
    state.recentlyClosed = { ...(state.recentlyClosed || {}), local: [] };
    return window.api.storeSet('arforge.global.dat', 'server', JSON.stringify(state));
  })`)
  await recoveredDesktop.evaluate(`(() => {
    const link = document.createElement('a');
    link.href = ${JSON.stringify(recoveredSessionPath)};
    document.body.appendChild(link);
    link.click();
    link.remove();
  })()`)
  await recoveredDesktop.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await recoveredDesktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))?.click()`,
  )
  await recoveredDesktop.waitFor(`!!document.querySelector('textarea') || !!document.querySelector('[contenteditable="true"]')`, 60_000)
  await recoveredDesktop.evaluate(
    `(document.querySelector('button[aria-label="会话控制中心"],button[aria-label="Session control center"],button[aria-label="Session 控制中心"]') || document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
  )
  await recoveredDesktop.waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具|收起高级工具|Hide advanced tools|收合進階工具/i.test(node.textContent || ''))`,
  )
  await recoveredDesktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/i.test(node.textContent || ''))?.click()`,
  )
  await recoveredDesktop.waitFor(`!!document.querySelector('[data-slot="tabs-v2-trigger"][data-value="arforge-memory"]')`, 60_000)
  await recoveredDesktop.evaluate(`document.querySelector('[data-slot="tabs-v2-trigger"][data-value="arforge-memory"]')?.click()`)
  await recoveredDesktop.waitFor(`!!document.querySelector('[data-testid="memory-learning-governance"]')`, 120_000)
  await recoveredDesktop.evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /运行时透视|Runtime insight/i.test(node.textContent || ''))?.click()`,
  )
  await recoveredDesktop.waitFor(`!!document.querySelector('[data-testid="runtime-insight-workbench"]')`, 120_000)
  await recoveredDesktop.waitFor(
    `document.querySelector('[data-testid="runtime-insight-workbench"]')?.getAttribute('aria-busy') === 'false'`,
    120_000,
  )
  await recoveredDesktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => (node.textContent || '').trim() === '刷新')?.click()`,
  )
  let durableText = ""
  const durableDeadline = Date.now() + 60_000
  while (!durableText && Date.now() < durableDeadline) {
    durableText = await recoveredDesktop.evaluate<string>(
      `(() => {
        const card = document.querySelector('[data-testid="durable-runtime-card"]');
        const text = card?.innerText || '';
        const complete = !!card &&
          !!card.querySelector('[data-testid="durable-run-record"]') &&
          /(?:已完成|Completed)/.test(text) &&
          /(?:执行)?尝试\\s*2\\/3|Attempt\\s*2\\/3/.test(text) &&
          /(?:任务)?占用时长|Duration/.test(text) &&
          /模型费用|Model cost/.test(text);
        return complete ? text : '';
      })()`,
    )
    if (!durableText) await sleep(250)
  }
  if (
    !/(?:已完成|Completed)/.test(durableText) ||
    !/(?:执行)?尝试\s*2\/3|Attempt\s*2\/3/.test(durableText) ||
    !/(?:任务)?占用时长|Duration/.test(durableText) ||
    !/模型费用|Model cost/.test(durableText)
  )
    throw new Error(`desktop UI did not explain recovered completion: ${durableText}`)
  await recoveredDesktop.waitFor(
    `/write/.test(document.querySelector('[data-testid="durable-actions-card"]')?.innerText || '') && /已验证并结算/.test(document.querySelector('[data-testid="durable-actions-card"]')?.innerText || '') && /结果已持久化，可免重复恢复/.test(document.querySelector('[data-testid="durable-actions-card"]')?.innerText || '')`,
    30_000,
  )
  await recoveredDesktop.waitFor(
    `/交付前验证/.test(document.querySelector('[data-testid="runtime-insight-workbench"]')?.innerText || '') && /恢复点完整性/.test(document.querySelector('[data-testid="runtime-insight-workbench"]')?.innerText || '') && /副作用动作结算/.test(document.querySelector('[data-testid="runtime-insight-workbench"]')?.innerText || '')`,
    30_000,
  )
  await recoveredDesktop.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="runtime-insight-workbench"] article')).find((node) => /交付前验证/.test(node.textContent || ''))?.scrollIntoView({ block: 'center' })`,
  )
  await recoveredDesktop.capture("desktop-real-crash-recovery.png")

  const electronBootstrapDiagnostics = recoveredDesktop.rendererErrors.filter(
    (error) =>
      error.includes("Electron sandboxed_renderer.bundle.js script failed to run") ||
      (error.includes("Cannot destructure property 'preloadScripts'") && error.includes("binding.startupData")),
  )
  const actionableRendererErrors = recoveredDesktop.rendererErrors.filter(
    (error) => !electronBootstrapDiagnostics.includes(error),
  )
  const report = {
    schemaVersion: 2,
    packagedDesktop: true,
    runtimeTopology: "typescript-core",
    legacyProviderCredentialMigrated: true,
    legacyMcpCredentialMigrated: true,
    credentialProvider: "windows-dpapi-current-user",
    plaintextCredentialAbsent: true,
    credentialWritesAtomic: true,
    realProviderAdapter: "@ai-sdk/openai-compatible",
    sessionID: admitted.sessionID,
    originalRunID,
    sameRunRecovered: recoveredRun.runID === originalRunID,
    attemptsUsed: recoveredRun.attemptsUsed,
    activeAttemptSettled: recoveredRun.activeAttempt === null,
    durationMsUsed: recoveredRun.durationMsUsed,
    maxDurationMs: recoveredRun.maxDurationMs,
    costMicrosUsed: recoveredRun.costMicrosUsed,
    maxCostMicros: recoveredRun.maxCostMicros,
    providerRequestCount: llm.requestCount(),
    durableWriteAction: writeActions[0],
    durableWriteArtifactVerified: true,
    durableResultReplayVerified: true,
    writeMtimeBeforeCrash,
    writeMtimeAfterRecovery,
    scopedEditGrantConfigured: true,
    originalLeaseGeneration,
    recoveredLeaseGeneration: recoveredRun.lastLeaseGeneration,
    recoveredLeaseReleased: recoveredRun.lease === null,
    desktopEvidenceVisible: true,
    independentDurableVerificationVisible: true,
    rendererErrors: actionableRendererErrors,
    electronBootstrapDiagnostics,
    failedRequests: recoveredDesktop.failedRequests,
  }
  await writeFile(join(artifacts, "desktop-real-crash-recovery-audit.json"), JSON.stringify(report, null, 2))
  if (report.rendererErrors.length || report.failedRequests.length) throw new Error(JSON.stringify(report, null, 2))
} finally {
  if (firstDesktop) await stopDesktop(firstDesktop).catch(() => undefined)
  if (recoveredDesktop) await stopDesktop(recoveredDesktop).catch(() => undefined)
  if (llm?.server) await new Promise<void>((done) => (llm!.server as HttpServer).close(() => done()))
  if (process.env.ARFORGE_KEEP_ACCEPTANCE_PROFILE === "1") console.log(`crash recovery profile retained: ${temp}`)
  else await rm(temp, { recursive: true, force: true }).catch(() => undefined)
}
