import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { render } from "solid-js/web"
import { decodeMcpToolDetails } from "@/utils/mcp-tool-api"

let View: typeof import("./mcp-tool-details").McpToolDetails
let source: Accessor<{ scope: string }>
const disposals: (() => void)[] = []
const result = (text: string) =>
  decodeMcpToolDetails({
    location: { directory: "E:/owned", project: { id: "project-owned", directory: "E:/owned" } },
    data: {
      capability: {
        id: "owned_lookup",
        server: "owned",
        kind: "tool",
        generation: 3,
        name: "lookup",
        permission: "mcp",
        patterns: ["owned"],
      },
      definition: {
        name: "lookup",
        description: text,
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        outputSchema: false,
      },
    },
  })
type Response = ReturnType<typeof result>
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((done) => setTimeout(done, 0))
}
beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  } = require("@babel/core")
  const solid = require("babel-preset-solid")
  plugin({
    name: "mcp-tool-details-dom",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
        const compiled = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!compiled?.code) throw new Error("Solid compilation failed")
        return { contents: compiled.code, loader: "ts" }
      })
    },
  })
  await mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  await mock.module("@/context/server-sdk", () => ({ useServerSDK: () => source }))
  View = (await import("./mcp-tool-details")).McpToolDetails
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
})
function mount(read: () => Promise<Response>) {
  let setOwner: Setter<{ scope: string }>
  ;[source, setOwner] = createSignal({ scope: "owned/same-scope" })
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(
    render(
      () =>
        createComponent(View, {
          api: () => ({ mcp: { toolDetails: read } }),
          location: () => ({ location: { directory: "E:/owned" } }),
          capability: result("").data.capability,
          ready: () => true,
        }),
      host,
    ),
  )
  return { host, setOwner }
}
test("first asynchronous descriptor renders literal description and full false schema", async () => {
  let resolve!: (value: Response) => void
  const response = new Promise<Response>((done) => {
      resolve = done
    }),
    f = mount(() => response)
  await settle()
  expect(f.host.textContent).toContain("Reading tool details")
  const text = 'Literal <img src=x onerror="bad()"> & description'
  resolve(result(text))
  await settle()
  expect(f.host.textContent).toContain(text)
  expect(f.host.querySelectorAll("img,script,svg").length).toBe(0)
  const schemas = Array.from(f.host.querySelectorAll("details")).map((n) => ({
    title: n.querySelector("summary")?.textContent,
    json: JSON.parse(n.querySelector("pre")!.textContent!),
  }))
  expect(schemas.find((n) => n.title === "Output schema")?.json).toBe(false)
  expect(schemas.find((n) => n.title === "Complete tool definition")?.json).toEqual(result(text).data.definition)
})
test("same-scope SDK replacement clears old display and rejects a retired retry response", async () => {
  let calls = 0,
    resolveRetry!: (value: Response) => void
  const retry = new Promise<Response>((done) => {
    resolveRetry = done
  })
  const f = mount(() => {
    calls++
    return calls === 1
      ? Promise.resolve(result("initial-owner"))
      : calls === 2
        ? retry
        : Promise.resolve(result("new-owner"))
  })
  await settle()
  expect(f.host.textContent).toContain("initial-owner")
  f.host.querySelector<HTMLButtonElement>("button")!.click()
  await settle()
  f.setOwner({ scope: "owned/same-scope" })
  await settle()
  expect(calls).toBe(3)
  expect(f.host.textContent).toContain("new-owner")
  expect(f.host.textContent).not.toContain("initial-owner")
  resolveRetry(result("retired-retry"))
  await settle()
  expect(f.host.textContent).toContain("new-owner")
  expect(f.host.textContent).not.toContain("retired-retry")
})
