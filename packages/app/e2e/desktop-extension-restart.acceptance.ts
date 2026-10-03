import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const desktopRoot = join(root, "packages/desktop")
const electron = join(desktopRoot, "node_modules", "electron", "dist", "electron.exe")
const artifacts = join(root, "artifacts")
const sleep = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))

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
  evaluate: <T>(expression: string) => Promise<T>
  waitFor: (expression: string, timeout?: number) => Promise<void>
  capture: (name: string) => Promise<void>
}

async function terminateProcessTree(process: ChildProcess) {
  if (!process.pid || process.exitCode !== null) return
  await new Promise<void>((done) => {
    const killer = spawn("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("error", () => done())
    killer.once("exit", () => done())
  })
}

async function launchDesktop(input: { workspace: string; home: string; profile: string }): Promise<Desktop> {
  await rm(join(input.profile, "DevToolsActivePort"), { force: true }).catch(() => undefined)
  let stdout = ""
  let stderr = ""
  let debugPort = 0
  const rendererErrors: string[] = []
  const failedRequests: string[] = []
  const process = spawn(electron, ["--remote-debugging-port=0", `--user-data-dir=${input.profile}`, desktopRoot], {
    cwd: input.workspace,
    env: {
      ...globalThis.process.env,
      ARFORGE_HOME: input.home,
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
  process.stdout?.on("data", (chunk) => (stdout += String(chunk)))
  process.stderr?.on("data", (chunk) => (stderr += String(chunk)))

  const deadline = Date.now() + 120_000
  let endpoint = ""
  while (Date.now() < deadline) {
    if (!debugPort) {
      debugPort = await readFile(join(input.profile, "DevToolsActivePort"), "utf8")
        .then((value) => Number(value.split(/\r?\n/, 1)[0]))
        .catch(() => 0)
      if (!debugPort) {
        const announcedPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1]
        if (announcedPort) debugPort = Number(announcedPort)
      }
    }
    try {
      if (debugPort) {
        const version = (await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) =>
          response.json(),
        )) as { webSocketDebuggerUrl?: string }
        if (version.webSocketDebuggerUrl) {
          endpoint = version.webSocketDebuggerUrl
          break
        }
      }
    } catch {}
    if (process.exitCode !== null) break
    await sleep(250)
  }
  if (!endpoint) {
    await terminateProcessTree(process)
    throw new Error(`desktop did not start (exit=${process.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }

  const requests = new Map<string, string>()
  const apiOrigins = new Set<string>()
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
          if (url.pathname.startsWith("/api/")) apiOrigins.add(url.origin)
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
  if (!targetID) {
    cdp.close()
    await terminateProcessTree(process)
    throw new Error(`renderer target is missing\n${stdout}\n${stderr}`)
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId: targetID, flatten: true })
  rendererSessionID = String(attached.sessionId ?? "")
  if (!rendererSessionID) {
    cdp.close()
    await terminateProcessTree(process)
    throw new Error("renderer CDP session is missing")
  }
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
    const diagnostics = await evaluate<unknown>(`({ url: location.href, body: document.body?.innerText?.slice(0, 5000) })`)
    throw new Error(
      `renderer condition timed out: ${expression}\n${JSON.stringify({ diagnostics, rendererErrors, failedRequests, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) }, null, 2)}`,
    )
  }
  const capture = async (name: string) => {
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, rendererSessionID)
    await writeFile(join(artifacts, name), Buffer.from(String(screenshot.data), "base64"))
  }

  await waitFor(
    `!!document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).some((node) => /^(设置|Settings)$/.test((node.textContent || '').trim()))`,
    60_000,
  )
  let origin = ""
  while (!origin && Date.now() < deadline) {
    origin = apiOrigins.values().next().value ?? ""
    if (!origin) await sleep(250)
  }
  if (!origin) {
    cdp.close()
    await terminateProcessTree(process)
    throw new Error("desktop renderer did not issue a request to its local TypeScript API")
  }
  return { process, cdp, origin, rendererErrors, failedRequests, evaluate, waitFor, capture }
}

async function stopDesktop(desktop: Desktop) {
  desktop.cdp.close()
  await terminateProcessTree(desktop.process)
  await Promise.race([
    desktop.process.exitCode === null
      ? new Promise<void>((done) => desktop.process.once("exit", () => done()))
      : Promise.resolve(),
    sleep(15_000).then(() => {
      throw new Error(`desktop process ${desktop.process.pid} did not exit after forced termination`)
    }),
  ])
}

async function openExtensionSettings(desktop: Desktop) {
  if (!(await desktop.evaluate<boolean>(`!!document.querySelector('[data-testid="managed-skill-center"]')`))) {
    await desktop.evaluate(
      `(document.querySelector('button[aria-label="打开 Arforge 设置"]') || Array.from(document.querySelectorAll('button')).find((node) => /^(设置|Settings)$/.test((node.textContent || '').trim())))?.click()`,
    )
    await desktop.waitFor(
      `Array.from(document.querySelectorAll('button')).some((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || '')) || Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))`,
    )
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('button')).find((node) => /显示高级工具|Show advanced tools|顯示進階工具/.test(node.textContent || ''))?.click()`,
    )
    await desktop.waitFor(
      `Array.from(document.querySelectorAll('button,[role="tab"]')).some((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))`,
    )
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('button,[role="tab"]')).find((node) => /工作流、插件与技能|Workflow, plugin, and skill|工作流程、外掛程式與技能/i.test(node.textContent || ''))?.click()`,
    )
  }
  await desktop.waitFor(`!!document.querySelector('[data-testid="managed-skill-center"]')`, 120_000)
  await desktop.waitFor(`!!document.querySelector('[data-testid="managed-plugin-center"]')`, 120_000)
}

async function approveExtensionAction(desktop: Desktop, workspace: string, action: string, labelPattern: string) {
  const approvals = `${desktop.origin}/experimental/control-approval?${new URLSearchParams({ directory: workspace })}`
  await desktop.waitFor(
    `(async () => { const response = await fetch(${JSON.stringify(approvals)}); return response.ok && (await response.json()).some((item) => item.action === ${JSON.stringify(action)}); })()`,
    60_000,
  )
  await desktop.waitFor(
    `(() => { if (document.querySelector('[data-testid="control-approval-dialog"]')) return true; Array.from(document.querySelectorAll('button')).find((node) => /控制操作审批|control operation.*approval/i.test(node.getAttribute('aria-label') || node.textContent || ''))?.click(); return false; })()`,
    30_000,
  )
  await desktop.waitFor(
    `Array.from(document.querySelectorAll('[data-testid="control-approval-card"]')).some((node) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(node.innerText || ''))`,
    30_000,
  )
  await desktop.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('[data-testid="control-approval-card"]')).find((node) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(node.innerText || ''));
    Array.from(card?.querySelectorAll('button') || []).find((node) => /仅本次批准|Approve once/i.test(node.textContent || ''))?.click();
  })()`)
  await desktop.waitFor(
    `(async () => { const response = await fetch(${JSON.stringify(approvals)}); return response.ok && !(await response.json()).some((item) => item.action === ${JSON.stringify(action)}); })()`,
    60_000,
  )
  await desktop.evaluate(`if (document.querySelector('[data-testid="control-approval-dialog"]')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))`)
  await desktop.waitFor(`!document.querySelector('[data-testid="control-approval-dialog"]')`, 30_000)
}

