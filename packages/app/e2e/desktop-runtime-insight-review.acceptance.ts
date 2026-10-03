import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const desktopRoot = join(root, "packages/desktop")
const unpacked = join(desktopRoot, "dist/win-unpacked")
const launchMode = process.env.ARFORGE_DESKTOP_E2E_MODE === "packaged" ? "packaged" : "build"
const packagedExeName =
  launchMode === "packaged" ? (await readdir(unpacked)).find((name) => name.toLowerCase().endsWith(".exe")) : undefined
if (launchMode === "packaged" && !packagedExeName)
  throw new Error(`packaged desktop executable is missing from ${unpacked}`)
const appExe =
  launchMode === "packaged"
    ? join(unpacked, packagedExeName!)
    : join(desktopRoot, "node_modules/electron/dist/electron.exe")
const appArguments = launchMode === "packaged" ? [] : [desktopRoot]
const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds))

const configurePendingWorkspace = async (workspace: string, llmURL: string) => {
  await writeFile(
    join(workspace, "arforge.json"),
    JSON.stringify({
      $schema: "urn:arforge:config",
      shell: "bash",
      formatter: false,
      lsp: false,
      provider: {
        test: {
          name: "Runtime Insight pending-action acceptance",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Runtime Insight Test Model",
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
          options: { apiKey: "runtime-insight-test-key", baseURL: llmURL },
        },
      },
    }),
    "utf8",
  )
}

const createPendingLLM = async () => {
  let taskRequests = 0
  const complete = (response: import("node:http").ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-runtime-final","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      '{"id":"chatcmpl-runtime-final","object":"chat.completion.chunk","choices":[{"delta":{"content":"Runtime Insight pending action acceptance complete"}}]}',
      '{"id":"chatcmpl-runtime-final","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  }
  const server = createHttpServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    const task = !body.includes("Generate a title for this conversation")
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" || !task) {
      complete(response)
      return
    }
    taskRequests += 1
    if (taskRequests > 1) {
      complete(response)
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const events = [
      '{"id":"chatcmpl-runtime-tool","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}',
      JSON.stringify({
        id: "chatcmpl-runtime-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_runtime_pending_cancel",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command: "exit 0", timeout: 10_000 }) },
                },
              ],
            },
          },
        ],
      }),
      '{"id":"chatcmpl-runtime-tool","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "[DONE]",
    ]
    response.end(events.map((event) => `data: ${event}\n\n`).join(""))
  })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => done())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("pending-action fake LLM did not bind")
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    taskRequests: () => taskRequests,
  }
}

class CdpClient {
  private sequence = 0
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
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
        clearTimeout(request.timer)
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

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = 60_000) {
    const id = ++this.sequence
    return new Promise<Record<string, unknown>>((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`CDP ${method} timed out after ${timeout}ms`))
      }, timeout)
      this.pending.set(id, { resolve: done, reject: fail, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    this.socket.close()
  }
}

const temp = await mkdtemp(join(tmpdir(), "arforge-runtime-insight-desktop-"))
const home = join(temp, "home")
const workspace = join(temp, "workspace")
const profile = join(temp, "electron-profile")
const databasePath = join(temp, "runtime-insight.db")
const target = "runtime-review.txt"
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(profile, { recursive: true }),
])

let appProcess: ChildProcess | undefined
let cdp: CdpClient | undefined
let pendingLLM: Awaited<ReturnType<typeof createPendingLLM>> | undefined
let failure: unknown
let report: Record<string, unknown> = {
  schema_version: 1,
  passed: false,
  launch_mode: launchMode,
  isolated_workspace: workspace,
}

