import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolPart } from "@arforge-ai/sdk/v2"
import type { GenericToolProps } from "./basic-tool"

const sourceDir = dirname(fileURLToPath(import.meta.url))
const repo = sourceDir.replace(/[\\/](?:\.tmp[\\/][^\\/]+[\\/])?packages[\\/]session-ui[\\/].*$/, "")
const uiRequire = createRequire(join(repo, "packages/session-ui/package.json"))
const appRequire = createRequire(join(repo, "packages/app/package.json"))
let solid: typeof import("solid-js"), web: typeof import("solid-js/web")
let Generic: typeof import("./basic-tool").GenericTool
let Fallback: (props: Record<string, unknown>) => import("solid-js").JSX.Element
const disposals: (() => void)[] = []
const writes: string[] = []
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => { await frame(); await frame(); await frame() }

beforeAll(async () => {
  const require = createRequire(appRequire.resolve("vite-plugin-solid"))
  const babel = require("@babel/core"), preset = require("babel-preset-solid")
  const compile = (text: string, filename: string) => {
    const result = babel.transformSync(text, {
      filename, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [[preset.default ?? preset, { generate: "dom" }]],
    })
    if (!result?.code) throw new Error("Solid compilation failed: " + filename)
    return { contents: result.code, loader: "ts" as const }
  }
  plugin({ name: "generic-tool-real-owner-dom", setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const baseline = process.env.ARFORGE_GENERIC_OUTPUT_BASELINE === "1" && path === join(sourceDir, "basic-tool.tsx")
      const text = await readFile(baseline ? join(repo, ".tmp/generic-output47-staged/baseline/basic-tool.tsx") : path, "utf8")
      return compile(text, path)
    })
  } })
  // Peripheral SVG decoration only; no mocked buttons, collapse state, output or copy behavior.
  await mock.module(uiRequire.resolve("@arforge-ai/ui/icon"), () => ({ Icon: () => null }))
  await mock.module(uiRequire.resolve("@arforge-ai/ui/v2/icon"), () => ({ Icon: () => null }))
  solid = await import(uiRequire.resolve("solid-js/dist/solid.js"))
  web = await import(uiRequire.resolve("solid-js/web/dist/web.js"))
  const basic = await import("./basic-tool")
  Generic = basic.GenericTool
  // The real absolute-path owner and registry select an unregistered ToolPart fallback.
  // Resolution-only injection replaces just its BasicTool dependency with this staged owner.
  if (sourceDir.replaceAll("\\", "/") !== join(repo, "packages/session-ui/src/components").replaceAll("\\", "/"))
    await mock.module(join(repo, "packages/session-ui/src/components/basic-tool.tsx"), () => basic)
  await mock.module(join(repo, "packages/session-ui/src/context/index.ts"), () => ({
    useData: () => ({ store: { session: [], agent: [] } }),
  }))
  // Unrelated rich-file/Markdown renderers need Vite worker URLs; this fallback renders neither.
  await mock.module(join(repo, "packages/session-ui/src/components/markdown.tsx"), () => ({ Markdown: () => null }))
  await mock.module(join(repo, "packages/session-ui/src/components/file.tsx"), () => ({ File: () => null }))
  const owner = await import(join(repo, "packages/session-ui/src/components/message-part.tsx"))
  Fallback = owner.PART_MAPPING.tool
  if (!Fallback) throw new Error("Real tool part renderer unavailable")
})

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
  writes.splice(0)
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
  else Reflect.deleteProperty(navigator, "clipboard")
})

function mount(component: (props: any) => import("solid-js").JSX.Element, props: object) {
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(web.render(() => solid.createComponent(component, props), host))
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { writes.push(text) },
  } })
  return host
}
const completed = (output: string): ToolPart => ({
  id: "part-generic", sessionID: "session-owned", messageID: "message-owned", callID: "call-owned",
  type: "tool", tool: "mcp.owned-fixture-unregistered",
  state: { status: "completed", input: { name: "owned" }, metadata: {}, title: "Owned tool", output, time: { start: 1, end: 2 } },
})
const trigger = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!
const code = (host: HTMLElement) => host.querySelector("pre code")
const named = (host: HTMLElement, text: RegExp) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => text.test(button.getAttribute("aria-label") ?? button.textContent ?? ""))!

