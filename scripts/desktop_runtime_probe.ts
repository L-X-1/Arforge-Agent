const endpoint = process.env.ARFORGE_DESKTOP_CDP ?? "http://127.0.0.1:9222"
const artifactRoot =
  process.env.ARFORGE_DESKTOP_ARTIFACTS ?? "artifacts/desktop-acceptance"

type CdpResponse = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const targets = (await fetch(`${endpoint}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`CDP target discovery failed: ${response.status}`)
  return response.json()
})) as Array<{
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}>

const target = targets.find(
  (candidate) =>
    candidate.type === "page" &&
    candidate.url.startsWith("http://localhost:5173/") &&
    candidate.webSocketDebuggerUrl,
)
if (!target?.webSocketDebuggerUrl) {
  throw new Error("The running Arforge Desktop renderer CDP target was not found")
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Timed out connecting to the Desktop CDP target")),
    10_000,
  )
  socket.addEventListener(
    "open",
    () => {
      clearTimeout(timeout)
      resolve()
    },
    { once: true },
  )
  socket.addEventListener(
    "error",
    () => {
      clearTimeout(timeout)
      reject(new Error("Desktop CDP WebSocket connection failed"))
    },
    { once: true },
  )
})

let sequence = 0
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
const events: CdpResponse[] = []

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as CdpResponse
  if (message.id !== undefined) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) {
      request.reject(new Error(`${message.error.code}: ${message.error.message}`))
    } else {
      request.resolve(message.result)
    }
    return
  }
  if (
    message.method === "Runtime.exceptionThrown" ||
    message.method === "Runtime.consoleAPICalled" ||
    message.method === "Log.entryAdded" ||
    message.method === "Network.loadingFailed" ||
    message.method === "Network.responseReceived"
  ) {
    events.push(message)
  }
})

function command(method: string, params: Record<string, unknown> = {}) {
  const id = ++sequence
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP command timed out: ${method}`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await Promise.all([
  command("Runtime.enable"),
  command("Log.enable"),
  command("Network.enable"),
  command("Page.enable"),
])
await Bun.sleep(1_000)

const requestedAction = process.env.ARFORGE_DESKTOP_PROBE_ACTION ?? ""
let actionOutcome: Record<string, unknown> | null = null
if (requestedAction === "open-model-menu") {
  const coordinates = (await command("Runtime.evaluate", {
    expression: String.raw`(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.innerText.trim() === "DeepSeek V4 Pro"
      )
      if (!button) throw new Error("The visible Desktop model selector was not found")
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`,
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number } }; exceptionDetails?: unknown }
  if (coordinates.exceptionDetails || !coordinates.result?.value) {
    throw new Error(`Model selector lookup failed: ${JSON.stringify(coordinates)}`)
  }
  const { x, y } = coordinates.result.value
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  })
  await Bun.sleep(750)
  actionOutcome = { action: requestedAction, modelSelectorClicked: true }
} else if (requestedAction === "send-message") {
  const expectedToken =
    process.env.ARFORGE_DESKTOP_EXPECTED_TOKEN ?? "ARFORGE_DESKTOP_ACCEPTED"
  const prompt =
    process.env.ARFORGE_DESKTOP_TEST_PROMPT ??
    `桌面端最终验收。请只回复：${expectedToken}`
  const promptCoordinates = (await command("Runtime.evaluate", {
    expression: String.raw`(() => {
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]')
      if (!editor) throw new Error("The visible Desktop prompt editor was not found")
      const rect = editor.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`,
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number } }; exceptionDetails?: unknown }
  if (promptCoordinates.exceptionDetails || !promptCoordinates.result?.value) {
    throw new Error(`Prompt editor lookup failed: ${JSON.stringify(promptCoordinates)}`)
  }
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...promptCoordinates.result.value,
    button: "left",
    clickCount: 1,
  })
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...promptCoordinates.result.value,
    button: "left",
    clickCount: 1,
  })
  await command("Input.insertText", { text: prompt })
  await Bun.sleep(300)

  const sendCoordinates = (await command("Runtime.evaluate", {
    expression: String.raw`(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.getAttribute("aria-label") === "Send"
      )
      if (!button) throw new Error("The Desktop Send button was not found")
      if (button.disabled || button.getAttribute("aria-disabled") === "true") {
        throw new Error("The Desktop Send button remained disabled after text input")
      }
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`,
    returnByValue: true,
  })) as { result?: { value?: { x: number; y: number } }; exceptionDetails?: unknown }
  if (sendCoordinates.exceptionDetails || !sendCoordinates.result?.value) {
    throw new Error(`Send button lookup failed: ${JSON.stringify(sendCoordinates)}`)
  }
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...sendCoordinates.result.value,
    button: "left",
    clickCount: 1,
  })
  await command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...sendCoordinates.result.value,
    button: "left",
    clickCount: 1,
  })

  const startedAt = Date.now()
  let observedOccurrences = 0
  let observedBusy = false
  while (Date.now() - startedAt < 50_000) {
    await Bun.sleep(1_000)
    const state = (await command("Runtime.evaluate", {
      expression: `(() => {
        const text = document.body?.innerText || ""
        const token = ${JSON.stringify(expectedToken)}
        return {
          occurrences: text.split(token).length - 1,
          busy: Array.from(document.querySelectorAll("button")).some(
            (button) => button.getAttribute("aria-label") === "Stop"
          ),
          tail: text.slice(-2_000),
        }
      })()`,
      returnByValue: true,
    })) as {
      result?: {
        value?: { occurrences: number; busy: boolean; tail: string }
      }
    }
    observedOccurrences = state.result?.value?.occurrences ?? 0
    observedBusy = state.result?.value?.busy ?? false
    if (observedOccurrences >= 2 && !observedBusy) break
  }
  if (observedOccurrences < 2 || observedBusy) {
    throw new Error(
      `Desktop model response was not completed within 50 seconds: occurrences=${observedOccurrences}, busy=${observedBusy}`,
    )
  }
  actionOutcome = {
    action: requestedAction,
    promptInserted: true,
    sendClicked: true,
    expectedToken,
    tokenOccurrences: observedOccurrences,
    responseCompleted: true,
    elapsedMs: Date.now() - startedAt,
  }
}