const temp = await mkdtemp(join(tmpdir(), "arforge-extension-restart-"))
const home = join(temp, "home")
const workspace = join(temp, "workspace")
const profile = join(temp, "electron-profile")
const pluginSource = join(workspace, "restart-plugin-source")
const skillDirectory = join(profile, "runtime", "skills", "desktop-restart-skill")
const suffix = String(globalThis.process.env.ARFORGE_ACCEPTANCE_ARTIFACT_SUFFIX ?? "")
const artifactName = (name: string) => name.replace(/(\.[^.]+)$/, `${suffix}$1`)
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(pluginSource, { recursive: true }),
  mkdir(skillDirectory, { recursive: true }),
  mkdir(artifacts, { recursive: true }),
])
await writeFile(
  join(pluginSource, "plugin.json"),
  JSON.stringify(
    {
      name: "desktop-restart-plugin",
      version: "1.0.0",
      description: "Safe local plugin used to verify full desktop restart persistence.",
      tools: [
        {
          name: "restart-check",
          description: "Return a bounded restart marker.",
          command: ["echo", "restart-ok"],
          parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
    },
    null,
    2,
  ),
)
await writeFile(
  join(skillDirectory, "SKILL.md"),
  `---\nid: desktop-restart-skill\nname: Desktop Restart Skill\ndescription: Desktop restart persistence acceptance skill.\nversion: 1.0.0\nlicense: LicenseRef-Proprietary\ntags: [development, acceptance]\n---\n# Desktop Restart Skill\nUse only for isolated restart acceptance.\n`,
)
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true })
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`)
}
git("init")
git("config", "user.email", "desktop-restart-e2e@arforge.local")
git("config", "user.name", "Arforge Desktop Restart E2E")
git("add", ".")
git("commit", "-m", "restart acceptance fixture")

let first: Desktop | undefined
let restarted: Desktop | undefined
try {
  first = await launchDesktop({ workspace, home, profile })
  await openExtensionSettings(first)
  await first.waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-restart-skill"]')?.getAttribute('data-enabled') === 'true'`,
    30_000,
  )
  await first.evaluate(
    `Array.from(document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-restart-skill"]')?.querySelectorAll('button') || []).find((node) => /停用|Disable/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction(first, workspace, "skill.disable", "停用受管技能|Disable managed skill")
  await first.waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-restart-skill"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )

  await first.evaluate(`(() => {
    const input = document.querySelector('[data-testid="managed-plugin-center"] input');
    if (!input) throw new Error('Plugin source field not found');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pluginSource)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await first.evaluate(
    `Array.from(document.querySelector('[data-testid="managed-plugin-center"]')?.querySelectorAll('button') || []).find((node) => /检查插件包|Inspect package/.test(node.textContent || ''))?.click()`,
  )
  await first.waitFor(
    `/desktop-restart-plugin/.test(document.querySelector('[data-testid="plugin-inspection"]')?.innerText || '')`,
    30_000,
  )
  await first.evaluate(
    `Array.from(document.querySelector('[data-testid="plugin-inspection"]')?.querySelectorAll('button') || []).find((node) => /安装已检查的插件|Install inspected plugin/.test(node.textContent || ''))?.click()`,
  )
  await approveExtensionAction(first, workspace, "plugin.install", "安装受管插件|Install managed plugin")
  await first.waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-restart-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )

  const firstOrigin = first.origin
  const firstRendererErrors = [...first.rendererErrors]
  const firstFailedRequests = [...first.failedRequests]
  await stopDesktop(first)
  first = undefined

  restarted = await launchDesktop({ workspace, home, profile })
  await openExtensionSettings(restarted)
  await restarted.waitFor(
    `document.querySelector('[data-testid="managed-skill-card"][data-skill-id="desktop-restart-skill"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  await restarted.waitFor(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-restart-plugin"]')?.getAttribute('data-enabled') === 'false'`,
    60_000,
  )
  const pluginText = await restarted.evaluate<string>(
    `document.querySelector('[data-testid="managed-plugin-card"][data-plugin-name="desktop-restart-plugin"]')?.innerText || ''`,
  )
  if (!/1\.0\.0/.test(pluginText)) throw new Error(`restarted plugin card omitted its persisted version: ${pluginText}`)
  await restarted.capture(artifactName("desktop-extension-full-restart.png"))

  const rendererErrors = [...firstRendererErrors, ...restarted.rendererErrors].filter(
    (error) =>
      !error.includes("Electron sandboxed_renderer.bundle.js script failed to run") &&
      !(error.includes("Cannot destructure property 'preloadScripts'") && error.includes("binding.startupData")),
  )
  const report = {
    schemaVersion: 1,
    runtimeTopology: "typescript-core",
    isolatedProfile: true,
    fullDesktopProcessRestarted: true,
    sameWorkspace: true,
    sameHome: true,
    sameElectronProfile: true,
    localApiRestarted: firstOrigin !== restarted.origin,
    managedSkillDisabledBeforeRestart: true,
    managedSkillDisabledAfterRestart: true,
    managedPluginInstalledDisabledBeforeRestart: true,
    managedPluginInstalledDisabledAfterRestart: true,
    approvalRequiredForMutations: true,
    rendererErrors,
    failedRequests: [...firstFailedRequests, ...restarted.failedRequests],
  }
  await writeFile(
    join(artifacts, artifactName("desktop-extension-full-restart-audit.json")),
    JSON.stringify(report, null, 2),
  )
  if (report.rendererErrors.length || report.failedRequests.length) throw new Error(JSON.stringify(report, null, 2))
} finally {
  if (first) await stopDesktop(first).catch(() => undefined)
  if (restarted) await stopDesktop(restarted).catch(() => undefined)
  if (globalThis.process.env.ARFORGE_KEEP_ACCEPTANCE_PROFILE === "1")
    console.log(`extension restart profile retained: ${temp}`)
  else await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined)
}