try {
  pendingLLM = await createPendingLLM()
  await configurePendingWorkspace(workspace, pendingLLM.url)
  const seed = spawnSync(
    process.execPath,
    [join(import.meta.dir, "desktop-runtime-insight-seed.ts"), databasePath, workspace, target],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        // The desktop main process intentionally rebinds ARFORGE_HOME to the
        // isolated Electron profile/runtime. Seed artifacts in that same
        // profile-owned store so the sidecar can verify and read them.
        ARFORGE_HOME: join(profile, "runtime"),
        ARFORGE_DB: databasePath,
        ARFORGE_DB_URL: "",
        ARFORGE_DB_ADMIN_URL: "",
        ARFORGE_DATABASE_MODE: "local",
      },
    },
  )
  if (seed.status !== 0) throw new Error(`runtime insight seed failed: ${String(seed.stderr || seed.stdout)}`)
  const seeded = JSON.parse(String(seed.stdout)) as {
    actionID: string
    transactionID: string
    executions: number
    target: string
    assetActionID: string
    assetTransactionID: string
    assetTargets: string[]
  }
  if (
    seeded.executions !== 1 ||
    seeded.target !== target ||
    !seeded.assetActionID ||
    !seeded.assetTransactionID ||
    seeded.assetTargets.length !== 2
  )
    throw new Error(`unexpected runtime insight seed: ${seed.stdout}`)

  let appStdout = ""
  let appStderr = ""
  appProcess = spawn(appExe, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, ...appArguments], {
    cwd: workspace,
    env: {
      ...process.env,
      ARFORGE_HOME: home,
      ARFORGE_DB: databasePath,
      ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
      ARFORGE_DB_URL: "",
      ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_MULTIAGENT_DB_URL: "",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  appProcess.stdout?.on("data", (chunk) => (appStdout += String(chunk)))
  appProcess.stderr?.on("data", (chunk) => (appStderr += String(chunk)))

  const devToolsPortPaths = [join(profile, "DevToolsActivePort"), join(profile, "session", "DevToolsActivePort")]
  const deadline = Date.now() + 120_000
  let debugPort = 0
  let endpoint = ""
  while (Date.now() < deadline) {
    if (debugPort === 0) {
      const activePort =
        (
          await Promise.all(
            devToolsPortPaths.map((path) =>
              readFile(path, "utf8")
                .then((value) => Number(value.split(/\r?\n/, 1)[0]))
                .catch(() => 0),
            ),
          )
        ).find((port) => Number.isInteger(port) && port > 0) ?? 0
      if (activePort > 0) debugPort = activePort
      else {
        const announcedPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(appStderr)?.[1]
        if (announcedPort) debugPort = Number(announcedPort)
      }
    }
    if (debugPort > 0) {
      try {
        const version = (await fetch(`http://127.0.0.1:${debugPort}/json/version`)) as Response
        const body = (await version.json()) as { webSocketDebuggerUrl?: string }
        if (body.webSocketDebuggerUrl) {
          endpoint = body.webSocketDebuggerUrl
          break
        }
      } catch {}
    }
    if (appProcess.exitCode !== null) break
    await sleep(250)
  }
  if (!endpoint)
    throw new Error(
      `desktop Electron CDP endpoint did not become ready (mode=${launchMode}, exit=${appProcess.exitCode})\nstdout:\n${appStdout}\nstderr:\n${appStderr}`,
    )

  const rendererErrors: string[] = []
  const runtimeInsightResponses: Array<{ url: string; status: number; type?: string }> = []
  const artifactResponses: Array<{ url: string; status: number; type?: string }> = []
  const runtimeInsightFailures: Array<{ url: string; error: string }> = []
  const runtimeInsightBodies: Array<{ url: string; status: number; body: string }> = []
  const runtimeInsightResponseByRequest = new Map<string, { url: string; status: number }>()
  const apiOrigins = new Set<string>()
  let rendererSessionID = ""
  let rendererMonitoringActive = false
  cdp = await CdpClient.connect(endpoint, (message) => {
    if (message.sessionId && message.sessionId !== rendererSessionID) return
    const method = String(message.method ?? "")
    const params = (message.params as Record<string, unknown>) ?? {}
    if (method === "Network.requestWillBeSent") {
      const request = params.request as Record<string, unknown> | undefined
      if (typeof request?.url === "string") {
        try {
          const url = new URL(request.url)
          if (url.pathname.startsWith("/api/")) apiOrigins.add(url.origin)
        } catch {}
      }
    }
    if (!rendererMonitoringActive) return
    if (method === "Runtime.exceptionThrown") rendererErrors.push(JSON.stringify(params.exceptionDetails ?? params))
    if (method === "Runtime.consoleAPICalled" && params.type === "error")
      rendererErrors.push(JSON.stringify(params.args))
    if (method === "Network.responseReceived") {
      const response = params.response as Record<string, unknown> | undefined
      if (typeof response?.url === "string" && response.url.includes("/api/runtime-insight/")) {
        runtimeInsightResponses.push({
          url: response.url,
          status: Number(response.status ?? 0),
          type: typeof params.type === "string" ? params.type : undefined,
        })
        const requestId = String(params.requestId ?? "")
        if (requestId)
          runtimeInsightResponseByRequest.set(requestId, { url: response.url, status: Number(response.status ?? 0) })
      }
      if (typeof response?.url === "string" && response.url.includes("/api/artifacts/"))
        artifactResponses.push({
          url: response.url,
          status: Number(response.status ?? 0),
          type: typeof params.type === "string" ? params.type : undefined,
        })
    }
    if (method === "Network.loadingFinished" && message.sessionId) {
      const requestId = String(params.requestId ?? "")
      const response = runtimeInsightResponseByRequest.get(requestId)
      if (response && response.status >= 400) {
        void cdp
          ?.send("Network.getResponseBody", { requestId }, String(message.sessionId))
          .then((body) => runtimeInsightBodies.push({ ...response, body: String(body.body ?? "") }))
          .catch((error) => runtimeInsightFailures.push({ url: response.url, error: `body: ${String(error)}` }))
      }
    }
    if (method === "Network.loadingFailed") {
      const request = params.requestId
      if (typeof request === "string")
        runtimeInsightFailures.push({ url: request, error: String(params.errorText ?? "unknown") })
    }
  })

  let targetID = ""
  while (!targetID && Date.now() < deadline) {
    const targets = (await cdp.send("Target.getTargets")).targetInfos as Array<Record<string, unknown>>
    targetID = String(
      targets.find((candidate) => String(candidate.url ?? "").startsWith("arforge://renderer"))?.targetId ?? "",
    )
    if (!targetID) await sleep(250)
  }
  if (!targetID) throw new Error("desktop renderer target is missing")
  const attached = await cdp.send("Target.attachToTarget", { targetId: targetID, flatten: true })
  rendererSessionID = String(attached.sessionId ?? "")
  if (!rendererSessionID) throw new Error("desktop renderer CDP session is missing")
  for (const domain of ["Runtime", "Network", "Page"]) await cdp.send(`${domain}.enable`, {}, rendererSessionID)
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    rendererSessionID,
  )

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp!.send(
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
    const diagnostics = await evaluate<unknown>(`({
      url: location.href,
      body: document.body?.innerText?.slice(0, 5000),
      tabs: Array.from(document.querySelectorAll('[data-slot="tabs-v2-trigger"],[data-slot="tabs-v2-content"]')).map((node) => ({
        slot: node.getAttribute('data-slot'), value: node.getAttribute('data-value'), state: node.getAttribute('data-state'),
        hidden: node.getAttribute('aria-hidden'), text: node.textContent?.trim().slice(0, 120)
      })),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 80).map((node) => ({
        aria: node.getAttribute('aria-label'), text: node.textContent?.trim()
      }))
    })`)
    throw new Error(
      `renderer condition timed out: ${expression}\n${JSON.stringify({
        diagnostics,
        rendererErrors,
        runtimeInsightResponses,
        runtimeInsightFailures,
        runtimeInsightBodies,
        appStdout: appStdout.slice(-5000),
        appStderr: appStderr.slice(-10000),
      })}`,
    )
  }
  const openRuntimeInsight = async () => {
    await evaluate(
      `(document.querySelector('button[aria-label="会话控制中心"],button[aria-label="Session control center"],button[aria-label="Session 控制中心"]') || document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
    )
    await waitFor(
      `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具|收起高级工具|Hide advanced tools|收合進階工具/i.test(node.textContent || ''))`,
    )
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/i.test(node.textContent || ''))?.click()`,
    )
    const workflowTriggerSelector = '[data-slot="tabs-v2-trigger"][data-value="arforge-extensions"]'
    await waitFor(`!!document.querySelector(${JSON.stringify(workflowTriggerSelector)})`)
    await evaluate(`document.querySelector(${JSON.stringify(workflowTriggerSelector)})?.click()`)
    await waitFor(`!!document.querySelector('[data-testid="workflow-management"]')`, 120_000)
    const runtimeTriggerSelector = '[data-slot="tabs-v2-trigger"][data-value="arforge-runtime"]'
    await waitFor(`!!document.querySelector(${JSON.stringify(runtimeTriggerSelector)})`)
    await evaluate(`document.querySelector(${JSON.stringify(runtimeTriggerSelector)})?.click()`)
    await waitFor(`!!document.querySelector('[data-testid="runtime-insight-workbench"]')`, 120_000)
    await waitFor(
      `document.querySelector('[data-testid="runtime-insight-workbench"]')?.getAttribute('aria-busy') === 'false'`,
      120_000,
    )
  }

  await evaluate(`window.api.storeGet('arforge.global.dat', 'server').then((raw) => {
    const state = raw ? JSON.parse(raw) : {};
    state.projects = { ...(state.projects || {}), local: [{ worktree: ${JSON.stringify(workspace)}, expanded: true }] };
    state.lastProject = { ...(state.lastProject || {}), local: ${JSON.stringify(workspace)} };
    state.recentlyClosed = { ...(state.recentlyClosed || {}), local: [] };
    return window.api.storeSet('arforge.global.dat', 'server', JSON.stringify(state));
  })`)
  await cdp.send("Page.reload", { ignoreCache: true }, rendererSessionID)
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || '') || /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))`,
    60_000,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || ''))`,
    60_000,
  )
  rendererMonitoringActive = true
  await openRuntimeInsight()

  const recordSelector = `[data-testid="durable-action-record"][data-action-id=${JSON.stringify(seeded.actionID)}]`
  await waitFor(`!!document.querySelector(${JSON.stringify(recordSelector)})`, 60_000)
  const initialText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
  )
  if (!/(自动重试|Automatic retry|无需重试|No retry|已结算|settled)/i.test(initialText))
    throw new Error(`runtime insight did not expose a non-repeatable settled/recovery state: ${initialText}`)
  const reviewRequired = await evaluate<boolean>(
    `!!document.querySelector(${JSON.stringify(recordSelector)})?.querySelector('[data-testid="durable-action-inspect-targets"]')`,
  )
  let postimageInspected = false
  let guardedRollbackExecuted = false
  let preimageRestored = false
  if (reviewRequired) {
    await evaluate(
      `document.querySelector(${JSON.stringify(recordSelector)})?.querySelector('[data-testid="durable-action-inspect-targets"]')?.click()`,
    )
    const inspectionSelector = `${recordSelector} [data-testid="durable-action-inspection"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(inspectionSelector)})`)
    const inspectionText = await evaluate<string>(
      `document.querySelector(${JSON.stringify(inspectionSelector)})?.innerText || ''`,
    )
    if (!inspectionText.includes(target) || !/(postimage|已写入|当前目标|written)/i.test(inspectionText))
      throw new Error(`runtime insight inspection is not understandable: ${inspectionText}`)
    postimageInspected = true
    await evaluate(
      `document.querySelector(${JSON.stringify(recordSelector)})?.querySelector('[data-testid="durable-action-review-require_rollback"]')?.click()`,
    )
    await waitFor(
      `document.querySelector(${JSON.stringify(recordSelector)})?.innerText?.includes('rollback_required') || /需要回滚|requires rollback|rollback required/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
      60_000,
    )
    const rollbackButtonSelector = `${recordSelector} [data-testid="durable-action-rollback"]`
    await waitFor(`!!document.querySelector(${JSON.stringify(rollbackButtonSelector)})`, 60_000)
    await evaluate(`document.querySelector(${JSON.stringify(rollbackButtonSelector)})?.click()`)
    await waitFor(
      `!document.querySelector(${JSON.stringify(rollbackButtonSelector)}) && !/回滚中|Rolling back/i.test(document.querySelector(${JSON.stringify(recordSelector)})?.innerText || '')`,
      60_000,
    )
    const settledText = await evaluate<string>(
      `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
    )
    if (!/(已结算|settled|rolled back|回滚)/i.test(settledText))
      throw new Error(
        `rolled-back runtime insight is not understandable: ${JSON.stringify({
          settledText,
          runtimeInsightResponses,
          rendererErrors,
        })}`,
      )
    const restored = await readFile(join(workspace, target), "utf8")
    if (restored !== "desktop-runtime-insight-preimage\n")
      throw new Error(
        `guarded rollback did not restore the preimage: ${JSON.stringify({ restored, settledText, runtimeInsightResponses })}`,
      )
    guardedRollbackExecuted = true
    preimageRestored = true
  } else {
    const current = await readFile(join(workspace, target), "utf8")
    if (current !== "desktop-runtime-insight-postimage\n")
      throw new Error(`mature write postimage was not visible in the workspace: ${JSON.stringify(current)}`)
  }
  await cdp.send("Page.reload", { ignoreCache: true }, rendererSessionID)
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || '') || /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))`,
    60_000,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now|稍後再說/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()) || /打开 Arforge 设置|Open Arforge settings/i.test(node.getAttribute('aria-label') || ''))`,
    60_000,
  )
  await openRuntimeInsight()
  await waitFor(`!!document.querySelector(${JSON.stringify(recordSelector)})`, 60_000)
  const refreshedText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(recordSelector)})?.innerText || ''`,
  )
  const reviewControlsSelector = `${recordSelector} [data-testid="durable-action-review-controls"]`
  const reviewStillVisible = await evaluate<boolean>(
    `!!document.querySelector(${JSON.stringify(reviewControlsSelector)})`,
  )
  if (reviewStillVisible || !/(已结算|settled|rolled back|回滚)/i.test(refreshedText))
    throw new Error(`refresh did not preserve the settled/recovery state: ${refreshedText}`)

  // The asset action is seeded through the real Core adapter above, so this
  // verifies the Desktop projection is not only a hand-written Browser fixture.
  const assetRecordSelector = `[data-testid="durable-action-record"][data-action-id=${JSON.stringify(seeded.assetActionID)}]`
  await waitFor(`!!document.querySelector(${JSON.stringify(assetRecordSelector)})`, 60_000)
  const assetRecordText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(assetRecordSelector)})?.innerText || ''`,
  )
  if (
    !/(asset-localization|Localize external assets|本地化外部资源|本地化外部資源)/i.test(assetRecordText) ||
    !/(已结算|settled)/i.test(assetRecordText)
  )
    throw new Error(
      `real asset localization action is not understandable in Desktop Runtime Insight: ${assetRecordText}`,
    )
  const assetProgressSelector = `${assetRecordSelector} [data-testid="durable-action-progress"]`
  await waitFor(`!!document.querySelector(${JSON.stringify(assetProgressSelector)})`, 60_000)
  const assetProgressText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(assetProgressSelector)})?.innerText || ''`,
  )
  if (
    !/(Asset localization progress|资产本地化进度|資產本地化進度)/i.test(assetProgressText) ||
    !/(Settled|已结算|已結算|Completed)/i.test(assetProgressText)
  )
    throw new Error(
      `real asset localization progress is not understandable in Desktop Runtime Insight: ${assetProgressText}`,
    )
  const localizedHTML = await readFile(join(workspace, "src/index.html"), "utf8")
  if (!/vendor\/js\/[a-f0-9]{64}\.js/.test(localizedHTML))
    throw new Error(`real asset localization did not rewrite the HTML target: ${localizedHTML}`)
  const stagedAssetEntries = await readdir(join(workspace, "src/vendor/js"))
  if (stagedAssetEntries.length !== 1 || !/^[a-f0-9]{64}\.js$/.test(stagedAssetEntries[0] ?? ""))
    throw new Error(`real asset localization did not stage one content-addressed asset: ${stagedAssetEntries}`)

  // Exercise the user-facing cancellation affordance against a live Session
  // execution. The fake model returns one real bash tool call; no permission
  // grant is supplied, so ActionGateway durably reaches awaiting_approval and
  // keeps the same-process SessionExecution waiter alive for the UI interrupt.
  const apiOrigin = apiOrigins.values().next().value as string | undefined
  if (!apiOrigin) throw new Error("desktop renderer did not expose a local API origin")
  const createdSession = await fetch(`${apiOrigin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      location: { directory: workspace },
      model: { providerID: "test", id: "test-model" },
    }),
  })
  if (!createdSession.ok) throw new Error(`pending UI session creation failed with ${createdSession.status}`)
  const createdSessionBody = (await createdSession.json()) as { data?: { id?: string } }
  const pendingSessionID = createdSessionBody.data?.id
  if (!pendingSessionID) throw new Error("pending UI session creation returned no ID")
  const prompted = await fetch(`${apiOrigin}/api/session/${encodeURIComponent(pendingSessionID)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text: "Run the pending cancellation acceptance tool and wait for approval." } }),
  })
  if (!prompted.ok) throw new Error(`pending UI session prompt failed with ${prompted.status}`)

  type PendingSnapshot = {
    durableRuns?: Array<{ runID: string; sessionID: string; status: string }>
    durableActions?: Array<{
      actionID: string
      runID: string | null
      name: string
      status: string
      sessionID?: string
    }>
  }
  const readPending = async () => {
    const response = await fetch(
      `${apiOrigin}/api/runtime-insight/snapshot?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&limit=100`,
    )
    if (!response.ok) return undefined
    const snapshot = (await response.json()) as PendingSnapshot
    const run = snapshot.durableRuns?.find((item) => item.sessionID === pendingSessionID)
    const action = snapshot.durableActions?.find(
      (item) => item.name === "bash" && (item.sessionID === pendingSessionID || item.runID === run?.runID),
    )
    return action?.status === "awaiting_approval" ? action : undefined
  }
  let pendingAction: NonNullable<Awaited<ReturnType<typeof readPending>>> | undefined
  const pendingDeadline = Date.now() + 90_000
  while (!pendingAction && Date.now() < pendingDeadline) {
    pendingAction = await readPending()
    if (!pendingAction) await sleep(250)
  }
  if (!pendingAction) throw new Error("live Session did not reach awaiting_approval before UI acceptance")

  // The desktop sidecar is exposed to the app as ServerConnection key
  // `sidecar`; this is the same canonical route used by sessionHref().
  const sessionRoute = `/server/c2lkZWNhcg/session/${encodeURIComponent(pendingSessionID)}`
  // Use the renderer's in-memory router semantics instead of asking Chrome to
  // load the custom `arforge:` protocol directly.  A real anchor click updates
  // the memory history; assigning location.href would reload the shell and
  // discard the route because the desktop URL itself is not the router state.
  await evaluate(`(() => {
    const link = document.createElement('a');
    link.href = ${JSON.stringify(sessionRoute)};
    document.body.appendChild(link);
    link.click();
    link.remove();
  })()`)
  // DesktopMemoryRouter keeps its history in memory, so the browser's
  // custom-protocol pathname remains `/index.html`.  The mounted Session
  // header is the observable route-completion signal.
  await waitFor(
    `!!document.querySelector('button[aria-label="会话控制中心"],button[aria-label="Session control center"],button[aria-label="Session 控制中心"]')`,
    120_000,
  )
  // The first Runtime Insight pass was opened from the global settings
  // command, whose dialog deliberately has no Session owner. Reloading the
  // real session route clears that modal state before the session-header
  // control center is opened, so the UI receives the originating session ID.
  await cdp.send("Page.reload", { ignoreCache: true }, rendererSessionID)
  // The workspace shell mounts before the target Session has resolved. Wait
  // for the Session header's owner-bound control before opening settings;
  // otherwise a fast click can open the global, unbound settings surface.
  await waitFor(
    `!!document.querySelector('button[aria-label="会话控制中心"],button[aria-label="Session control center"],button[aria-label="Session 控制中心"]')`,
    120_000,
  )
  await waitFor(
    `!!document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()))`,
    60_000,
  )
  await openRuntimeInsight()
  const pendingRecordSelector = `[data-testid="durable-action-record"][data-action-id=${JSON.stringify(pendingAction.actionID)}]`
  await waitFor(`!!document.querySelector(${JSON.stringify(pendingRecordSelector)})`, 90_000)
  const pendingRecordText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(pendingRecordSelector)})?.innerText || ''`,
  )
  if (!/awaiting|审批|批准|确认|approval/i.test(pendingRecordText))
    throw new Error(`live pending action is not understandable before cancellation: ${pendingRecordText}`)
  const pendingCancelSelector = `${pendingRecordSelector} [data-testid="durable-action-cancel-button"]`
  await waitFor(`!!document.querySelector(${JSON.stringify(pendingCancelSelector)})`, 60_000)
  const pendingCancelHint = await evaluate<string>(
    `document.querySelector(${JSON.stringify(pendingRecordSelector)})?.querySelector('[data-testid="durable-action-cancel"]')?.innerText || ''`,
  )
  if (!/originating|发起会话|原始会话|來源 Session|原始 Session|session/i.test(pendingCancelHint))
    throw new Error(`live pending cancellation guidance is not understandable: ${pendingCancelHint}`)
  await evaluate(`document.querySelector(${JSON.stringify(pendingCancelSelector)})?.click()`)
  const cancelledDeadline = Date.now() + 90_000
  let cancelledAction: NonNullable<PendingSnapshot["durableActions"]>[number] | undefined
  while (!cancelledAction && Date.now() < cancelledDeadline) {
    const response = await fetch(
      `${apiOrigin}/api/runtime-insight/snapshot?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&limit=100`,
    )
    if (response.ok) {
      const snapshot = (await response.json()) as PendingSnapshot
      const candidate = snapshot.durableActions?.find((item) => item.actionID === pendingAction!.actionID)
      if (candidate?.status === "cancelled") cancelledAction = candidate
    }
    if (!cancelledAction) await sleep(250)
  }
  if (!cancelledAction) throw new Error("live pending action did not settle as cancelled after UI interrupt")
  await waitFor(
    `!document.querySelector(${JSON.stringify(pendingCancelSelector)}) && /cancelled|已取消|已取消/i.test(document.querySelector(${JSON.stringify(pendingRecordSelector)})?.innerText || '')`,
    60_000,
  )
  const pendingRecordAfterCancel = await evaluate<string>(
    `document.querySelector(${JSON.stringify(pendingRecordSelector)})?.innerText || ''`,
  )
  if (!/cancelled|已取消|已取消/i.test(pendingRecordAfterCancel))
    throw new Error(`live pending cancellation state is not understandable: ${pendingRecordAfterCancel}`)

  const operationsTab = '[data-slot="tabs-v2-trigger"][data-value="arforge-operations"]'
  await waitFor(`!!document.querySelector(${JSON.stringify(operationsTab)})`)
  await evaluate(`document.querySelector(${JSON.stringify(operationsTab)})?.click()`)
  await waitFor(`!!document.querySelector('[data-testid="tenant-platform-workbench"]')`, 120_000)
  await waitFor(
    `document.querySelector('[data-testid="tenant-platform-workbench"]')?.getAttribute('aria-busy') === 'false'`,
    120_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="artifact-evidence-scope-picker"]')`, 120_000)
  const scopeState = await evaluate<{ profileDisabled: boolean; tenantDisabled: boolean; text: string }>(`(() => {
    const root = document.querySelector('[data-testid="artifact-evidence-scope-picker"]');
    const profile = root?.querySelector('[data-testid="artifact-evidence-profile-scope"]');
    const tenant = root?.querySelector('[data-testid="artifact-evidence-tenant-scope"]');
    return { profileDisabled: !!profile?.disabled, tenantDisabled: !!tenant?.disabled, text: root?.innerText || '' };
  })()`)
  if (scopeState.profileDisabled || scopeState.tenantDisabled)
    throw new Error(`local owner scope controls were unexpectedly disabled: ${JSON.stringify(scopeState)}`)
  if (!/Current profile|当前配置空间|目前設定空間/.test(scopeState.text))
    throw new Error(`profile scope label is not understandable: ${scopeState.text}`)
  await evaluate(`document.querySelector('[data-testid="artifact-evidence-tenant-scope"]')?.click()`)
  await waitFor(
    `/current tenant|当前租户|目前租戶/.test(document.querySelector('[data-testid="artifact-evidence-card"]')?.innerText || '')`,
    120_000,
  )
  const tenantEvidenceText = await evaluate<string>(
    `document.querySelector('[data-testid="artifact-evidence-card"]')?.innerText || ''`,
  )
  if (
    !/current tenant|当前租户|目前租戶/.test(tenantEvidenceText) ||
    !/local paths and file contents are never shown|不展示本机路径或文件内容|不展示本機路徑或檔案內容/.test(
      tenantEvidenceText,
    )
  )
    throw new Error(`tenant evidence scope is not understandable: ${tenantEvidenceText}`)
  const badResponses = runtimeInsightResponses.filter((response) => response.status < 200 || response.status >= 300)
  const badArtifactResponses = artifactResponses.filter((response) => response.status < 200 || response.status >= 300)
  if (rendererErrors.length || badResponses.length || badArtifactResponses.length)
    throw new Error(JSON.stringify({ rendererErrors, badResponses, badArtifactResponses }))
  report = {
    schema_version: 1,
    passed: true,
    launch_mode: launchMode,
    isolated_workspace: workspace,
    action_id: seeded.actionID,
    transaction_id: seeded.transactionID,
    asset_action_id: seeded.assetActionID,
    asset_transaction_id: seeded.assetTransactionID,
    asset_targets: seeded.assetTargets,
    asset_action_visible: true,
    asset_action_settled: true,
    asset_progress_visible: true,
    asset_html_rewritten: true,
    asset_staged_file_visible: true,
    target,
    executions_before_review: seeded.executions,
    retry_blocked_before_review: true,
    postimage_inspected: postimageInspected,
    guarded_rollback_executed: guardedRollbackExecuted,
    preimage_restored: preimageRestored,
    refresh_preserved_rollback: true,
    owner_scope_profile_visible: true,
    owner_scope_tenant_visible: true,
    owner_scope_same_evidence_card: true,
    pending_action_session_id: pendingSessionID,
    pending_action_id: pendingAction.actionID,
    pending_action_ui_visible: true,
    pending_action_cancelled_before_execution: true,
    pending_action_cancelled: cancelledAction.status === "cancelled",
    pending_llm_task_requests: pendingLLM?.taskRequests() ?? 0,
    artifact_responses: artifactResponses,
    runtime_insight_responses: runtimeInsightResponses,
  }
} catch (error) {
  failure = error
  report = { ...report, error: error instanceof Error ? error.message : String(error) }
} finally {
  cdp?.close()
  if (appProcess?.pid && appProcess.exitCode === null) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(appProcess.pid), "/T", "/F"], { windowsHide: true })
    else appProcess.kill("SIGTERM")
  }
  if (process.env.ARFORGE_KEEP_ACCEPTANCE_PROFILE !== "1") {
    await sleep(250)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
  if (pendingLLM) await new Promise<void>((done) => pendingLLM!.server.close(() => done()))
}

await mkdir(join(root, "artifacts"), { recursive: true })
await writeFile(join(root, "artifacts/desktop-runtime-insight-review-audit.json"), JSON.stringify(report, null, 2))
if (failure) throw failure
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