const probeExpression = String.raw`(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none" &&
      Number(style.opacity || "1") > 0
  }
  const describe = (element) => {
    const rect = element.getBoundingClientRect()
    return {
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.value || "").trim().slice(0, 180),
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      placeholder: element.getAttribute("placeholder"),
      role: element.getAttribute("role"),
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      visible: visible(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      testId: element.getAttribute("data-testid"),
    }
  }
  const resources = performance.getEntriesByType("resource").map((entry) => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    duration: Math.round(entry.duration),
  }))
  return {
    readyState: document.readyState,
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    bodyText: (document.body?.innerText || "").slice(0, 12_000),
    bodyBounds: document.body ? describe(document.body).rect : null,
    interactive: Array.from(document.querySelectorAll(
      "button,[role=button],a,input,textarea,select,[contenteditable=true]"
    )).map(describe).filter((item) => item.visible),
    dialogs: Array.from(document.querySelectorAll(
      "[role=dialog],[role=menu],[data-radix-popper-content-wrapper]"
    )).map(describe).filter((item) => item.visible),
    resources,
    localStorageKeys: Object.keys(localStorage),
    hasErrorOverlay: Boolean(document.querySelector(
      "vite-error-overlay,[data-error-boundary],.error-boundary"
    )),
  }
})()`

const evaluation = (await command("Runtime.evaluate", {
  expression: probeExpression,
  awaitPromise: true,
  returnByValue: true,
})) as {
  result?: { value?: unknown }
  exceptionDetails?: unknown
}
if (evaluation.exceptionDetails) {
  throw new Error(`Renderer probe failed: ${JSON.stringify(evaluation.exceptionDetails)}`)
}

const screenshot = (await command("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
})) as { data?: string }
if (!screenshot.data) throw new Error("Desktop screenshot capture returned no data")

await Bun.$`mkdir -p ${artifactRoot}`.quiet()
const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "")
const screenshotPath = `${artifactRoot}/desktop-${timestamp}.png`
const reportPath = `${artifactRoot}/desktop-${timestamp}.json`
await Bun.write(screenshotPath, Uint8Array.from(atob(screenshot.data), (value) => value.charCodeAt(0)))
await Bun.write(
  reportPath,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      target: { title: target.title, url: target.url },
      renderer: evaluation.result?.value,
      events,
      actionOutcome,
      screenshotPath,
    },
    null,
    2,
  ),
)

if (requestedAction === "open-model-menu") {
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" })
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" })
}

socket.close()
console.log(JSON.stringify({ reportPath, screenshotPath }, null, 2))
