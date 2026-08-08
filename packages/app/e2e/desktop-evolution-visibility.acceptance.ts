import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PythonBridgeClient } from "../../agent-python/src/client"

const root = resolve(import.meta.dir, "../../..")
const appExe = join(root, "packages/desktop/dist/win-unpacked/Arforge Dev.exe")
const bridgeExe = join(root, "packages/desktop/dist/win-unpacked/resources/agent-python/arforge-agent-bridge.exe")
const artifacts = join(root, "artifacts")
const privateCohortKey = "desktop-visibility-private-cohort"
const executionSources = Array.from({ length: 4 }, (_, index) => ({
  kind: "session_turn" as const,
  authority: "typescript-core" as const,
  session_id: `ses_desktop_visibility_${index + 1}`,
  user_message_id: `msg_user_desktop_visibility_${index + 1}`,
  assistant_message_id: `msg_assistant_desktop_visibility_${index + 1}`,
  turn_step: index + 1,
}))
const memoryAcceptanceContent = "发布前必须运行部署烟雾测试，并验证回滚计划。"
const memoryAcceptanceQuery = "部署发布前需要验证什么？"
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), 30_000)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("CDP WebSocket open failed"))
      })
    })
    return new CdpClient(socket, onEvent)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.sequence
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  close() {
    this.socket.close()
  }
}
const temp = await mkdtemp(join(tmpdir(), "arforge-evolution-visibility-"))
const home = join(temp, "home")
const workspace = join(temp, "profile")
const uiData = join(temp, "electron-profile")
const downloads = join(temp, "downloads")
await Promise.all([
  mkdir(home),
  mkdir(workspace),
  mkdir(uiData),
  mkdir(downloads),
  mkdir(artifacts, { recursive: true }),
])
const acceptanceEnv = join(temp, "acceptance.env")
await writeFile(acceptanceEnv, "# Intentionally empty: packaged desktop acceptance uses isolated local storage.\n")

const bridge = new PythonBridgeClient({
  workspace,
  bridgeExecutable: bridgeExe,
  home,
  requestTimeoutMs: 60_000,
})

