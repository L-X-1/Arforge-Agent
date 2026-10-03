import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { base64Encode } from "@arforge-ai/core/util/encode"

const root = resolve(import.meta.dir, "../../..")
const desktopRoot = join(root, "packages/desktop")
const unpacked = join(root, "packages/desktop/dist/win-unpacked")
const launchMode = process.env.ARFORGE_DESKTOP_E2E_MODE === "packaged" ? "packaged" : "build"
const packagedExeName =
  launchMode === "packaged" ? (await readdir(unpacked)).find((name) => name.toLowerCase().endsWith(".exe")) : undefined
if (launchMode === "packaged" && !packagedExeName)
  throw new Error(`packaged desktop executable is missing from ${unpacked}`)
const appExe =
  launchMode === "packaged"
    ? join(unpacked, packagedExeName!)
    : join(desktopRoot, "node_modules", "electron", "dist", "electron.exe")
const appArguments = launchMode === "packaged" ? [] : [desktopRoot]
const artifacts = join(root, "artifacts")
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))

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

const temp = await mkdtemp(join(tmpdir(), "arforge-typescript-desktop-acceptance-"))
const home = join(temp, "home")
const workspace = join(temp, "workspace")
const profile = join(temp, "electron-profile")
const databasePath = join(temp, "desktop-acceptance.db")
const workflowDirectory = join(workspace, ".arforge", "workflows")
const pluginSourceDirectory = join(workspace, "desktop-plugin-source")
const blockedPluginSourceDirectory = join(workspace, "desktop-blocked-plugin-source")
// Isolated desktop acceptance deliberately remaps ARFORGE_HOME under the
// Electron profile so no real user skill can leak into the test process.
const managedSkillDirectory = join(profile, "runtime", "skills", "desktop-review-skill")
const artifactSuffix = String(process.env.ARFORGE_ACCEPTANCE_ARTIFACT_SUFFIX ?? "")
const artifactName = (name: string) => name.replace(/(\.[^.]+)$/, `${artifactSuffix}$1`)
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(artifacts, { recursive: true }),
  mkdir(workflowDirectory, { recursive: true }),
  mkdir(pluginSourceDirectory, { recursive: true }),
  mkdir(blockedPluginSourceDirectory, { recursive: true }),
  mkdir(managedSkillDirectory, { recursive: true }),
])
await writeFile(
  join(workflowDirectory, "desktop-experience.json"),
  JSON.stringify(
    {
      schema_version: 1,
      name: "桌面工作流体验验收",
      description: "验证工作流预览、人工批准和完成状态是否能被普通用户理解。",
      steps: [
        {
          id: "prepare",
          title: "准备检查点",
          kind: "checkpoint",
          access: "read",
          max_attempts: 1,
        },
        {
          id: "approve",
          title: "确认继续",
          kind: "approval",
          access: "write",
          depends_on: ["prepare"],
          max_attempts: 1,
        },
      ],
    },
    null,
    2,
  ),
)
await writeFile(
  join(pluginSourceDirectory, "plugin.json"),
  JSON.stringify(
    {
      name: "desktop-review-plugin",
      version: "1.0.0",
      description: "Safe local plugin used by the desktop lifecycle acceptance.",
      permissions: [{ action: "filesystem.read", resources: ["workspace://desktop-review"] }],
      egress: ["https://api.example.com"],
      secrets: ["DESKTOP_REVIEW_TOKEN"],
      compatibility: { api_version: 1, platforms: [process.platform], runtime: "typescript-core" },
      tools: [
        {
          name: "review",
          description: "Return a bounded review marker.",
          command: ["echo", "reviewed"],
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    },
    null,
    2,
  ),
)
await writeFile(
  join(blockedPluginSourceDirectory, "plugin.json"),
  JSON.stringify(
    {
      name: "desktop-blocked-plugin",
      version: "1.0.0",
      description: "Unsafe local plugin used to prove fail-closed inspection.",
      tools: [{ name: "unsafe", description: "Unsafe test tool", command: ["echo", "unsafe"] }],
    },
    null,
    2,
  ),
)
await writeFile(
  join(blockedPluginSourceDirectory, "runner.js"),
  "fetch('https://undeclared.example'); process.env.UNDECLARED_SECRET;\n",
)
await writeFile(
  join(managedSkillDirectory, "SKILL.md"),
  `---\nid: desktop-review-skill\nname: Desktop Review Skill\ndescription: Desktop lifecycle acceptance skill.\nversion: 1.0.0\nlicense: LicenseRef-Proprietary\ntags: [development, acceptance]\n---\n# Desktop Review Skill\nUse this fixture only for lifecycle acceptance.\n`,
)
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true })
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`)
}
git("init")
git("config", "user.email", "desktop-e2e@arforge.local")
git("config", "user.name", "Arforge Desktop E2E")
git("add", ".")
git("commit", "-m", "desktop acceptance fixture")
const seededExperience = spawnSync(
  process.execPath,
  [join(import.meta.dir, "desktop-verified-experience-seed.ts"), databasePath, workspace],
  {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ARFORGE_DB: databasePath,
      ARFORGE_DB_URL: "",
      ARFORGE_DB_ADMIN_URL: "",
      ARFORGE_DATABASE_MODE: "local",
    },
  },
)
if (seededExperience.status !== 0)
  throw new Error(`desktop Experience fixture failed: ${String(seededExperience.stderr || seededExperience.stdout)}`)
const seededExperienceIDs = JSON.parse(String(seededExperience.stdout)) as string[]
if (seededExperienceIDs.length !== 3)
  throw new Error(`desktop Experience fixture did not produce three verified sources: ${seededExperienceIDs.join(",")}`)

let appProcess: ChildProcess | undefined
let cdp: CdpClient | undefined
try {
  const rendererErrors: string[] = []
  const bootstrapDiagnostics: string[] = []
  const failedRequests: string[] = []
  const capabilityResponses: Array<{ url: string; status: number }> = []
  const runtimeInsightResponses: Array<{ url: string; status: number }> = []
  // Chromium owns port allocation atomically. Reserving and releasing a port first is
  // flaky on Windows because the socket may not be immediately reusable.
  let debugPort = 0
  let appStdout = ""
  let appStderr = ""
  let rendererMonitoringActive = false
  const devToolsPortPaths = [join(profile, "DevToolsActivePort"), join(profile, "session", "DevToolsActivePort")]

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
  })
  appProcess.stdout?.on("data", (chunk) => (appStdout += String(chunk)))
  appProcess.stderr?.on("data", (chunk) => (appStderr += String(chunk)))

  const deadline = Date.now() + 120_000
  let endpoint = ""
  while (Date.now() < deadline) {
    try {
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
        if (Number.isInteger(activePort) && activePort > 0) debugPort = activePort
        else {
          const announcedPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(appStderr)?.[1]
          if (announcedPort) debugPort = Number(announcedPort)
        }
      }
      if (debugPort === 0) {
        await sleep(250)
        continue
      }
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
      `desktop Electron CDP endpoint did not become ready (mode=${launchMode}, exit=${appProcess.exitCode})\nstdout:\n${appStdout}\nstderr:\n${appStderr}`,
    )

  const requests = new Map<string, { url: string; method: string }>()
  let rendererSessionID = ""
  cdp = await CdpClient.connect(endpoint, (message) => {
    const method = String(message.method ?? "")
    const params = (message.params as Record<string, unknown>) ?? {}
    // The browser CDP endpoint also reports transient Electron helper targets.
    // Acceptance evidence must describe the attached Arforge renderer only.
    if (/^(Runtime|Network|Log)\./.test(method) && message.sessionId !== rendererSessionID) return
    if (method === "Runtime.exceptionThrown")
      (rendererMonitoringActive ? rendererErrors : bootstrapDiagnostics).push(
        JSON.stringify(params.exceptionDetails ?? params),
      )
    if (method === "Runtime.consoleAPICalled" && params.type === "error")
      (rendererMonitoringActive ? rendererErrors : bootstrapDiagnostics).push(JSON.stringify(params.args))
    if (method === "Network.requestWillBeSent") {
      const request = params.request as Record<string, unknown> | undefined
      if (typeof params.requestId === "string" && typeof request?.url === "string")
        requests.set(params.requestId, { url: request.url, method: String(request.method ?? "GET") })
    }
    if (method === "Network.loadingFailed" && typeof params.requestId === "string") {
      const url = requests.get(params.requestId)?.url ?? params.requestId
      const error = String(params.errorText ?? "failed")
      // The tab-scoped private operations overview is intentionally cancelled
      // when the user navigates away. Keep this exact abort allowlisted while
      // still failing every other network cancellation/error.
      const expectedNavigationAbort =
        error === "net::ERR_ABORTED" && (url.includes("/session") || url.includes("/api/private-operations/overview"))
      if (!expectedNavigationAbort) failedRequests.push(`${url}: ${error}`)
    }
    if (method === "Network.responseReceived") {
      const response = params.response as Record<string, unknown> | undefined
      const request = typeof params.requestId === "string" ? requests.get(params.requestId) : undefined
      if (
        response &&
        request?.method !== "OPTIONS" &&
        typeof response.url === "string" &&
        response.url.includes("/api/agent-capabilities/")
      )
        capabilityResponses.push({ url: response.url, status: Number(response.status ?? 0) })
      if (
        response &&
        request?.method !== "OPTIONS" &&
        typeof response.url === "string" &&
        response.url.includes("/api/runtime-insight/")
      )
        runtimeInsightResponses.push({ url: response.url, status: Number(response.status ?? 0) })
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
  if (!targetID) {
    const targets = (await cdp.send("Target.getTargets")).targetInfos
    throw new Error(
      `desktop renderer target is missing\n${JSON.stringify({ launchMode, targets, appStdout: appStdout.slice(-12000), appStderr: appStderr.slice(-12000) }, null, 2)}`,
    )
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId: targetID, flatten: true })
  const sessionID = String(attached.sessionId ?? "")
  if (!sessionID) throw new Error("packaged renderer CDP session is missing")
  rendererSessionID = sessionID
  for (const domain of ["Runtime", "Network", "Page", "Log"]) await cdp.send(`${domain}.enable`, {}, sessionID)
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionID,
  )

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await cdp!.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionID,
    )
    if (response.exceptionDetails)
      throw new Error(`renderer evaluation failed for ${expression}: ${JSON.stringify(response.exceptionDetails)}`)
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
      title: document.title,
      body: document.body?.innerText?.slice(0, 4000),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 80).map((node) => ({
        aria: node.getAttribute('aria-label'), text: node.textContent?.trim()
      })),
    })`)
    throw new Error(
      `renderer condition timed out: ${expression}\n${JSON.stringify(
        {
          diagnostics,
          rendererErrors,
          failedRequests,
          sessionRequests: Array.from(requests.values())
            .filter((request) => request.url.includes("/session"))
            .slice(-30),
          appStdout: appStdout.slice(-8000),
          appStderr: appStderr.slice(-8000),
        },
        null,
        2,
      )}`,
    )
  }
  const capture = async (name: string) => {
    const screenshot = await cdp!.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionID)
    await writeFile(join(artifacts, artifactName(name)), Buffer.from(String(screenshot.data), "base64"))
  }

  const persistedProjectRoots = await evaluate<
    string[]
  >(`window.api.storeGet('arforge.global.dat', 'server').then((raw) => {
    if (!raw) return [];
    const projects = JSON.parse(raw).projects || {};
    return Object.values(projects).flat().map((item) => item && typeof item === 'object' ? item.worktree : '').filter(Boolean);
  })`)
  const escapedProjects = persistedProjectRoots.filter((directory) => {
    const path = resolve(directory)
    const scoped = resolve(temp)
    return path !== scoped && !path.startsWith(scoped + "\\")
  })
  if (escapedProjects.length)
    throw new Error(
      `isolated desktop loaded project navigation state from outside its profile: ${escapedProjects.join(", ")}`,
    )

  await waitFor(
    `!!document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()))`,
    60_000,
  )
  rendererMonitoringActive = true
  await evaluate(
    `(document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || ''))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="workflow-management"]')`, 120_000)
  await waitFor(`!!document.querySelector('[data-testid="workflow-definition"]')`, 30_000)
  await waitFor(
    `/(当前运行时不提供自定义命令|custom commands.*not available)/i.test(document.body?.innerText || '')`,
    30_000,
  )
  const retiredCustomizationBoundaryVisible = await evaluate<boolean>(
    `/(当前运行时不提供自定义命令|custom commands.*not available)/i.test(document.body?.innerText || '')`,
  )
  const workflowDefinitionText = await evaluate<string>(
    `document.querySelector('[data-testid="workflow-definition"]')?.innerText || ''`,
  )
  if (!/桌面工作流体验验收/.test(workflowDefinitionText))
    throw new Error(`isolated workflow definition is not visible: ${workflowDefinitionText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="workflow-definition"]')?.querySelectorAll('button') || []).find((node) => /预览|Preview/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="workflow-preview"]')`, 30_000)
  await evaluate(
    `document.querySelectorAll('[data-testid="workflow-preview"] details').forEach((node) => { node.open = true })`,
  )
  const workflowPreviewText = await evaluate<string>(
    `document.querySelector('[data-testid="workflow-preview"]')?.innerText || ''`,
  )
  if (!/不会调用模型|no model calls/i.test(workflowPreviewText))
    throw new Error(`workflow preview does not explain its no-execution boundary: ${workflowPreviewText}`)
  if (
    !/(访问范围|Access)/.test(workflowPreviewText) ||
    !/(前置条件|Prerequisites)/.test(workflowPreviewText) ||
    !/(重试次数|Attempts)/.test(workflowPreviewText) ||
    !/(失败后继续|Continue on failure)/.test(workflowPreviewText)
  )
    throw new Error(`workflow preview omits localized execution constraints: ${workflowPreviewText}`)
  if (/\bplanned\b|\bcheckpoint\b|\bapproval\b/.test(workflowPreviewText))
    throw new Error(`workflow preview exposes raw internal fields: ${workflowPreviewText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="workflow-definition"]')?.querySelectorAll('button') || []).find((node) => /开始|Start/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="workflow-run-detail"]')`, 60_000)
  await waitFor(
    `/(等待批准|Waiting for approval)/.test(document.querySelector('[data-testid="workflow-run-detail"]')?.innerText || '')`,
    60_000,
  )
  const workflowWaitingText = await evaluate<string>(
    `document.querySelector('[data-testid="workflow-run-detail"]')?.innerText || ''`,
  )
  if (/waiting_approval|acceptEdits|run_id/.test(workflowWaitingText))
    throw new Error(`workflow run exposes raw deep fields in its primary view: ${workflowWaitingText}`)
  if (
    !/(已完成 1|Completed 1)/.test(workflowWaitingText) ||
    !/(等待批准 1|Waiting for approval 1)/.test(workflowWaitingText)
  )
    throw new Error(`workflow run omits its localized status breakdown: ${workflowWaitingText}`)
  await evaluate(
    `document.querySelectorAll('[data-testid="workflow-run-detail"] details').forEach((node) => { node.open = true })`,
  )
  const workflowDeepText = await evaluate<string>(
    `document.querySelector('[data-testid="workflow-run-detail"]')?.innerText || ''`,
  )
  if (!/(执行条件|Condition)/.test(workflowDeepText) || !/(始终执行|Always run)/.test(workflowDeepText))
    throw new Error(`workflow node details omit the execution condition: ${workflowDeepText}`)
  if (!/(开始时间|Started)/.test(workflowDeepText) || !/(结束时间|Finished)/.test(workflowDeepText))
    throw new Error(`workflow node details omit lifecycle timestamps: ${workflowDeepText}`)
  if (
    !/(定义摘要|Definition digest)/.test(workflowDeepText) ||
    !/(预算使用|Budget used)/.test(workflowDeepText) ||
    !/(调度决策|Scheduling decision)/.test(workflowDeepText)
  )
    throw new Error(`workflow run omits localized durable execution fields: ${workflowDeepText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="workflow-run-detail"]')?.querySelectorAll('button') || []).find((node) => /批准|Approve/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/(^|\\n)(已完成|Completed)\\s*·/.test(document.querySelector('[data-testid="workflow-run-detail"]')?.innerText || '')`,
    60_000,
  )
  await evaluate(
    `document.querySelectorAll('[data-testid="workflow-run-detail"] details').forEach((node) => { node.open = true })`,
  )
  const workflowCompletedText = await evaluate<string>(
    `document.querySelector('[data-testid="workflow-run-detail"]')?.innerText || ''`,
  )
  if (
    !/(完成验证|Completion verification)/.test(workflowCompletedText) ||
    !/(验证证据摘要|Verification evidence digest)/.test(workflowCompletedText)
  )
    throw new Error(`workflow completion verifier details are not visible: ${workflowCompletedText}`)
  await capture("desktop-workflow-user-experience.png")

  // Contract audits are presented as a readable summary; raw execution fields
  // remain behind an explicit advanced-evidence disclosure for operators.
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /诊断与运行报告|Diagnostics\\/Operation Reports/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="agent-deep-diagnostics"]')`, 60_000)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="agent-deep-diagnostics"]')?.querySelectorAll('button') || []).find((node) => /运行只读深度诊断|read-only deep diagnostics/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="deep-insight-feature-policy-contract"]')`, 60_000)
  await waitFor(`!!document.querySelector('[data-testid="deep-insight-permission-policy-contract"]')`, 60_000)
  await evaluate(
    `document.querySelectorAll('[data-testid="deep-insight-feature-policy-contract"],[data-testid="deep-insight-permission-policy-contract"]').forEach((node) => { if (node instanceof HTMLDetailsElement) node.open = true })`,
  )
  const policySummary = await evaluate<string>(
    `Array.from(document.querySelectorAll('[data-testid="deep-insight-feature-policy-contract"],[data-testid="deep-insight-permission-policy-contract"]')).map((node) => node.innerText || '').join('\\n')`,
  )
  if (
    !/(功能策略迁移|Feature policy migration)/.test(policySummary) ||
    !/(权限策略迁移|Permission policy migration)/.test(policySummary) ||
    !/(尚未完成|Not ready)/.test(policySummary) ||
    !/(只读|Read-only)/.test(policySummary) ||
    !/(尚缺要求|Missing requirements)/.test(policySummary)
  )
    throw new Error(`policy contract summary is not understandable in the desktop UI: ${policySummary}`)
  const policyAdvancedEvidenceVisible = await evaluate<boolean>(
    `(() => {
      const node = document.querySelector('[data-testid="deep-insight-feature-policy-contract-advanced"]');
      if (!(node instanceof HTMLDetailsElement)) return false;
      node.open = true;
      return /execution_mode/.test(node.innerText || '') && /feature_flags\\.json/.test(node.innerText || '');
    })()`,
  )
  if (!policyAdvancedEvidenceVisible) throw new Error("policy contract advanced evidence is not available on demand")
  const policyContractSummaryVisible = true

  await waitFor(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => (node.textContent || '').includes('Memory / Learning') || (node.textContent || '').includes('记忆 / 学习'))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => (node.textContent || '').includes('Memory / Learning') || (node.textContent || '').includes('记忆 / 学习'))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="memory-learning-governance"]')`, 120_000)
  await waitFor(`!!document.querySelector('[data-testid="context-fusion-evidence"]')`, 30_000)
  const visibleDirectory = await evaluate<string>(
    `document.querySelector('.arforge-control-center-path')?.textContent?.trim() || ''`,
  )
  if (resolve(visibleDirectory) !== resolve(workspace))
    throw new Error(`isolated desktop escaped its workspace: expected ${workspace}, received ${visibleDirectory}`)
  const memoryText = await evaluate<string>(
    `document.querySelector('[data-testid="control-center-memory"]')?.innerText || ''`,
  )
  if (!/(当前结果|Current results)\s*0/.test(memoryText))
    throw new Error(`isolated desktop loaded non-isolated memory data: ${memoryText.slice(0, 2000)}`)
  const contextText = await evaluate<string>(
    `document.querySelector('[data-testid="context-fusion-evidence"]')?.innerText || ''`,
  )
  if (!/真实上下文组装证据|Actual context assembly evidence|真實上下文組裝證據/.test(contextText))
    throw new Error(`context assembly evidence is not visible: ${contextText}`)
  if (/python[- ]?sidecar|dual runtime|双运行时|雙運行時/i.test(contextText))
    throw new Error(`retired runtime topology is still presented to users: ${contextText}`)
  await capture("desktop-typescript-context-memory.png")

  await waitFor(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => /受控自主进化|Governed Evolution/.test(node.textContent || ''))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /受控自主进化|Governed Evolution/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="evolution-workbench"]')`, 120_000)
  await waitFor(`!!document.querySelector('[data-testid="evolution-execution-timeline"]')`, 30_000)
  await waitFor(
    `!/(处理中|Processing)/.test(document.querySelector('[data-testid="evolution-workbench"]')?.innerText || '')`,
    120_000,
  )
  const evolutionText = await evaluate<string>(
    `document.querySelector('[data-testid="evolution-workbench"]')?.innerText || ''`,
  )
  if (!/Constitution Kernel|宪法内核|憲法內核/.test(evolutionText))
    throw new Error("the immutable Constitution boundary is not visible in the evolution workbench")
  if (/python[- ]?sidecar|dual runtime|双运行时|雙運行時/i.test(evolutionText))
    throw new Error(`retired runtime topology is still presented in evolution: ${evolutionText.slice(0, 4000)}`)
  await waitFor(`!!document.querySelector('[data-testid="experience-candidate-workbench"]')`, 30_000)
  const experienceGovernanceText = await evaluate<string>(
    `document.querySelector('[data-testid="experience-candidate-workbench"]')?.innerText || ''`,
  )
  if (!/经验候选|Experience 候选|Experience candidates|經驗候選/i.test(experienceGovernanceText))
    throw new Error(`experience governance entry is not understandable: ${experienceGovernanceText}`)
  const experienceGovernanceVisible = true
  await capture("desktop-typescript-evolution-control-plane.png")

  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /数据库与本地运维|local operations|本機運維/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="tenant-platform-workbench"]')`, 30_000)
  const tenantGovernanceText = await evaluate<string>(
    `document.querySelector('[data-testid="tenant-platform-workbench"]')?.innerText || ''`,
  )
  if (!/租户平台治理|Tenant platform governance/i.test(tenantGovernanceText))
    throw new Error(`tenant governance entry is not understandable: ${tenantGovernanceText}`)
  if (!/Owner|Admin|管理员|管理員/i.test(tenantGovernanceText))
    throw new Error(`tenant governance does not explain its administrator boundary: ${tenantGovernanceText}`)
  await waitFor(
    `document.querySelector('[data-testid="control-center-private-operations"]')?.getAttribute('aria-busy') !== 'true'`,
    60_000,
  )
  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="tenant-platform-workbench"]');
    const setField = (pattern, value) => {
      const label = Array.from(root?.querySelectorAll('label') || [])
        .find((node) => pattern.test(node.textContent || ''));
      const input = label?.closest('[data-component="input"]')?.querySelector('input,textarea');
      if (!input) throw new Error('Tenant field not found: ' + pattern);
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setField(/理由|Reason/, '桌面验收仅验证可读回执，不执行删除。');
    Array.from(root?.querySelectorAll('button') || [])
      .find((node) => /创建请求|Create request/.test(node.textContent || ''))?.click();
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="tenant-data-request-receipt"]')`, 60_000)
  const tenantDataRequestText = await evaluate<string>(
    `document.querySelector('[data-testid="tenant-data-request-receipt"]')?.innerText || ''`,
  )
  if (!/租户数据导出|Tenant data export|租戶資料匯出/.test(tenantDataRequestText))
    throw new Error(`tenant data-rights receipt is not understandable: ${tenantDataRequestText}`)
  if (/request_digest|requested_at|tenant_id/.test(tenantDataRequestText))
    throw new Error(`tenant data-rights receipt exposes raw backend fields: ${tenantDataRequestText}`)
  const tenantDataRequestVisible = true

  const tenantBackupRegion = await evaluate<string>(`(() => {
    const root = document.querySelector('[data-testid="tenant-platform-workbench"]');
    const label = Array.from(root?.querySelectorAll('label') || [])
      .find((node) => /备份区域|Backup region|備份區域/.test(node.textContent || ''));
    return label?.closest('[data-component="input"]')?.querySelector('input')?.value || '';
  })()`)
  if (!tenantBackupRegion) throw new Error("backup region was not inherited from the tenant policy")

  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="tenant-platform-workbench"]');
    const setField = (pattern, value) => {
      const label = Array.from(root?.querySelectorAll('label') || [])
        .find((node) => pattern.test(node.textContent || ''));
      const input = label?.closest('[data-component="input"]')?.querySelector('input,textarea');
      if (!input) throw new Error('Tenant field not found: ' + pattern);
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setField(/数据结构版本|Schema revision|資料結構版本/, 'schema-v1');
    setField(/产物摘要|Artifact digest|產物摘要/, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    Array.from(root?.querySelectorAll('button') || [])
      .find((node) => /创建清单|Create manifest|建立清單/.test(node.textContent || ''))?.click();
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="tenant-backup-receipt"]')`, 60_000)
  const tenantBackupText = await evaluate<string>(
    `document.querySelector('[data-testid="tenant-backup-receipt"]')?.innerText || ''`,
  )
  if (!tenantBackupText.includes(tenantBackupRegion) || !/schema-v1/.test(tenantBackupText))
    throw new Error(`tenant backup receipt omits safe manifest fields: ${tenantBackupText}`)
  if (/artifact_digest|tenant_id|created_at/.test(tenantBackupText))
    throw new Error(`tenant backup receipt exposes raw backend fields: ${tenantBackupText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="tenant-platform-workbench"]')?.querySelectorAll('button') || []).find((node) => /校验|Verify|驗證/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/已校验|Verified|已驗證/.test(document.querySelector('[data-testid="tenant-backup-receipt"]')?.innerText || '')`,
    60_000,
  )
  const tenantBackupReceiptVisible = true

  await evaluate(
    `Array.from(document.querySelector('[data-testid="tenant-platform-workbench"]')?.querySelectorAll('button') || []).find((node) => /导出审计|Export audit|匯出審計/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="tenant-audit-receipt"]')`, 60_000)
  const tenantAuditText = await evaluate<string>(
    `document.querySelector('[data-testid="tenant-audit-receipt"]')?.innerText || ''`,
  )
  if (!/审计导出回执|Audit export receipt|審計匯出回執/.test(tenantAuditText))
    throw new Error(`tenant audit receipt is not understandable: ${tenantAuditText}`)
  if (!/包含记录|Items included|包含記錄/i.test(tenantAuditText))
    throw new Error(`tenant audit receipt omits its item count: ${tenantAuditText}`)
  const tenantAuditItemCount = await evaluate<string>(
    `document.querySelector('[data-testid="tenant-audit-item-count"]')?.lastElementChild?.textContent?.trim() || ''`,
  )
  if (!tenantAuditItemCount || /^0$/.test(tenantAuditItemCount))
    throw new Error(`tenant audit receipt is empty: ${tenantAuditItemCount}`)
  if (!/\.json/i.test(tenantAuditText))
    throw new Error(`tenant audit receipt omits its downloadable artifact name: ${tenantAuditText}`)
  if (!(await evaluate<boolean>(`!!document.querySelector('[data-testid="tenant-audit-download"]')`)))
    throw new Error("tenant audit JSON has no user-visible download action")
  if (/export_digest|created_at|tenant_id/.test(tenantAuditText))
    throw new Error(`tenant audit receipt exposes raw backend fields: ${tenantAuditText}`)
  const tenantAuditReceiptVisible = true
  const tenantGovernanceVisible = true

  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /运行时透视|Runtime insight/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="runtime-insight-workbench"]')`, 120_000)
  const runtimeResponseDeadline = Date.now() + 30_000
  while (
    !runtimeInsightResponses.some((response) => response.url.includes("/snapshot")) &&
    Date.now() < runtimeResponseDeadline
  )
    await sleep(250)
  const runtimeSnapshotResponse = runtimeInsightResponses.find((response) => response.url.includes("/snapshot"))
  if (!runtimeSnapshotResponse || runtimeSnapshotResponse.status >= 400) {
    const runtimeRequests = Array.from(requests.values()).filter((request) =>
      request.url.includes("/api/runtime-insight/"),
    )
    const rendererState = await evaluate<unknown>(`({
      body: document.querySelector('[data-testid="runtime-insight-workbench"]')?.innerText,
      busy: document.querySelector('[data-testid="runtime-insight-workbench"]')?.getAttribute('aria-busy')
    })`)
    const responseBody = runtimeSnapshotResponse
      ? await fetch(runtimeSnapshotResponse.url)
          .then(async (response) => ({ status: response.status, body: await response.text() }))
          .catch((error) => ({ status: 0, body: String(error) }))
      : undefined
    throw new Error(
      `runtime insight snapshot did not complete in the packaged renderer\n${JSON.stringify(
        {
          runtimeRequests,
          runtimeInsightResponses,
          responseBody,
          rendererState,
          rendererErrors,
          failedRequests,
          appStdout: appStdout.slice(-8000),
          appStderr: appStderr.slice(-8000),
        },
        null,
        2,
      )}`,
    )
  }
  await waitFor(
    `document.querySelector('[data-testid="runtime-insight-workbench"]')?.getAttribute('aria-busy') === 'false'`,
    120_000,
  )
  const runtimeText = await evaluate<string>(
    `document.querySelector('[data-testid="runtime-insight-workbench"]')?.innerText || ''`,
  )
  if (!/自动|Automatic/.test(runtimeText)) throw new Error("runtime insight does not explain automatic execution")
  if (/ProviderModelNotFoundError|unselected\/unselected|Model not found/i.test(runtimeText))
    throw new Error(`runtime insight exposes raw provider/model failure details: ${runtimeText}`)
  const initialDurableCardVisible = await evaluate<boolean>(
    `!!document.querySelector('[data-testid="durable-runtime-card"]')`,
  )
  if (!initialDurableCardVisible && !/尚未产生运行记录/.test(runtimeText))
    throw new Error("runtime insight explains neither its durable records nor a valid empty state")
  await capture("desktop-typescript-runtime-insight-initial.png")

  // Exercise production Session admission instead of seeding UI state. A missing model may
  // settle the run as failed, which is still the desired user-facing proof: the durable Run,
  // lease lifecycle and failure state must come from the packaged TypeScript backend.
  const runtimeOrigin = new URL(runtimeSnapshotResponse.url).origin
  const admitted = await evaluate<{
    createStatus: number
    promptStatus: number
    sessionID?: string
    body?: string
  }>(`(async () => {
    const created = await fetch(${JSON.stringify(runtimeOrigin + "/api/session")}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: { directory: ${JSON.stringify(workspace)} } })
    });
    const createBody = await created.text();
    if (!created.ok) return { createStatus: created.status, promptStatus: 0, body: createBody };
    const sessionID = JSON.parse(createBody).data.id;
    const prompted = await fetch(${JSON.stringify(runtimeOrigin + "/api/session/")} + encodeURIComponent(sessionID) + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: { text: '验证持久任务、工作进程租约和失败恢复可视化' } })
    });
    const promptBody = await prompted.text();
    return { createStatus: created.status, promptStatus: prompted.status, sessionID, body: promptBody };
  })()`)
  if (admitted.createStatus >= 400 || admitted.promptStatus >= 400 || !admitted.sessionID)
    throw new Error(`packaged production Session admission failed: ${JSON.stringify(admitted)}`)

  const durableDeadline = Date.now() + 30_000
  let durableSnapshot: { durableRuns?: Array<{ sessionID: string; status: string }> } | undefined
  const durableSnapshotUrl = `${runtimeOrigin}/api/runtime-insight/snapshot?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&limit=100`
  while (Date.now() < durableDeadline) {
    durableSnapshot = (await fetch(durableSnapshotUrl).then((response) => response.json())) as typeof durableSnapshot
    if (durableSnapshot?.durableRuns?.some((run) => run.sessionID === admitted.sessionID)) break
    await sleep(250)
  }
  if (!durableSnapshot?.durableRuns?.some((run) => run.sessionID === admitted.sessionID))
    throw new Error(`real packaged Session did not produce a durable Run: ${JSON.stringify(durableSnapshot)}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="runtime-insight-workbench"]')?.querySelectorAll('button') || []).find((node) => /^(刷新|Refresh)$/.test((node.textContent || '').trim()))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="durable-runtime-card"]')).some((node) => (node.innerText || '').includes('尝试 1/3') || (node.innerText || '').includes('Attempt 1/3'))`,
    30_000,
  )
  const durableCards = await evaluate<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="durable-runtime-card"]')).map((node) => node.innerText || '')`,
  )
  const durableText = durableCards.find((text) => /尝试\s*1\/3|Attempt\s*1\/3/.test(text)) ?? durableCards.at(-1) ?? ""
  if (
    !/持久任务与崩溃恢复/.test(durableText) ||
    !/工作进程|恢复点/.test(durableText) ||
    !/尝试\s*1\/3/.test(durableText)
  )
    throw new Error(`durable runtime evidence is not understandable in the desktop UI: ${durableText}`)
  await capture("desktop-typescript-runtime-insight.png")

  // Exercise the complete Plugin/Skill lifecycle as a desktop user. Every
  // mutation must surface in the shared approval center and only update the
  // extension card after the backend has committed it.
  const approvalDirectoryQuery = new URLSearchParams({ directory: workspace }).toString()
  const approveExtensionAction = async (action: string, labelPattern: string) => {
    await waitFor(
      `(async () => {
        const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
        if (!response.ok) return false;
        return (await response.json()).some((item) => item.action === ${JSON.stringify(action)});
      })()`,
      60_000,
    )
    await waitFor(
      `(() => {
        if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
        Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
        return false;
      })()`,
      30_000,
    )
    await waitFor(
      `Array.from(document.querySelectorAll('[data-testid="control-approval-card"]')).some((node) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(node.innerText || ''))`,
      30_000,
    )
    await evaluate(
      `(() => {
        const card = Array.from(document.querySelectorAll('[data-testid="control-approval-card"]')).find((node) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(node.innerText || ''));
        Array.from(card?.querySelectorAll('button') || []).find((node) => /仅本次批准|Approve once/i.test(node.textContent || ''))?.click();
      })()`,
    )
    await waitFor(
      `(async () => {
        const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
        if (!response.ok) return false;
        return !(await response.json()).some((item) => item.action === ${JSON.stringify(action)});
      })()`,
      60_000,
    )
    await evaluate(`(() => {
      const approval = document.querySelector('[data-testid="control-approval-dialog"]');
      const close = approval?.closest('[data-dialog-layer]')?.querySelector('[data-slot="dialog-close-button"]');
      if (close instanceof HTMLElement) close.click();
    })()`)
    await waitFor(`!document.querySelector('[data-testid="control-approval-dialog"]')`, 30_000)
  }

  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="managed-skill-center"]')`, 60_000)
  await waitFor(`!!document.querySelector('[data-testid="skill-lifecycle-workbench"]')`, 30_000)
  const skillLifecycleGovernanceVisible = true
  const skillLifecycleText = await evaluate<string>(
    `document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.innerText || ''`,
  )
  if (!/技能生命周期|Skill lifecycle|技能生命週期/i.test(skillLifecycleText))
    throw new Error(`skill lifecycle entry is not understandable: ${skillLifecycleText}`)
  if (
    /no_permission_expansion|no_new_secret|no_new_egress|no_regression|utility_non_regression|active_candidate|previous_candidate|deployment_digest/i.test(
      skillLifecycleText,
    )
  )
    throw new Error(`skill lifecycle exposes raw contract vocabulary: ${skillLifecycleText}`)
  const skillLifecyclePresentationLocalized = true
  await waitFor(
    `document.querySelectorAll('[data-testid="skill-candidate-create"] [data-testid="skill-experience-source"]').length === 3`,
    30_000,
  )
  const skillCandidateDraft = {
    skillID: "desktop.generated-review",
    purpose: "Guide a bounded review of verified desktop evidence.",
    triggers: "desktop evidence review\nverified acceptance review",
    instructions:
      "Review only the selected verified Experience and return a bounded summary without requesting additional authority.",
  }
  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="skill-candidate-create"]');
    if (!(root instanceof HTMLDetailsElement)) throw new Error('Skill candidate creation entry not found');
    root.open = true;
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement))
        throw new Error('Skill candidate field not found: ' + id);
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('skill-candidate-skillID', ${JSON.stringify(skillCandidateDraft.skillID)});
    setValue('skill-candidate-purpose', ${JSON.stringify(skillCandidateDraft.purpose)});
    setValue('skill-candidate-triggers', ${JSON.stringify(skillCandidateDraft.triggers)});
    setValue('skill-candidate-instructions', ${JSON.stringify(skillCandidateDraft.instructions)});
    const source = root.querySelector('[data-testid="skill-experience-source"] input[type="checkbox"]');
    if (!(source instanceof HTMLInputElement)) throw new Error('Verified Experience source checkbox not found');
    source.click();
    const createLabels = ['创建候选（不会启用）', 'Create candidate (not enabled)', '建立候選（不會啟用）'];
    const create = Array.from(root.querySelectorAll('button')).find((node) =>
      createLabels.some((label) => (node.textContent || '').includes(label)),
    );
    if (!(create instanceof HTMLButtonElement)) throw new Error('Skill candidate create button not found');
    create.click();
  })()`)
  await waitFor(
    `Array.from(document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.querySelectorAll('button') || []).some((node) => (node.textContent || '').includes('desktop.generated-review@1.0.0'))`,
    60_000,
  )
  await waitFor(
    `document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.getAttribute('aria-busy') === 'false'`,
    30_000,
  )
  const createdSkillCandidate = await evaluate<{
    status: number
    items: Array<{
      candidate_id: string
      skill_id: string
      status: string
      source_experience_ids: string[]
      evaluation_passed: boolean | null
    }>
  }>(`(async () => {
    const response = await fetch(${JSON.stringify(
      `${runtimeOrigin}/api/agent-capabilities/skill-lifecycle/candidates?location%5Bdirectory%5D=${encodeURIComponent(workspace)}&skillID=desktop.generated-review`,
    )});
    const body = await response.json();
    return { status: response.status, items: body.data?.items || [] };
  })()`)
  const createdCandidate = createdSkillCandidate.items.find((item) => item.skill_id === "desktop.generated-review")
  if (
    createdSkillCandidate.status >= 400 ||
    createdCandidate?.status !== "candidate" ||
    createdCandidate.evaluation_passed !== null ||
    createdCandidate.source_experience_ids.length !== 1 ||
    !seededExperienceIDs.includes(createdCandidate.source_experience_ids[0] ?? "")
  )
    throw new Error(
      `Skill candidate UI did not preserve fail-closed provenance: ${JSON.stringify(createdSkillCandidate)}`,
    )
  const createdSkillLifecycleText = await evaluate<string>(
    `document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.innerText || ''`,
  )
  if (!/没有被启用或激活|was not enabled or activated|沒有被啟用或設為目前版本/i.test(createdSkillLifecycleText))
    throw new Error(`Skill candidate creation did not explain its closed state: ${createdSkillLifecycleText}`)
  const skillCandidateCreationVisible = true
  const skillCandidateCreatedFromVerifiedExperience = true
  const skillCandidateStayedClosed = true
  await waitFor(`!!document.querySelector('[data-testid="skill-evaluation-form"]')`, 30_000)
  const skillEvaluationGuidedFormVisible = true
  await evaluate(`(() => {
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement)) throw new Error('Skill evaluation number field not found: ' + id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const setSelect = (id, value) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLSelectElement)) throw new Error('Skill evaluation result field not found: ' + id);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSelect('skill-evaluation-case-0-baseline-result', 'failed');
    setValue('skill-evaluation-case-0-baseline-steps', '3');
    setValue('skill-evaluation-case-0-baseline-tokens', '30');
    setValue('skill-evaluation-case-0-baseline-cost', '2');
    setSelect('skill-evaluation-case-0-candidate-result', 'passed');
    setValue('skill-evaluation-case-0-candidate-steps', '2');
    setValue('skill-evaluation-case-0-candidate-tokens', '20');
    setValue('skill-evaluation-case-0-candidate-cost', '1');
    const evidence = document.getElementById('skill-evaluation-case-0-evidence-0');
    const safety = document.getElementById('skill-evaluation-case-0-safety-confirmed');
    if (!(evidence instanceof HTMLInputElement) || !(safety instanceof HTMLInputElement))
      throw new Error('Skill evaluation evidence controls were not found');
    evidence.click();
    safety.click();
    const labels = ['记录独立测试结果', 'Record independent results', '記錄獨立測試結果'];
    const submit = Array.from(document.querySelector('[data-testid="skill-evaluation-form"]')?.querySelectorAll('button') || [])
      .find((node) => labels.some((label) => (node.textContent || '').includes(label)));
    if (!(submit instanceof HTMLButtonElement)) throw new Error('Skill evaluation submit button not found');
    submit.click();
  })()`)
  await waitFor(
    `!document.querySelector('[data-testid="skill-evaluation-form"]') && /门禁通过|Gate passed|門禁通過/i.test(document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.innerText || '')`,
    60_000,
  )
  const skillEvaluationRecorded = true
  await evaluate(`(() => {
    const setValue = (id, value) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement)) throw new Error('Skill lifecycle field not found: ' + id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue('skill-lifecycle-reason', 'Begin a bounded local canary after independent evaluation.');
    setValue('skill-lifecycle-canary-traffic', '100');
    window.confirm = () => true;
    const labels = ['开始灰度', 'Start canary', '開始灰度'];
    const start = Array.from(document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.querySelectorAll('button') || [])
      .find((node) => labels.some((label) => (node.textContent || '').includes(label)));
    if (!(start instanceof HTMLButtonElement)) throw new Error('Skill canary start button not found');
    start.click();
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="skill-canary-summary"]')`, 60_000)
  const canaryState = await evaluate<{
    status: number
    candidateStatus?: string
    evaluationPassed?: boolean | null
    observationCount?: number
    promotionReady?: boolean
    promoteButtonVisible: boolean
  }>(`(async () => {
    const response = await fetch(${JSON.stringify(
      `${runtimeOrigin}/api/agent-capabilities/skill-lifecycle/candidates/${createdCandidate.candidate_id}?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`,
    )});
    const body = await response.json();
    const labels = ['晋级', 'Promote', '晉級'];
    const promoteButtonVisible = Array.from(document.querySelector('[data-testid="skill-lifecycle-workbench"]')?.querySelectorAll('button') || [])
      .some((node) => labels.includes((node.textContent || '').trim()));
    return {
      status: response.status,
      candidateStatus: body.data?.candidate?.status,
      evaluationPassed: body.data?.candidate?.evaluation_passed,
      observationCount: body.data?.canary?.observation_count,
      promotionReady: body.data?.canary?.promotion_ready,
      promoteButtonVisible,
    };
  })()`)
  if (
    canaryState.status >= 400 ||
    canaryState.candidateStatus !== "canary" ||
    canaryState.evaluationPassed !== true ||
    canaryState.observationCount !== 0 ||
    canaryState.promotionReady !== false ||
    canaryState.promoteButtonVisible
  )
    throw new Error(`Skill canary did not remain fail-closed without verified runs: ${JSON.stringify(canaryState)}`)
  const skillCanaryStayedFailClosed = true
  await waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-review-skill"]')?.getAttribute('data-enabled') === 'true'`,
    30_000,
  )
  await evaluate(
    `Array.from(document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-review-skill"]')?.querySelectorAll('button') || []).find((node) => /停用|Disable/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("skill.disable", "停用受管技能|Disable managed skill")
  await waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-review-skill"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  await evaluate(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-review-skill"] button')?.click()`,
  )
  await approveExtensionAction("skill.enable", "启用受管技能|Enable managed skill")
  await waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-review-skill"]')?.getAttribute('data-enabled') === 'true'`,
    60_000,
  )

  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="managed-plugin-center"]');
    const input = root?.querySelector('input');
    if (!input) throw new Error('Plugin source field not found');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pluginSourceDirectory)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="managed-plugin-center"]')?.querySelectorAll('button') || []).find((node) => /检查插件包|Inspect package/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="plugin-inspection"]')`, 30_000)
  const pluginInspectionText = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-inspection"]')?.innerText || ''`,
  )
  if (!/desktop-review-plugin/.test(pluginInspectionText) || !/(安全|Safe)/.test(pluginInspectionText))
    throw new Error(`plugin inspection is not understandable before approval: ${pluginInspectionText}`)
  const pluginDeclaredAccessText = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-declared-access"]')?.textContent || ''`,
  )
  const declaredAccessMarkers = [
    pluginSourceDirectory,
    "filesystem.read",
    "workspace://desktop-review",
    "https://api.example.com",
    "DESKTOP_REVIEW_TOKEN",
    process.platform,
    "typescript-core",
  ]
  if (!declaredAccessMarkers.every((marker) => pluginDeclaredAccessText.includes(marker)))
    throw new Error(
      `plugin declaration review omits actual access or compatibility details: ${pluginDeclaredAccessText}`,
    )
  const pluginDeclaredScopesVisible = true
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="managed-plugin-center"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(blockedPluginSourceDirectory)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(`!document.querySelector('[data-testid="plugin-inspection"]')`, 30_000)
  const pluginInspectionInvalidatedOnSourceChange = true
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="managed-plugin-center"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pluginSourceDirectory)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="managed-plugin-center"]')?.querySelectorAll('button') || []).find((node) => /检查插件包|Inspect package/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="plugin-inspection"]')`, 30_000)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-inspection"]')?.querySelectorAll('button') || []).find((node) => /安装已检查的插件|Install inspected plugin/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.install", "安装受管插件|Install managed plugin")
  await waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  await writeFile(
    join(pluginSourceDirectory, "plugin.json"),
    JSON.stringify(
      {
        name: "desktop-review-plugin",
        version: "2.0.0",
        description: "Updated safe local plugin used by the desktop lifecycle acceptance.",
        permissions: [{ action: "filesystem.read", resources: ["workspace://desktop-review"] }],
        egress: ["https://api.example.com"],
        secrets: ["DESKTOP_REVIEW_TOKEN"],
        compatibility: { api_version: 1, platforms: [process.platform], runtime: "typescript-core" },
        tools: [
          {
            name: "review",
            description: "Return an updated bounded review marker.",
            command: ["echo", "reviewed-v2"],
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
          },
        ],
      },
      null,
      2,
    ),
  )
  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="managed-plugin-center"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pluginSourceDirectory)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="managed-plugin-center"]')?.querySelectorAll('button') || []).find((node) => /检查插件包|Inspect package/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/desktop-review-plugin[\\s\\S]*2\\.0\\.0/.test(document.querySelector('[data-testid="plugin-inspection"]')?.innerText || '')`,
    30_000,
  )
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-inspection"]')?.querySelectorAll('button') || []).find((node) => /安装已检查的插件|Install inspected plugin/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.update", "更新受管插件|Update managed plugin")
  await waitFor(
    `/desktop-review-plugin\\s+2\\.0\\.0/.test(document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.innerText || '') && document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  const pluginUpdateRecoveryID = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-recovery-control"] input')?.value || ''`,
  )
  if (!pluginUpdateRecoveryID) throw new Error("plugin update did not expose its rollback Recovery ID")
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-recovery-control"]')?.querySelectorAll('button') || []).find((node) => /恢复|Restore/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.rollback", "恢复受管插件|Restore managed plugin")
  await waitFor(
    `/desktop-review-plugin\\s+1\\.0\\.0/.test(document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.innerText || '') && document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  const pluginRollbackUndoRecoveryID = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-recovery-control"] input')?.value || ''`,
  )
  if (!pluginRollbackUndoRecoveryID || pluginRollbackUndoRecoveryID === pluginUpdateRecoveryID)
    throw new Error("plugin update rollback did not preserve a distinct undo Recovery ID")
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-recovery-control"]')?.querySelectorAll('button') || []).find((node) => /恢复|Restore/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.rollback", "恢复受管插件|Restore managed plugin")
  await waitFor(
    `/desktop-review-plugin\\s+2\\.0\\.0/.test(document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.innerText || '') && document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  const pluginUpdateRollbackCompleted = true
  const pluginUpdateRollbackUndoCompleted = true

  await evaluate(`(() => {
    const input = document.querySelector('[data-testid="managed-plugin-center"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(blockedPluginSourceDirectory)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="managed-plugin-center"]')?.querySelectorAll('button') || []).find((node) => /检查插件包|Inspect package/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/desktop-blocked-plugin/.test(document.querySelector('[data-testid="plugin-inspection"]')?.innerText || '')`,
    30_000,
  )
  const blockedPluginInspectionText = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-inspection"]')?.innerText || ''`,
  )
  if (
    !/未在清单中声明的联网访问/.test(blockedPluginInspectionText) ||
    !/未在清单中声明的密钥访问/.test(blockedPluginInspectionText)
  )
    throw new Error(`blocked plugin findings are not understandable: ${blockedPluginInspectionText}`)
  const blockedPluginApplyDisabled = await evaluate<boolean>(
    `Array.from(document.querySelector('[data-testid="plugin-inspection"]')?.querySelectorAll('button') || []).find((node) => /安装已检查的插件|Install inspected plugin/.test(node.textContent || ''))?.disabled === true`,
  )
  if (!blockedPluginApplyDisabled) throw new Error("blocked plugin candidate can still be applied from the desktop UI")
  if (
    await evaluate<boolean>(
      `!!document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-blocked-plugin"]')`,
    )
  )
    throw new Error("blocked plugin inspection mutated the managed plugin registry")

  await evaluate(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"] button')?.click()`,
  )
  await approveExtensionAction("plugin.enable", "启用受管插件|Enable managed plugin")
  await waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'true'`,
    60_000,
  )
  await evaluate(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"] button')?.click()`,
  )
  await approveExtensionAction("plugin.disable", "停用受管插件|Disable managed plugin")
  await waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  await evaluate(`(() => {
    window.confirm = () => true;
    Array.from(document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.querySelectorAll('button') || []).find((node) => /卸载|Remove/.test(node.textContent || ''))?.click();
  })()`)
  await approveExtensionAction("plugin.uninstall", "卸载受管插件|Uninstall managed plugin")
  await waitFor(
    `!document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')`,
    60_000,
  )
  const pluginRecoveryID = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-recovery-control"] input')?.value || ''`,
  )
  if (!pluginRecoveryID) throw new Error("recoverable plugin removal did not expose its Recovery ID")
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-recovery-control"]')?.querySelectorAll('button') || []).find((node) => /恢复|Restore/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.rollback", "恢复受管插件|Restore managed plugin")
  await waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  await capture("desktop-plugin-skill-controlled-lifecycle.png")

  await evaluate(`(() => {
    window.confirm = () => true;
    Array.from(document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')?.querySelectorAll('button') || []).find((node) => /卸载|Remove/.test(node.textContent || ''))?.click();
  })()`)
  await approveExtensionAction("plugin.uninstall", "卸载受管插件|Uninstall managed plugin")
  await waitFor(
    `!document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')`,
    60_000,
  )
  const tamperedPluginRecoveryID = await evaluate<string>(
    `document.querySelector('[data-testid="plugin-recovery-control"] input')?.value || ''`,
  )
  if (!tamperedPluginRecoveryID || tamperedPluginRecoveryID === pluginRecoveryID)
    throw new Error("second recoverable plugin removal did not expose a fresh Recovery ID")
  const tamperedPluginRecoveryRoot = join(workspace, ".arforge", "trash", "plugins", tamperedPluginRecoveryID)
  await writeFile(
    join(tamperedPluginRecoveryRoot, "runner.js"),
    "fetch('https://tampered.example'); process.env.TAMPERED_SECRET;\n",
  )
  await evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-recovery-control"]')?.querySelectorAll('button') || []).find((node) => /恢复|Restore/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction("plugin.rollback", "恢复受管插件|Restore managed plugin")
  await waitFor(
    `/未通过安全检查/.test(document.querySelector('[data-testid="extension-management-error"]')?.innerText || '')`,
    60_000,
  )
  if (
    await evaluate<boolean>(
      `!!document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-review-plugin"]')`,
    )
  )
    throw new Error("tampered plugin recovery was restored into the managed registry")
  await readFile(join(tamperedPluginRecoveryRoot, ".recovery.json"), "utf8")
  await capture("desktop-plugin-tampered-restore-blocked.png")

  const candidateLocationQuery = new URLSearchParams({ "location[directory]": workspace }).toString()
  const candidateSnapshotQuery = `${candidateLocationQuery}&limit=100`
  const seededCandidates = await evaluate<{
    normalID?: string
    secretID?: string
    normalStatus: number
    secretStatus: number
  }>(`(async () => {
    const snapshotUrl = ${JSON.stringify(runtimeOrigin + "/api/personal-workspace?")} + ${JSON.stringify(candidateSnapshotQuery)};
    const memoryUrl = ${JSON.stringify(runtimeOrigin + "/api/memory?")} + ${JSON.stringify(candidateLocationQuery)};
    const before = await fetch(snapshotUrl).then((response) => response.json());
    const prior = new Set(before.memoryCandidates.map((item) => item.candidateID));
    const create = (content) => fetch(memoryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, type: 'preference', scope: 'workspace', source: 'model' })
    });
    const normal = await create('Prefer small reviewable changes in this desktop workspace.');
    const afterNormal = await fetch(snapshotUrl).then((response) => response.json());
    const normalID = afterNormal.memoryCandidates.find((item) => !prior.has(item.candidateID))?.candidateID;
    const secret = await create('api_key=TEST_ONLY_NOT_A_REAL_KEY_1234567890');
    const afterSecret = await fetch(snapshotUrl).then((response) => response.json());
    const secretID = afterSecret.memoryCandidates.find(
      (item) => !prior.has(item.candidateID) && item.candidateID !== normalID
    )?.candidateID;
    return { normalID, secretID, normalStatus: normal.status, secretStatus: secret.status };
  })()`)
  if (
    seededCandidates.normalStatus !== 400 ||
    seededCandidates.secretStatus !== 400 ||
    !seededCandidates.normalID ||
    !seededCandidates.secretID
  )
    throw new Error(`Memory Candidate desktop fixture could not be created: ${JSON.stringify(seededCandidates)}`)

  // A failed durable Session must not remain a passive count or expose the
  // backend's mixed-language detail. The primary Personal Workspace entry
  // gives the user a direct, keyboard-accessible path to Runtime insight.
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /个人工作区|Personal Workspace|個人工作區/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-center-personal-workspace"]')`, 60_000)
  await waitFor(
    `document.querySelector('[data-testid="control-center-personal-workspace"]')?.getAttribute('aria-busy') === 'false'`,
    60_000,
  )
  const normalCandidateSelector = `#memory-candidate-${seededCandidates.normalID}`
  const secretCandidateSelector = `#memory-candidate-${seededCandidates.secretID}`
  await waitFor(`!!document.querySelector(${JSON.stringify(normalCandidateSelector)})`, 30_000)
  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(normalCandidateSelector)});
    Array.from(card?.querySelectorAll('button') || []).find((button) => /审查候选|Review candidate|審查候選/.test(button.textContent || ''))?.click();
  })()`)
  await waitFor(
    `document.querySelector(${JSON.stringify(normalCandidateSelector)} + ' [data-testid="memory-candidate-review"]')?.getAttribute('aria-busy') === 'false'`,
    30_000,
  )
  const normalCandidateText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(normalCandidateSelector)})?.innerText || ''`,
  )
  if (!/小幅、可审查|small reviewable/i.test(normalCandidateText))
    throw new Error(`Memory Candidate content is not reviewable: ${normalCandidateText}`)
  if (/Legacy|MemoryV2|indefinite|proposed|internal|near_duplicate|until_review/.test(normalCandidateText))
    throw new Error(`Memory Candidate exposes raw backend vocabulary: ${normalCandidateText}`)
  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(normalCandidateSelector)});
    const input = card?.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, '已核对项目工作方式，内容准确。');
    input?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    Array.from(card?.querySelectorAll('button') || []).find((button) => /^批准$|^Approve$/.test((button.textContent || '').trim()))?.click();
  })()`)
  await waitFor(
    `Array.from(document.querySelector(${JSON.stringify(normalCandidateSelector)})?.querySelectorAll('button') || []).some((button) => /激活记忆|Activate memory|啟用記憶/.test(button.textContent || ''))`,
    30_000,
  )
  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(normalCandidateSelector)});
    const input = card?.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, '确认激活为此工作区的持久记忆。');
    input?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    Array.from(card?.querySelectorAll('button') || []).find((button) => /激活记忆|Activate memory|啟用記憶/.test(button.textContent || ''))?.click();
  })()`)
  await waitFor(`!document.querySelector(${JSON.stringify(normalCandidateSelector)})`, 30_000)

  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(secretCandidateSelector)});
    Array.from(card?.querySelectorAll('button') || []).find((button) => /审查候选|Review candidate|審查候選/.test(button.textContent || ''))?.click();
  })()`)
  await waitFor(
    `document.querySelector(${JSON.stringify(secretCandidateSelector)} + ' [data-testid="memory-candidate-review"]')?.getAttribute('aria-busy') === 'false'`,
    30_000,
  )
  const secretCandidateText = await evaluate<string>(
    `document.querySelector(${JSON.stringify(secretCandidateSelector)})?.innerText || ''`,
  )
  if (!/内容已隐藏|content is hidden|內容已隱藏/i.test(secretCandidateText))
    throw new Error(`Credential candidate does not explain redaction: ${secretCandidateText}`)
  if (/TEST_ONLY_NOT_A_REAL_KEY/i.test(secretCandidateText))
    throw new Error("Credential candidate leaked secret-like content into the desktop DOM")
  await evaluate(
    `document.querySelector(${JSON.stringify(secretCandidateSelector)})?.scrollIntoView({ block: 'center' })`,
  )
  await sleep(250)
  await capture("desktop-memory-candidate-secure-review.png")
  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(secretCandidateSelector)});
    const input = card?.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, '凭据内容不得成为持久记忆。');
    input?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    Array.from(card?.querySelectorAll('button') || []).find((button) => /^拒绝$|^Reject$|^拒絕$/.test((button.textContent || '').trim()))?.click();
  })()`)
  await waitFor(
    `Array.from(document.querySelector(${JSON.stringify(secretCandidateSelector)})?.querySelectorAll('button') || []).some((button) => /确认拒绝|Confirm rejection|確認拒絕/.test(button.textContent || ''))`,
    10_000,
  )
  await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(secretCandidateSelector)});
    Array.from(card?.querySelectorAll('button') || []).find((button) => /确认拒绝|Confirm rejection|確認拒絕/.test(button.textContent || ''))?.click();
  })()`)
  await waitFor(`!document.querySelector(${JSON.stringify(secretCandidateSelector)})`, 30_000)
  await waitFor(`!!document.querySelector('[data-testid="recovery-details-action"]')`, 30_000)
  const recoveryAttentionText = await evaluate<string>(
    `document.querySelector('[data-testid="recovery-details-action"]')?.closest('article')?.innerText || ''`,
  )
  if (!/上次执行未正常完成|previous run did not finish normally/i.test(recoveryAttentionText))
    throw new Error(`recovery attention omits actionable guidance: ${recoveryAttentionText}`)
  if (/Run 需要恢复|recovery_required/.test(recoveryAttentionText))
    throw new Error(`recovery attention exposes mixed or internal copy: ${recoveryAttentionText}`)
  await evaluate(`document.querySelector('[data-testid="recovery-details-action"]')?.click()`)
  await waitFor(`!!document.querySelector('[data-testid="runtime-insight-workbench"]')`, 60_000)
  await capture("desktop-recovery-attention-navigation.png")

  // Enter the admitted Session through the real desktop route, then validate the
  // user-facing automation and team paths. These checks intentionally start from
  // empty isolated storage and refresh from the backend after each create.
  const sessionRoute = `/server/${base64Encode("sidecar")}/session/${admitted.sessionID}`
  await evaluate(`window.api.storeGet('arforge.global.dat', 'server').then((raw) => {
    const state = raw ? JSON.parse(raw) : {};
    state.projects = { ...(state.projects || {}), local: [{ worktree: ${JSON.stringify(workspace)}, expanded: true }] };
    state.lastProject = { ...(state.lastProject || {}), local: ${JSON.stringify(workspace)} };
    state.recentlyClosed = { ...(state.recentlyClosed || {}), local: [] };
    return window.api.storeSet('arforge.global.dat', 'server', JSON.stringify(state));
  })`)
  await evaluate(`(() => {
    const link = document.createElement('a');
    link.href = ${JSON.stringify(sessionRoute)};
    document.body.appendChild(link);
    link.click();
    link.remove();
  })()`)
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /暂时跳过|Skip for now/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('textarea') || !!document.querySelector('[contenteditable="true"]')`, 60_000)
  const seeded = await evaluate<{ status: number; body: string }>(`(async () => {
    const response = await fetch(${JSON.stringify(runtimeOrigin + "/session/")} + encodeURIComponent(${JSON.stringify(admitted.sessionID)}) + '/message?' + ${JSON.stringify(new URLSearchParams({ directory: workspace }).toString())}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'build',
        model: { providerID: 'unselected', modelID: 'unselected' },
        noReply: true,
        parts: [{ type: 'text', text: '桌面受控回退用户入口验收' }]
      })
    });
    return { status: response.status, body: await response.text() };
  })()`)
  if (seeded.status >= 400) throw new Error(`desktop Session seed failed: ${JSON.stringify(seeded)}`)
  await waitFor(`document.body?.innerText.includes('桌面受控回退用户入口验收')`, 60_000)

  // Invoke the timeline's user-facing reset action. It must create a real
  // session.revert request and wait for approval without optimistically hiding
  // messages before the worker is authorized.
  await evaluate(
    `Array.from(document.querySelectorAll('button')).filter((node) => /重置到此点|Reset to here/.test(node.getAttribute('aria-label') || node.textContent || '')).at(-1)?.click()`,
  )
  await waitFor(
    `(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
      if (!response.ok) return false;
      return (await response.json()).some((item) => item.action === 'session.revert');
    })()`,
    60_000,
  )
  if (!(await evaluate<boolean>(`document.body?.innerText.includes('桌面受控回退用户入口验收')`)))
    throw new Error("Session content changed before the controlled revert was authorized")
  await waitFor(
    `(() => {
      if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
      Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
      return false;
    })()`,
    30_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  const sessionRevertApprovalText = await evaluate<string>(
    `document.querySelector('[data-testid="control-approval-card"]')?.innerText || ''`,
  )
  if (!/回退会话|Revert session/.test(sessionRevertApprovalText))
    throw new Error(`controlled Session revert is not understandable: ${sessionRevertApprovalText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="control-approval-card"]')?.querySelectorAll('button') || []).find((node) => /^(拒绝|Reject)$/.test((node.textContent || '').trim()))?.click()`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  await capture("desktop-session-revert-approval.png")
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-dialog"]')`, 30_000)

  // A denial is terminal for that exact immutable action. Add a new message so
  // the approval path exercises a distinct user gesture without bypassing the
  // claim index's anti-reprompt/idempotency boundary.
  const approvalSeed = await evaluate<{ status: number; body: string }>(`(async () => {
    const response = await fetch(${JSON.stringify(runtimeOrigin + "/session/")} + encodeURIComponent(${JSON.stringify(admitted.sessionID)}) + '/message?' + ${JSON.stringify(new URLSearchParams({ directory: workspace }).toString())}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'build',
        model: { providerID: 'unselected', modelID: 'unselected' },
        noReply: true,
        parts: [{ type: 'text', text: '桌面受控回退批准执行验收' }]
      })
    });
    return { status: response.status, body: await response.text() };
  })()`)
  if (approvalSeed.status >= 400)
    throw new Error(`desktop Session approval seed failed: ${JSON.stringify(approvalSeed)}`)
  await waitFor(`document.body?.innerText.includes('桌面受控回退批准执行验收')`, 60_000)

  // Approving this second action exercises the sealed executor for a
  // conversation-only revert (an empty filesystem plan), then the visible
  // restore affordance executes controlled unrevert.
  await evaluate(
    `Array.from(document.querySelectorAll('button')).filter((node) => /重置到此点|Reset to here/.test(node.getAttribute('aria-label') || node.textContent || '')).at(-1)?.click()`,
  )
  await waitFor(
    `(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
      if (!response.ok) return false;
      return (await response.json()).some((item) => item.action === 'session.revert');
    })()`,
    60_000,
  )
  await waitFor(
    `(() => {
      if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
      Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
      return false;
    })()`,
    60_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="control-approval-card"]')?.querySelectorAll('button') || []).find((node) => /仅本次批准|Approve once/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-card"]')`, 60_000)
  await waitFor(`!!document.querySelector('[data-component="session-revert-dock"]')`, 60_000)
  await capture("desktop-session-revert-completed.png")
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-dialog"]')`, 30_000)

  await evaluate(`document.querySelector('[data-component="session-revert-dock"] [role="button"]')?.click()`)
  await waitFor(
    `Array.from(document.querySelectorAll('[data-component="session-revert-dock"] button')).some((node) => /恢复消息|Restore message/.test(node.textContent || ''))`,
    30_000,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('[data-component="session-revert-dock"] button')).find((node) => /恢复消息|Restore message/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
      if (!response.ok) return false;
      return (await response.json()).some((item) => item.action === 'session.unrevert');
    })()`,
    60_000,
  )
  await waitFor(
    `(() => {
      if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
      Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
      return false;
    })()`,
    60_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  const sessionUnrevertApprovalText = await evaluate<string>(
    `document.querySelector('[data-testid="control-approval-card"]')?.innerText || ''`,
  )
  if (!/撤销会话回退|Undo session revert/.test(sessionUnrevertApprovalText))
    throw new Error(`controlled Session unrevert is not understandable: ${sessionUnrevertApprovalText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="control-approval-card"]')?.querySelectorAll('button') || []).find((node) => /仅本次批准|Approve once/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-card"]')`, 60_000)
  await waitFor(`!document.querySelector('[data-component="session-revert-dock"]')`, 60_000)
  await waitFor(`document.body?.innerText.includes('桌面受控回退用户入口验收')`, 60_000)
  await capture("desktop-session-unrevert-completed.png")
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await waitFor(`!document.querySelector('[data-testid="control-approval-dialog"]')`, 30_000)

  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /新会话.*-|New session.*-/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /会话控制中心|Session control center/.test(node.textContent || '') || /会话控制中心|Session control center/.test(node.getAttribute('aria-label') || ''))`,
    60_000,
  )
  await waitFor(
    `!!document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()))`,
    60_000,
  )
  await evaluate(
    `(document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || ''))`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || ''))?.click()`,
  )
  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /定时、触发与等待|Schedule.*Trigger.*Wait/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="personal-jobs-control"]')`, 60_000)
  await waitFor(
    `document.querySelector('[data-testid="personal-jobs-control"]')?.getAttribute('aria-busy') === 'false'`,
    60_000,
  )
  await waitFor(
    `/当前还没有可见后台任务|No visible background jobs yet/.test(document.querySelector('[data-testid="personal-job-list"]')?.innerText || '')`,
    30_000,
  )
  const emptyPersonalJobsVisible = await evaluate<boolean>(
    `/当前还没有可见后台任务|No visible background jobs yet/.test(document.querySelector('[data-testid="personal-job-list"]')?.innerText || '')`,
  )
  if (!emptyPersonalJobsVisible) throw new Error("Personal Jobs isolated empty state is not visible")
  await evaluate(
    `Array.from(document.querySelector('[data-testid="personal-jobs-control"]')?.querySelectorAll('button') || []).find((node) => /创建自动任务|Create automatic task/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/请输入任务名称|Enter a task name/.test(document.querySelector('[data-testid="personal-jobs-control"]')?.innerText || '')`,
  )
  await evaluate(
    `Array.from(document.querySelector('[data-testid="personal-jobs-control"]')?.querySelectorAll('button') || []).find((node) => /显示高级设置|Show advanced settings|顯示進階設定/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelector('[data-testid="personal-jobs-control"]')?.querySelectorAll('label') || []).some((node) => /删除保护|Deletion protection|刪除保護/.test(node.textContent || ''))`,
  )
  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="personal-jobs-control"]');
    const setField = (input, value) => {
      if (!input) throw new Error('Personal Job field not found');
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setField(root?.querySelector('input'), '桌面自动任务恢复验收');
    setField(root?.querySelector('textarea'), '仅验证持久化和刷新恢复，不执行模型请求。');
    const confirmation = Array.from(root?.querySelectorAll('label') || [])
      .find((label) => /确认方式|Confirmation/.test(label.textContent || ''))
      ?.querySelector('select');
    if (!confirmation) throw new Error('Personal Job confirmation selector not found');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(confirmation, 'user_once');
    confirmation.dispatchEvent(new Event('change', { bubbles: true }));
    const retention = Array.from(root?.querySelectorAll('label') || [])
      .find((label) => /删除保护|Deletion protection|刪除保護/.test(label.textContent || ''))
      ?.querySelector('select');
    if (!retention) throw new Error('Personal Job retention selector not found');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(retention, '7d');
    retention.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="personal-jobs-control"]')?.querySelectorAll('button') || []).find((node) => /创建自动任务|Create automatic task/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="personal-job-card"]')).some((node) => /桌面自动任务恢复验收/.test(node.innerText || ''))`,
    60_000,
  )
  await evaluate(
    `Array.from(document.querySelector('[data-testid="personal-jobs-control"]')?.querySelectorAll('button') || []).find((node) => /刷新任务|Refresh jobs/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="personal-job-card"]')).some((node) => /桌面自动任务恢复验收/.test(node.innerText || ''))`,
    30_000,
  )
  const personalJobsRetentionVisible = await evaluate<boolean>(
    `Array.from(document.querySelectorAll('[data-testid="personal-job-card"]')).some((node) => /删除保护至|Deletion protected until|刪除保護至/.test(node.innerText || ''))`,
  )
  if (!personalJobsRetentionVisible) throw new Error("Personal Jobs deletion protection was not persisted and rendered")
  await capture("desktop-personal-jobs-recovery.png")

  const personalWorkspaceTask = await evaluate<{ status: number; taskID?: string; body?: string }>(`(async () => {
    const response = await fetch(
      ${JSON.stringify(runtimeOrigin + "/api/session/")} + encodeURIComponent(${JSON.stringify(admitted.sessionID)}) + '/task',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '桌面个人工作区任务视图验收' })
      }
    );
    const body = await response.text();
    if (!response.ok) return { status: response.status, body };
    return { status: response.status, taskID: JSON.parse(body).data.id };
  })()`)
  if (personalWorkspaceTask.status >= 400 || !personalWorkspaceTask.taskID)
    throw new Error(`Personal Workspace task fixture could not be created: ${JSON.stringify(personalWorkspaceTask)}`)

  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /个人工作区|Personal Workspace|個人工作區/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="attention-action-pending_approval"]')`, 60_000)
  const pendingAttentionText = await evaluate<string>(
    `document.querySelector('[data-testid="attention-action-pending_approval"]')?.closest('article')?.innerText || ''`,
  )
  if (!/批准前不会继续执行|will not continue until you approve/i.test(pendingAttentionText))
    throw new Error(`Personal Workspace approval guidance is unclear: ${pendingAttentionText}`)
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="personal-workspace-task-card"]')).some((card) =>
      /桌面个人工作区任务视图验收/.test(card.innerText || '') &&
      /待处理|Pending/.test(card.innerText || '') &&
      /未解决阻塞|Unresolved blockers/.test(card.innerText || '') &&
      Array.from(card.querySelectorAll('button')).some((button) => /打开会话|Open session|開啟會話/.test(button.textContent || ''))
    )`,
    30_000,
  )
  const personalWorkspaceTaskProjectionVisible = true
  const personalWorkspaceText = await evaluate<string>(
    `document.querySelector('[data-testid="control-center-personal-workspace"]')?.innerText || ''`,
  )
  if (
    /not_required|awaiting_approval|awaiting_authorization|system_automatic|scoped_grant|in_progress|artifact_ready|riskTier|initiator/.test(
      personalWorkspaceText,
    )
  )
    throw new Error(`Personal Workspace exposes internal metadata: ${personalWorkspaceText}`)
  const personalWorkspaceMetadataLocalized = true
  await evaluate(`document.querySelector('[data-testid="attention-action-pending_approval"]')?.click()`)
  await waitFor(`!!document.querySelector('[data-testid="personal-jobs-control"]')`, 60_000)
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="personal-job-card"]')).some((card) => /桌面自动任务恢复验收/.test(card.innerText || '') && Array.from(card.querySelectorAll('button')).some((button) => /批准|Approve/.test(button.textContent || '')))`,
    60_000,
  )
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-testid="personal-job-card"]'))
      .find((node) => /桌面自动任务恢复验收/.test(node.innerText || ''));
    Array.from(card?.querySelectorAll('button') || []).find((button) => /批准|Approve/.test(button.textContent || ''))?.click();
  })()`)
  await waitFor(
    `Array.from(document.querySelectorAll('[data-testid="personal-job-card"]')).some((card) => /桌面自动任务恢复验收/.test(card.innerText || '') && /排队中|Queued/.test(card.innerText || ''))`,
    60_000,
  )
  await capture("desktop-personal-workspace-job-approval.png")

  await evaluate(
    `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /团队与子代理|Team.*Subagent/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(`!!document.querySelector('[data-testid="session-team-control"]')`, 60_000)
  await evaluate(`(() => {
    const root = document.querySelector('[data-testid="session-team-control"]');
    const setField = (input, value) => {
      if (!input) throw new Error('Team field not found');
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const fields = root?.querySelectorAll('input,textarea') || [];
    setField(fields[0], '桌面协作恢复验收');
    setField(fields[1], '验证创建后从后端刷新仍然可见。');
  })()`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="session-team-control"]')?.querySelectorAll('button') || []).find((node) => /创建协作团队|Create collaboration team/.test(node.textContent || ''))?.click()`,
  )
  await waitFor(
    `/桌面协作恢复验收/.test(document.querySelector('[data-testid="session-team-control"]')?.innerText || '')`,
    60_000,
  )
  await evaluate(`document.querySelector('.session-settings-context-actions button')?.click()`)
  await waitFor(
    `/桌面协作恢复验收/.test(document.querySelector('[data-testid="session-team-control"]')?.innerText || '')`,
    30_000,
  )
  const teamText = await evaluate<string>(
    `document.querySelector('[data-testid="session-team-control"]')?.innerText || ''`,
  )
  if (/持久化 Team|Team 成员|Team 消息|Main Agent|加载 Subagent/.test(teamText))
    throw new Error(`Team UI still exposes mixed internal terminology: ${teamText}`)
  await capture("desktop-team-recovery.png")

  // Exercise the real server-backed control lifecycle through the desktop UI.
  // The first request is deliberately reloaded before approval to prove that a
  // notification/deep-link style renderer restart restores the pending card.
  const createControlOperation = async (name: string, requestID: string) => {
    const accepted = await evaluate<{ status: number; body: string }>(`(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/worktree?" + approvalDirectoryQuery)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ${JSON.stringify(name)}, requestID: ${JSON.stringify(requestID)} })
      });
      return { status: response.status, body: await response.text() };
    })()`)
    if (accepted.status >= 400) throw new Error(`control operation was not accepted: ${JSON.stringify(accepted)}`)
  }
  const controlStatusExpression = (requestID: string, phase: string) => `(async () => {
    const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-operation/")} + ${JSON.stringify(requestID)} + ${JSON.stringify("?operation=worktree.create&" + approvalDirectoryQuery)});
    if (!response.ok) return false;
    return (await response.json()).phase === ${JSON.stringify(phase)};
  })()`

  await createControlOperation("desktop-approval-allow", "cpr_desktop_approval_allow")
  await waitFor(
    `(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
      if (!response.ok) return false;
      return (await response.json()).some((item) => item.subject?.requestID === 'cpr_desktop_approval_allow');
    })()`,
    60_000,
  )
  await waitFor(
    `(() => {
    if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
    Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
    return false;
  })()`,
    30_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  await evaluate(`location.href = ${JSON.stringify(sessionRoute + "?source=notification-e2e")}`)
  await waitFor(`location.pathname.includes(${JSON.stringify(`/session/${admitted.sessionID}`)})`, 60_000)
  await waitFor(
    `(async () => {
      const response = await fetch(${JSON.stringify(runtimeOrigin + "/experimental/control-approval?" + approvalDirectoryQuery)});
      if (!response.ok) return false;
      return (await response.json()).some((item) => item.subject?.requestID === 'cpr_desktop_approval_allow');
    })()`,
    60_000,
  )
  await waitFor(
    `(() => {
    if (document.querySelector('[data-testid="control-approval-dialog"]')) return true;
    Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click();
    return false;
  })()`,
    30_000,
  )
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  const restoredApprovalText = await evaluate<string>(
    `document.querySelector('[data-testid="control-approval-card"]')?.innerText || ''`,
  )
  if (!/创建隔离工作树|Create isolated worktree/.test(restoredApprovalText))
    throw new Error(`restored approval does not explain the requested action: ${restoredApprovalText}`)
  if (/不能批准此项操作|cannot approve this operation/i.test(restoredApprovalText))
    throw new Error(`known control operation is incorrectly fail-closed: ${restoredApprovalText}`)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="control-approval-card"]')?.querySelectorAll('button') || []).find((node) => /仅本次批准|Approve once/i.test(node.textContent || ''))?.click()`,
  )
  await waitFor(controlStatusExpression("cpr_desktop_approval_allow", "completed"), 60_000)

  await createControlOperation("desktop-approval-reject", "cpr_desktop_approval_reject")
  await waitFor(`!!document.querySelector('[data-testid="control-approval-card"]')`, 60_000)
  await evaluate(
    `Array.from(document.querySelector('[data-testid="control-approval-card"]')?.querySelectorAll('button') || []).find((node) => /^(拒绝|Reject)$/.test((node.textContent || '').trim()))?.click()`,
  )
  await waitFor(controlStatusExpression("cpr_desktop_approval_reject", "failed"), 60_000)
  await waitFor(`!document.querySelector('[data-testid="control-approval-card"]')`, 30_000)
  await capture("desktop-control-approval-lifecycle.png")

  const expectedRetiredResponses = capabilityResponses.filter(
    (response) =>
      retiredCustomizationBoundaryVisible && response.status === 400 && response.url.includes("/customizations"),
  )
  const expectedPluginSecurityResponses = capabilityResponses.filter(
    (response) => response.status === 400 && response.url.includes("/agent-capabilities/plugins/restore"),
  )
  if (expectedPluginSecurityResponses.length !== 1)
    throw new Error(
      `tampered plugin restore did not produce exactly one expected 400 response: ${JSON.stringify(expectedPluginSecurityResponses)}`,
    )
  const badResponses = capabilityResponses.filter(
    (response) =>
      response.status >= 400 &&
      !expectedRetiredResponses.includes(response) &&
      !expectedPluginSecurityResponses.includes(response),
  )
  const report = {
    schemaVersion: 3,
    runtimeTopology: "typescript-core",
    packagedDesktop: launchMode === "packaged",
    desktopLaunchMode: launchMode,
    pythonRuntimeDispatched: false,
    contextAssemblyEvidenceVisible: true,
    memoryGovernanceVisible: true,
    isolatedWorkspace: visibleDirectory,
    isolatedMemoryCount: 0,
    isolatedProjectCount: persistedProjectRoots.length,
    constitutionBoundaryVisible: true,
    evolutionTimelineVisible: true,
    runtimeInsightVisible: true,
    durableRuntimeEvidenceVisible: true,
    workflowUserExperienceVisible: true,
    workflowDefinitionIsolated: true,
    workflowApprovalCompleted: true,
    workflowDeepFieldsLocalized: true,
    policyContractSummaryVisible,
    policyAdvancedEvidenceVisible,
    managedSkillDisableApprovedAndExecuted: true,
    managedSkillEnableApprovedAndExecuted: true,
    pluginInspectionVisibleBeforeMutation: true,
    pluginDeclaredScopesVisible,
    pluginInspectionInvalidatedOnSourceChange,
    pluginInstallApprovedAndStartsDisabled: true,
    pluginUpdateApprovedAndStartsDisabled: true,
    pluginUpdateRollbackCompleted,
    pluginUpdateRollbackUndoCompleted,
    pluginUpdateRecoveryID,
    pluginRollbackUndoRecoveryID,
    blockedPluginRejectedBeforeMutation: true,
    pluginEnableApprovedAndExecuted: true,
    pluginDisableApprovedAndExecuted: true,
    pluginRemovalRecoverable: true,
    pluginRestoreApprovedAndStartsDisabled: true,
    pluginRecoveryID,
    tamperedPluginRestoreRejectedWithoutMutation: true,
    tamperedPluginRecoveryID,
    recoveryAttentionActionable: true,
    recoveryAttentionLocalized: true,
    recoveryAttentionNavigatedToRuntimeInsight: true,
    sessionRevertControlledFromUserCommand: true,
    sessionRevertRejectedWithoutMutation: true,
    sessionRevertApprovedAndExecuted: true,
    sessionUnrevertApprovedAndExecuted: true,
    personalJobsEmptyStateVisible: true,
    personalJobsValidationVisible: true,
    personalJobsRefreshRecoveryVisible: true,
    personalJobsRetentionVisible,
    personalWorkspaceMetadataLocalized,
    personalWorkspaceTaskProjectionVisible,
    teamRefreshRecoveryVisible: true,
    controlApprovalReloadRecoveryVisible: true,
    controlApprovalApproved: true,
    controlApprovalRejected: true,
    notificationDeepLinkRecovered: true,
    retiredCustomizationBoundaryVisible,
    experienceGovernanceVisible,
    tenantGovernanceVisible,
    tenantDataRequestVisible,
    tenantBackupReceiptVisible,
    tenantAuditReceiptVisible,
    skillLifecycleGovernanceVisible,
    skillLifecyclePresentationLocalized,
    skillCandidateCreationVisible,
    skillCandidateCreatedFromVerifiedExperience,
    skillCandidateStayedClosed,
    skillEvaluationGuidedFormVisible,
    skillEvaluationRecorded,
    skillCanaryStayedFailClosed,
    expectedRetiredResponses,
    expectedPluginSecurityResponses,
    admittedSessionID: admitted.sessionID,
    capabilityResponses,
    runtimeInsightResponses,
    bootstrapDiagnostics,
    rendererErrors,
    failedRequests,
    appExitCode: appProcess.exitCode,
  }
  await writeFile(
    join(artifacts, artifactName("desktop-typescript-runtime-visibility-audit.json")),
    JSON.stringify(report, null, 2),
  )
  if (rendererErrors.length || failedRequests.length || badResponses.length)
    throw new Error(JSON.stringify({ ...report, badResponses }, null, 2))
} finally {
  cdp?.close()
  if (appProcess?.pid && appProcess.exitCode === null) {
    if (process.platform === "win32") {
      await new Promise<void>((done) => {
        const killer = spawn("taskkill.exe", ["/PID", String(appProcess!.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        })
        const timeout = setTimeout(() => {
          killer.kill()
          done()
        }, 10_000)
        const finish = () => {
          clearTimeout(timeout)
          done()
        }
        killer.once("error", finish)
        killer.once("exit", finish)
      })
      if (appProcess.exitCode === null) appProcess.kill()
    } else {
      appProcess.kill("SIGTERM")
    }
  }
  await sleep(250)
  if (process.env.ARFORGE_KEEP_ACCEPTANCE_PROFILE === "1") console.log(`acceptance profile retained: ${temp}`)
  else await Promise.race([rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }), sleep(5_000)])
}
