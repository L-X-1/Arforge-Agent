import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

let Tooltip: typeof import("./model-tooltip").ModelTooltip
let ContextTab: typeof import("./session/session-context-tab").SessionContextTab
let limit = 0
let locale = "en-US"
let modelAvailable = true
const disposals: (() => void)[] = []
const sample = {
  id: "settled", role: "assistant", providerID: "owned", modelID: "owned-model", finish: "stop",
  time: { created: 1, completed: 2 }, cost: 0,
  tokens: { input: 10, output: 17, reasoning: 0, cache: { read: 0, write: 0 } },
}
const model = () => ({ id: "owned-model", name: "Owned model", provider: { id: "owned", name: "Owned provider" }, limit: { context: limit } })

beforeAll(async () => {
  // Compile the real presentation owners; only context boundaries and unrelated widgets are fixtures.
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: { transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null } = require("@babel/core")
  const solid = require("babel-preset-solid")
  plugin({ name: "context-limit-display-dom", setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/]app[\\/]src[\\/]components[\\/](model-tooltip|session[\\/]session-context-tab)\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await Bun.file(path).text(), {
        filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solid.default ?? solid, { generate: "dom" }]],
      })
      if (!result?.code) throw new Error("Solid compilation failed: " + path)
      return { contents: result.code, loader: "ts" }
    })
  } })
  await mock.module("@/context/language", () => ({ useLanguage: () => ({
    locale: () => locale, intl: () => locale,
    t: (key: string, values?: Record<string, string>) => key === "model.tooltip.context" ? String(values?.limit) + " context" : key,
  }) }))
  const bound = { scope: "owned", url: "http://127.0.0.1:4096", directory: "E:/owned", api: {} }
  const source = { operationsApi: {} }
  const info = { title: "Owned", cost: 0, time: { created: 1, updated: 2 } }
  const sync = { session: { get: () => info }, data: {
    message: { owned: [sample] }, part: {}, session_status: { owned: { type: "idle" } }, config: {},
  } }
  await mock.module("@/context/sync", () => ({ useSync: () => () => sync }))
  await mock.module("@/context/sdk", () => ({ useSDK: () => () => bound }))
  await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => source }))
  await mock.module("@/context/local", () => ({ useLocal: () => ({ model: { current: model, variant: { current: () => undefined } } }) }))
  await mock.module("@/hooks/use-providers", () => ({ useProviders: () => ({ all: () => new Map([["owned", {
    id: "owned", name: "Owned provider", models: modelAvailable ? { "owned-model": model() } : {},
  }]]) }) }))
  await mock.module("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({
    params: { id: "owned" }, view: () => ({ scroll: () => undefined, setScroll: () => undefined }),
  }) }))
  const children = (props: { children?: unknown }) => props.children
  await mock.module("@arforge-ai/ui/scroll-view", () => ({ ScrollView: children }))
  await mock.module("@arforge-ai/ui/accordion", () => ({ Accordion: Object.assign(children, { Item: children, Trigger: children, Content: children }) }))
  await mock.module("@arforge-ai/ui/sticky-accordion-header", () => ({ StickyAccordionHeader: children }))
  await mock.module("@arforge-ai/ui/icon", () => ({ Icon: () => null }))
  await mock.module("@arforge-ai/session-ui/file", () => ({ File: () => null }))
  await mock.module("@arforge-ai/session-ui/markdown", () => ({ Markdown: () => null }))
  Tooltip = (await import("./model-tooltip")).ModelTooltip
  ContextTab = (await import("./session/session-context-tab")).SessionContextTab
})

beforeEach(() => { limit = 0; locale = "en-US"; modelAvailable = true })
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren() })

function tooltip(v2: boolean) {
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(render(() => createComponent(Tooltip, { model: model(), v2 }), host))
  return host
}
function context() {
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(render(() => createComponent(ContextTab, {}), host))
  const stat = (name: string) => {
    const row = [...host.querySelectorAll('[data-slot="context-stat"]')].find(r => r.firstElementChild?.textContent === name)
    if (!row) throw new Error("Missing real context stat: " + name)
    return row.lastElementChild?.textContent
  }
  return { host, stat }
}

for (const v2 of [false, true]) {
  for (const unknown of [0, -1, NaN, Infinity, -Infinity]) test("model tooltip keeps an unavailable context limit unknown: " + v2 + "/" + unknown, () => {
    limit = unknown
    const host = tooltip(v2)
    expect(host.textContent).toContain("—")
    expect(host.textContent).toContain("Owned model")
    expect(host.textContent).not.toContain(unknown.toLocaleString(locale))
  })
  test("positive model context limit keeps the active locale: " + v2, () => {
    locale = "de-DE"; limit = 128000
    expect(tooltip(v2).textContent).toContain("128.000")
  })
}

for (const unknown of [0, -1, NaN, Infinity, -Infinity]) test("unknown sample capacity has no measured percentage: " + unknown, () => {
  limit = unknown
  const { host, stat } = context()
  expect(stat("context.stats.limit")).toBe("—")
  expect(stat("context.stats.usage")).toBe("—")
  expect(host.querySelector(".arforge-context-summary-grid [data-slot='context-stat']")?.lastElementChild?.textContent).toBe("—")
  expect(host.querySelectorAll(".arforge-context-owner-budget > section")[1]?.querySelector(".arforge-context-grid [data-slot='context-stat']")?.lastElementChild?.textContent).toBe("—")
  expect(stat("context.stats.totalTokens")).toBe("27")
  expect(stat("context.stats.reasoningTokens")).toBe("0")
  expect(stat("context.stats.cacheTokens")).toBe("0 / 0")
  expect(stat("context.stats.totalCost")).toBe(new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(0))
})

test("missing sampled model metadata stays unknown", () => {
  modelAvailable = false
  const { stat } = context()
  expect(stat("context.stats.limit")).toBe("—")
  expect(stat("context.stats.totalTokens")).toBe("27")
})

test("known sample capacity preserves a genuinely rounded zero percent", () => {
  limit = 128000
  const { stat } = context()
  expect(stat("context.stats.limit")).toBe("128,000")
  expect(stat("context.stats.usage")).toBe("0%")
  expect(stat("context.stats.reasoningTokens")).toBe("0")
})

test("a known positive sample capacity keeps its actual ratio above 100 percent", () => {
  limit = 1
  const { stat } = context()
  expect(stat("context.stats.limit")).toBe("1")
  expect(stat("context.stats.usage")).toBe("2,700%")
  expect(stat("context.stats.totalTokens")).toBe("27")
})