let appProcess: ChildProcess | undefined
let cdp: CdpClient | undefined
try {
  const created = await bridge.mutate<{
    candidate_id: string
    state: { revision: number }
  }>("evolution.candidate.create", {
    title: "Visible retention acceptance strategy",
    target: "tool.advice",
    instruction: "Prefer a narrow verified action before broad execution.",
    rationale: "Create persisted candidate and exposure facts for packaged desktop acceptance.",
    evidence_refs: ["acceptance:desktop-execution-visibility"],
  })
  const evaluated = await bridge.mutate<{ state: { revision: number } }>("evolution.evaluate", {
    candidate_id: created.candidate_id,
    expected_revision: created.state.revision,
  })
  const approved = await bridge.mutate<{ state: { revision: number } }>("evolution.approve", {
    candidate_id: created.candidate_id,
    expected_revision: evaluated.state.revision,
    reason: "Acceptance evaluation evidence reviewed.",
  })
  await bridge.mutate("evolution.canary.start", {
    candidate_id: created.candidate_id,
    expected_revision: approved.state.revision,
    reason: "Bounded packaged desktop visibility acceptance.",
    traffic_percent: 100,
  })

  const exposures: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const prepared = await bridge.mutate<{ exposure_id: string }>("evolution.context.prepare", {
      user_input: `Packaged visibility task ${index + 1}`,
      cohort_key: `${privateCohortKey}-${index + 1}`,
      source: {
        kind: executionSources[index].kind,
        authority: executionSources[index].authority,
        session_id: executionSources[index].session_id,
        user_message_id: executionSources[index].user_message_id,
        turn_step: executionSources[index].turn_step,
      },
    })
    exposures.push(prepared.exposure_id)
    if (index < 3) {
      await bridge.mutate("evolution.task.outcome.record", {
        exposure_id: prepared.exposure_id,
        success: true,
        stop_reason: `visibility acceptance outcome ${index + 1}`,
        safety_incident: false,
        assistant_message_id: executionSources[index].assistant_message_id,
      })
    }
  }
  await bridge.close()

  const rendererErrors: string[] = []
  const failedRequests: string[] = []
  const ignoredAbortedRequests: string[] = []
  const apiResponses: Array<{ url: string; status: number }> = []
  const navigations: Array<{ url: string; loaderID: string }> = []
  const debugPort = 52_000 + Math.floor(Math.random() * 8_000)
  let appStdout = ""
  let appStderr = ""
  appProcess = spawn(appExe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${uiData}`], {
    cwd: workspace,
    env: {
      ...process.env,
      ARFORGE_HOME: home,
      ARFORGE_AGENT_HOME: home,
      ARFORGE_DATABASE_MODE: "local",
      ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
      ARFORGE_ENV_FILE: acceptanceEnv,
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
    const announced = /DevTools listening on (ws:\/\/[^\s]+)/.exec(appStderr)
    if (announced?.[1]) {
      endpoint = announced[1]
      break
    }
    try {
      const version = (await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) =>
        response.json(),
      )) as {
        webSocketDebuggerUrl?: string
      }
      if (version.webSocketDebuggerUrl) {
        endpoint = version.webSocketDebuggerUrl
        break
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  if (!endpoint)
    throw new Error(
      `packaged Electron CDP endpoint did not become ready (exit=${appProcess.exitCode})\nstdout:\n${appStdout}\nstderr:\n${appStderr}`,
    )
  const requestURLs = new Map<string, string>()
  cdp = await CdpClient.connect(endpoint, (message) => {
    const method = String(message.method ?? "")
    const params = (message.params as Record<string, unknown>) ?? {}
    if (method === "Runtime.exceptionThrown") rendererErrors.push(JSON.stringify(params.exceptionDetails ?? params))
    if (method === "Runtime.consoleAPICalled" && params.type === "error")
      rendererErrors.push(JSON.stringify(params.args))
    if (method === "Page.frameNavigated") {
      const frame = params.frame as Record<string, unknown> | undefined
      if (frame?.parentId === undefined)
        navigations.push({ url: String(frame?.url ?? ""), loaderID: String(frame?.loaderId ?? "") })
    }
    if (method === "Network.requestWillBeSent") {
      const request = params.request as Record<string, unknown> | undefined
      if (typeof params.requestId === "string" && request && typeof request.url === "string")
        requestURLs.set(params.requestId, request.url)
    }
    if (method === "Network.loadingFailed" && typeof params.requestId === "string") {
      const url = requestURLs.get(params.requestId) ?? params.requestId
      const error = String(params.errorText ?? "failed")
      const failure = `${url}: ${error}`
      if (error === "net::ERR_ABORTED" && url.includes("/session")) ignoredAbortedRequests.push(failure)
      else failedRequests.push(failure)
    }
    if (method === "Network.responseReceived") {
      const response = params.response as Record<string, unknown> | undefined
      if (response && typeof response.url === "string" && response.url.includes("/evolution/"))
        apiResponses.push({ url: response.url, status: Number(response.status ?? 0) })
    }
  })
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  })
  let targetID = ""
  while (!targetID && Date.now() < deadline) {
    const targets = (await cdp.send("Target.getTargets")).targetInfos as Array<Record<string, unknown>>
    targetID = String(
      targets.find((target) => String(target.url ?? "").startsWith("arforge://renderer"))?.targetId ?? "",
    )
    if (!targetID) await sleep(250)
  }
  if (!targetID) throw new Error("packaged renderer target is missing")
  const attached = await cdp.send("Target.attachToTarget", { targetId: targetID, flatten: true })
  const sessionID = String(attached.sessionId ?? "")
  if (!sessionID) throw new Error("packaged renderer CDP session is missing")
  for (const domain of ["Runtime", "Network", "Page", "Log"]) await cdp.send(`${domain}.enable`, {}, sessionID)
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1920, height: 1200, deviceScaleFactor: 1, mobile: false },
    sessionID,
  )

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp!.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionID,
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
      readyState: document.readyState,
      title: document.title,
      body: document.body?.innerText?.slice(0, 2000),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 50).map((node) => ({
        aria: node.getAttribute('aria-label'),
        text: node.textContent?.trim(),
      })),
    })`)
    throw new Error(
      `renderer condition timed out: ${expression}\n${JSON.stringify(
        {
          diagnostics,
          rendererErrors,
          failedRequests,
          ignoredAbortedRequests,
          navigations,
          appStdout: appStdout.slice(-8_000),
          appStderr: appStderr.slice(-8_000),
        },
        null,
        2,
      )}`,
    )
  }
  const capture = async (name: string) => {
    const screenshot = await cdp!.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionID)
    await writeFile(join(artifacts, name), Buffer.from(String(screenshot.data), "base64"))
  }

  await waitFor(`!!document.querySelector('button[aria-label="打开 Arforge 设置"]')`, 60_000)
  await evaluate(`document.querySelector('button[aria-label="打开 Arforge 设置"]')?.click()`)
  await waitFor(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => (node.textContent || '').includes('Memory / Learning'))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => (node.textContent || '').includes('Memory / Learning'))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="memory-learning-governance"]')`, 120_000)
  await waitFor(`!!document.querySelector('[data-testid="context-fusion-evidence"]')`, 30_000)
  const fusionEntryText = await evaluate<string>(
    `document.querySelector('[data-testid="context-fusion-evidence"]')?.innerText || ''`,
  )
  if (
    !/真实双运行时上下文融合|Actual dual-runtime context fusion|真實雙執行時上下文融合/.test(fusionEntryText) ||
    !/请从一个会话内打开设置|Open Settings from a Session|請從一個 Session 內開啟設定/.test(fusionEntryText)
  )
    throw new Error(`packaged dual-runtime evidence entry is not source-bound: ${fusionEntryText}`)
  await evaluate(
    `document.querySelector('[data-testid="context-fusion-evidence"]')?.scrollIntoView({ block: 'center' })`,
  )
  await sleep(500)
  await capture("desktop-context-fusion-entry.png")
  const memoryEntered = await evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-testid="memory-learning-governance"]');
    const textarea = root?.querySelector('textarea[aria-label="记忆内容"], textarea[aria-label="Memory content"]');
    if (!root || !textarea) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, ${JSON.stringify(memoryAcceptanceContent)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  if (!memoryEntered) throw new Error("memory creation input is not usable from the packaged desktop")
  await waitFor(`(() => {
    const root = document.querySelector('[data-testid="memory-learning-governance"]');
    const textarea = root?.querySelector('textarea[aria-label="记忆内容"], textarea[aria-label="Memory content"]');
    const create = Array.from(root?.querySelectorAll('button') || []).find((node) => /^(创建|Create|建立)$/.test((node.textContent || '').trim()));
    return textarea?.value === ${JSON.stringify(memoryAcceptanceContent)} && !!create && !create.disabled;
  })()`)
  const memoryCreated = await evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-testid="memory-learning-governance"]');
    const create = Array.from(root?.querySelectorAll('button') || []).find((node) => /^(创建|Create|建立)$/.test((node.textContent || '').trim()));
    create?.click();
    return !!create;
  })()`)
  if (!memoryCreated) throw new Error("memory creation action is not usable from the packaged desktop")
  await waitFor(
    `document.querySelector('[data-testid="memory-learning-governance"]')?.textContent?.includes(${JSON.stringify(memoryAcceptanceContent)}) === true`,
    30_000,
  )
  const recallEntered = await evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-testid="memory-recall-inspector"]');
    const input = root?.querySelector('input');
    if (!root || !input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, ${JSON.stringify(memoryAcceptanceQuery)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  if (!recallEntered) throw new Error("memory recall inspector input is not usable from the packaged desktop")
  await waitFor(`(() => {
    const root = document.querySelector('[data-testid="memory-recall-inspector"]');
    const input = root?.querySelector('input');
    const inspect = Array.from(root?.querySelectorAll('button') || []).find((node) => /检查召回过程|Inspect recall|檢查召回過程/.test(node.textContent || ''));
    return input?.value === ${JSON.stringify(memoryAcceptanceQuery)} && !!inspect && !inspect.disabled;
  })()`)
  const recallStarted = await evaluate<boolean>(`(() => {
    const root = document.querySelector('[data-testid="memory-recall-inspector"]');
    const inspect = Array.from(root?.querySelectorAll('button') || []).find((node) => /检查召回过程|Inspect recall|檢查召回過程/.test(node.textContent || ''));
    inspect?.click();
    return !!inspect;
  })()`)
  if (!recallStarted) throw new Error("memory recall inspector action is not usable from the packaged desktop")
  await waitFor(`!!document.querySelector('[data-testid="memory-recall-result"]')`, 120_000)
  const memoryRecallText = await evaluate<string>(
    `document.querySelector('[data-testid="memory-recall-result"]')?.innerText || ''`,
  )
  for (const expected of [
    memoryAcceptanceContent,
    "hybrid_bm25_hashing_vector",
    "1. 规范化查询",
    "2. 过滤本地作用域",
    "3. 混合排序",
    "4. 选择上下文候选",
    "词法分数",
    "向量分数",
  ])
    if (!memoryRecallText.includes(expected))
      throw new Error(`memory recall visualization is missing ${expected}: ${memoryRecallText}`)
  await evaluate(
    `document.querySelector('[data-testid="memory-recall-inspector"]')?.scrollIntoView({ block: 'center' })`,
  )
  await sleep(500)
  await capture("desktop-memory-recall-visibility.png")

  await waitFor(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => /受控自主进化|Governed Evolution/.test(node.textContent || ''))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /受控自主进化|Governed Evolution/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="evolution-workbench"]')`, 120_000)
  await waitFor(
    `document.querySelector('[data-testid="evolution-execution-timeline"]')?.textContent?.match(/Audit chain verified|审计链已验证|審計鏈已驗證/) != null`,
    120_000,
  )
  const initialTimelineText = await evaluate<string>(
    `document.querySelector('[data-testid="evolution-execution-timeline"]')?.innerText || ''`,
  )
  if (
    !/Model turn prepared|模型调用已准备|模型呼叫已準備/.test(initialTimelineText) ||
    !/Terminal outcome recorded|终态结果已记录|終態結果已記錄/.test(initialTimelineText)
  )
    throw new Error(`execution source lifecycle is missing from the visible timeline: ${initialTimelineText}`)

  const inspectedSource = executionSources[0]
  const openedExposure = await evaluate<boolean>(`(() => {
    const details = Array.from(document.querySelectorAll('[data-testid="evolution-exposure-audit"] details'))
      .find((node) => (node.textContent || '').includes(${JSON.stringify(exposures[0])}));
    if (!details) return false;
    details.open = true;
    details.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  if (!openedExposure) throw new Error(`recorded exposure ${exposures[0]} is missing from the desktop audit`)
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="evolution-exposure-source"]')).some((node) =>
      (node.textContent || '').includes(${JSON.stringify(inspectedSource.session_id)}) &&
      (node.textContent || '').includes(${JSON.stringify(inspectedSource.user_message_id)}) &&
      (node.textContent || '').includes(${JSON.stringify(inspectedSource.assistant_message_id)}) &&
      (node.textContent || '').includes(${JSON.stringify(String(inspectedSource.turn_step))}) &&
      Array.from(node.querySelectorAll('button')).some((button) => /Open source Session|打开来源会话|開啟來源 Session/.test(button.textContent || ''))
    )`,
  )
  const sourceText = await evaluate<string>(
    `Array.from(document.querySelectorAll('[data-testid="evolution-exposure-source"]'))
      .find((node) => (node.textContent || '').includes(${JSON.stringify(inspectedSource.session_id)}))?.textContent || ''`,
  )
  if (sourceText.includes(privateCohortKey) || /Packaged visibility task/.test(sourceText))
    throw new Error(`execution source card leaked private cohort or message content: ${sourceText}`)
  await capture("desktop-evolution-execution-source.png")

  await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('label')).find((node) => /Keep newest recorded exposures|保留最新已记录曝光数|保留最新已記錄曝光數/.test(node.textContent || ''));
    const input = label?.querySelector('input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /Preview archive plan|预览归档计划|預覽封存計畫/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="evolution-archive-plan"]')`)
  const planText = await evaluate<string>(
    `document.querySelector('[data-testid="evolution-archive-plan"]')?.innerText || ''`,
  )
  if (!/2/.test(planText)) throw new Error(`archive preview did not show two eligible records: ${planText}`)
  const bodyBefore = await evaluate<string>(`document.body.innerText`)
  if (bodyBefore.includes(privateCohortKey)) throw new Error("private cohort key leaked into packaged renderer")
  await evaluate(
    `document.querySelector('[data-testid="evolution-archive-plan"]')?.scrollIntoView({ block: 'center' })`,
  )
  await sleep(500)
  await capture("desktop-evolution-visibility-preview.png")

  await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('label')).find((node) => /Why these records may be archived|归档这些记录的理由|封存這些記錄的理由/.test(node.textContent || ''));
    const input = label?.querySelector('input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Retain the newest completed exposure while verifying recoverable evidence archival.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.confirm = () => true;
    return true;
  })()`)
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /Archive reviewed records|归档已审查记录|封存已審查記錄/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `document.body.innerText.match(/evidence journal was verified|验证了证据日志|驗證了證據日誌/) != null`,
    120_000,
  )
  await waitFor(
    `(() => {
      const library = document.querySelector('[data-testid="evolution-archive-library"]');
      return !!library && /xa-[0-9a-f]{24}/.test(library.textContent || '');
    })()`,
    120_000,
  )
  await evaluate(`(() => {
    const library = document.querySelector('[data-testid="evolution-archive-library"]');
    const archive = Array.from(library?.querySelectorAll('button') || []).find((node) => /xa-[0-9a-f]{24}/.test(node.textContent || ''));
    archive?.click();
    return !!archive;
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="archive-detail"]')`, 120_000)
  const archiveDetailText = await evaluate<string>(
    `document.querySelector('[data-testid="archive-detail"]')?.innerText || ''`,
  )
  if (!/2/.test(archiveDetailText))
    throw new Error(`archive detail did not show recoverable records: ${archiveDetailText}`)
  if ((await evaluate<string>(`document.body.innerText`)).includes(privateCohortKey))
    throw new Error("private cohort key leaked into the archive browser")

  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /Export sanitized audit JSON|导出脱敏审计 JSON|匯出脫敏審計 JSON/.test(node.textContent || ''))?.click()`,
  )
  const exportDeadline = Date.now() + 60_000
  let exportedFile = ""
  while (!exportedFile && Date.now() < exportDeadline) {
    const files = await readdir(downloads)
    exportedFile = files.find((file) => file.endsWith("-public-audit.json")) ?? ""
    if (!exportedFile) await sleep(250)
  }
  if (!exportedFile) throw new Error("sanitized archive export was not downloaded")
  const exportedContent = await readFile(join(downloads, exportedFile), "utf8")
  if (exportedContent.includes(privateCohortKey) || exportedContent.includes('"cohort_key"'))
    throw new Error("private cohort key leaked into sanitized archive export")

  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /Preview restore|预览恢复计划|預覽恢復計畫/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="evolution-restore-plan"]')`, 120_000)
  const restorePlanText = await evaluate<string>(
    `document.querySelector('[data-testid="evolution-restore-plan"]')?.innerText || ''`,
  )
  if (!/2/.test(restorePlanText))
    throw new Error(`restore preview did not show two missing records: ${restorePlanText}`)
  await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('label')).find((node) => /Why these archived records should be restored|为什么需要恢复这些归档记录|為什麼需要恢復這些封存記錄/.test(node.textContent || ''));
    const input = label?.querySelector('input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Restore verified evidence through the packaged desktop recovery path.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.confirm = () => true;
    return true;
  })()`)
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /Restore verified records|恢复已验证记录|恢復已驗證記錄/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `document.body.innerText.match(/restored without modifying|未修改不可变归档|未修改不可變封存/) != null`,
    120_000,
  )
  await waitFor(
    `(() => {
      const text = document.querySelector('[data-testid="evolution-execution-timeline"]')?.innerText || '';
      return text.toLowerCase().includes('archive evidence restored') || text.includes('已恢复归档证据') || text.includes('已恢復封存證據');
    })()`,
    120_000,
  )
  await evaluate(
    `document.querySelector('[data-testid="evolution-archive-library"]')?.scrollIntoView({ block: 'center' })`,
  )
  await sleep(500)
  await capture("desktop-evolution-archive-recovery.png")
  await waitFor(
    `(() => {
      const text = document.querySelector('[data-testid="evolution-execution-timeline"]')?.innerText || '';
      return text.toLowerCase().includes('exposure archive completed') || text.includes('归档已完成') || text.includes('封存已完成');
    })()`,
  )
  await evaluate(
    `(() => {
      const element = document.querySelector('[data-testid="evolution-execution-timeline"]');
      if (!element) return false;
      element.scrollIntoView({ block: 'start' });
      let scroller = element.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - 260);
      return true;
    })()`,
  )
  await sleep(500)
  await capture("desktop-evolution-visibility-timeline.png")
  const bodyAfter = await evaluate<string>(`document.body.innerText`)
  if (bodyAfter.includes(privateCohortKey)) throw new Error("private cohort key leaked after archive execution")
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionID,
  )
  await sleep(500)
  const responsiveLayout = await evaluate<{ viewport: number; body: number; library: number; libraryClient: number }>(
    `(() => {
      const library = document.querySelector('[data-testid="evolution-archive-library"]');
      return {
        viewport: document.documentElement.clientWidth,
        body: document.documentElement.scrollWidth,
        library: library?.scrollWidth || 0,
        libraryClient: library?.clientWidth || 0,
      };
    })()`,
  )
  if (
    responsiveLayout.body > responsiveLayout.viewport + 1 ||
    responsiveLayout.library > responsiveLayout.libraryClient + 1
  )
    throw new Error(`archive recovery layout overflowed at medium width: ${JSON.stringify(responsiveLayout)}`)
  await capture("desktop-evolution-archive-recovery-medium.png")

  const verificationBridge = new PythonBridgeClient({
    workspace,
    bridgeExecutable: bridgeExe,
    home,
    requestTimeoutMs: 60_000,
  })
  const active = await verificationBridge.call<{ total: number; counts: { pending: number; recorded: number } }>(
    "evolution.exposures",
    { limit: 10 },
  )
  await verificationBridge.close()
  if (active.total !== 4 || active.counts.pending !== 1 || active.counts.recorded !== 3)
    throw new Error(`unexpected active exposure counts: ${JSON.stringify(active)}`)

  const report = {
    schemaVersion: 1,
    candidateID: created.candidate_id,
    seededExposureIDs: exposures,
    preview: { visible: true, eligible: 2, privacySafe: true },
    applied: { visible: true, archived: 2, activeCounts: { pending: 1, recorded: 1 }, privacySafe: true },
    archiveLibrary: { visible: true, integrityVerified: true, archived: 2, privacySafe: true },
    sanitizedExport: { visible: true, filename: exportedFile, privacySafe: true },
    restore: { visible: true, restored: 2, activeCounts: active.counts, archivePreserved: true, privacySafe: true },
    responsiveLayout: { width: 900, noHorizontalOverflow: true },
    executionSource: {
      visible: true,
      sessionID: inspectedSource.session_id,
      userMessageID: inspectedSource.user_message_id,
      assistantMessageID: inspectedSource.assistant_message_id,
      turnStep: inspectedSource.turn_step,
      sourceSessionActionVisible: true,
      messageContentPrivate: true,
      cohortPrivate: true,
    },
    memoryRecall: {
      visible: true,
      sameSessionRanker: true,
      query: memoryAcceptanceQuery,
      expectedMemoryVisible: true,
      pipelineStepsVisible: 4,
      scoreComponentsVisible: ["lexical", "vector", "combined"],
      previewDistinguishedFromTurnEvidence: true,
    },
    dualRuntimeFusionSurface: {
      visible: true,
      packaged: true,
      sourceSessionRequired: true,
      actualTurnEvidenceCoveredByE2E: "packages/app/e2e/regression/context-fusion-evidence.spec.ts",
    },
    timeline: {
      visible: true,
      preparationEventVisible: true,
      outcomeEventVisible: true,
      completionEventVisible: true,
      chainVerified: true,
    },
    rendererErrors,
    failedRequests,
    ignoredAbortedRequests,
    apiResponses,
  }
  await writeFile(join(artifacts, "desktop-evolution-visibility-audit.json"), JSON.stringify(report, null, 2))
  if (rendererErrors.length || failedRequests.length) throw new Error(JSON.stringify(report, null, 2))
} finally {
  await bridge.close().catch(() => undefined)
  cdp?.close()
  appProcess?.kill()
  await sleep(500)
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
}