test("unknown tool fallback shows bounded escaped output and copies the full real DTO string", async () => {
  const output = Array.from({ length: 28 }, (_, index) => index === 0
    ? '  <script>globalThis.toolOutputExecuted=true</script> <img src="x" onerror="bad()">'
    : `original output line ${index + 1} 😀  `).join("\r\n") + "\r\n  "
  const host = mount(Fallback, { part: completed(output), defaultOpen: true, deferToolContent: false })
  await settle()
  expect(host.textContent).toContain("mcp.owned-fixture-unregistered")
  expect(trigger(host)).not.toBeNull()
  expect(code(host)).not.toBeNull()
  expect(code(host)?.textContent).toContain("original output line 20")
  expect(code(host)?.textContent).not.toContain("original output line 21")
  expect(host.querySelector("script,img")).toBeNull()
  expect(host.querySelector('[data-slot="bash-scroll"]')?.getAttribute("role")).toBe("region")
  named(host, /^Copy$/).click()
  await Promise.resolve()
  expect(writes).toEqual([output])
  const expand = named(host, /^Expand all/)
  expect(expand.getAttribute("aria-expanded")).toBe("false")
  expand.click()
  expect(code(host)?.textContent).toBe(output)
  named(host, /^Collapse/).click()
  expect(code(host)?.textContent).not.toContain("original output line 21")
})

test("uncontrolled open toggles with callbacks while keeping complete output", async () => {
  const changes: boolean[] = []
  const host = mount(Generic, { tool: "owned", status: "completed", output: "full body", deferContent: false,
    onOpenChange: (value: boolean) => changes.push(value) } satisfies GenericToolProps)
  expect(trigger(host).getAttribute("aria-expanded")).toBe("false")
  trigger(host).click(); await settle()
  expect(trigger(host).getAttribute("aria-expanded")).toBe("true")
  expect(code(host)?.textContent).toBe("full body")
  trigger(host).click(); await settle()
  expect(trigger(host).getAttribute("aria-expanded")).toBe("false")
  expect(changes).toEqual([true, false])
})

test("actual fallback preserves controlled open and deferred content callbacks", async () => {
  const [open, setOpen] = solid.createSignal(false)
  const changes: boolean[] = []
  let rendered = 0
  const host = mount(Fallback, { part: completed("deferred original"), get toolOpen() { return open() },
    onToolOpenChange: (value: boolean) => changes.push(value), deferToolContent: true,
    onContentRendered: () => { rendered++ } })
  expect(code(host)).toBeNull()
  expect(rendered).toBe(0)
  trigger(host).click(); await settle()
  expect(changes).toEqual([true])
  expect(trigger(host).getAttribute("aria-expanded")).toBe("false")
  expect(code(host)).toBeNull()
  setOpen(true)
  expect(code(host)).toBeNull()
  await settle()
  expect(code(host)?.textContent).toBe("deferred original")
  expect(rendered).toBe(1)
  setOpen(false); await settle()
  expect(code(host)).toBeNull()
})

test("default-open output remains deferred until its real mount frames", async () => {
  let rendered = 0
  const host = mount(Generic, { tool: "owned", output: "lazy body", defaultOpen: true,
    onContentRendered: () => { rendered++ } } satisfies GenericToolProps)
  expect(code(host)).toBeNull()
  expect(rendered).toBe(0)
  await settle()
  expect(code(host)?.textContent).toBe("lazy body")
  expect(rendered).toBe(1)
})

for (const scenario of ["hidden", "pending", "running", "empty", "whitespace", "nonstring"] as const) {
  test("no output/copy or enabled empty details control for " + scenario, async () => {
    const changes: boolean[] = []
    let rendered = 0
    const host = mount(Generic, { tool: "owned", status: scenario === "pending" || scenario === "running" ? scenario : "completed",
      output: scenario === "empty" ? "" : scenario === "whitespace" ? " \n " : scenario === "nonstring" ? { text: "not a public DTO string" } as unknown as string : "stale output",
      hideDetails: scenario === "hidden", defaultOpen: true, open: true,
      onOpenChange: (value: boolean) => changes.push(value), onContentRendered: () => { rendered++ } } satisfies GenericToolProps)
    trigger(host).click(); await settle()
    expect(trigger(host).disabled).toBe(true)
    expect(code(host)).toBeNull()
    expect(host.querySelector('[data-slot="bash-copy"]')).toBeNull()
    expect(host.querySelector('[data-slot="collapsible-arrow"]')).toBeNull()
    expect(changes).toEqual([])
    expect(rendered).toBe(0)
    expect(writes).toEqual([])
  })
}
