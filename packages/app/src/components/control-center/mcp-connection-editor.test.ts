import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { McpConnectionEditorProps } from "./mcp-connection-editor"
import type { ConfigMcpMap, McpEntry } from "./mcp-connection-state"

let Editor: typeof import("./mcp-connection-editor").McpConnectionEditor
const disposals: (() => void)[] = []
const local: McpEntry = {
  type: "local",
  command: ["node", "server.js"],
  cwd: "./tools",
  environment: { TOKEN: "synthetic-only" },
}
const remote: McpEntry = {
  type: "remote",
  url: "https://mcp.example.test",
  headers: { Authorization: "synthetic-only" },
  oauth: { clientId: "client", clientSecret: "synthetic-only", callbackPort: 19876 },
}
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel: {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  } = require("@babel/core")
  const solid = require("babel-preset-solid")
  plugin({
    name: "mcp-connection-editor-dom",
    setup(build) {
      build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Solid compilation failed")
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  await mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  Editor = (await import("./mcp-connection-editor")).McpConnectionEditor
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
})

function mount(overrides: Partial<McpConnectionEditorProps> = {}) {
  const writes: { name: string; value: McpEntry }[] = []
  const [props, setProps] = createStore<McpConnectionEditorProps>({
    name: "local",
    scope: "a/workspace/1",
    ready: true,
    load: async (): Promise<ConfigMcpMap> => ({ local, remote }),
    save: async (name, value) => {
      writes.push({ name, value })
    },
    onClose: () => {},
    ...overrides,
  })
  const host = document.createElement("section")
  host.dataset.testid = "mcp-management"
  document.body.append(host)
  disposals.push(render(() => createComponent(Editor, props), host))
  const field = (name: string) => {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id$="-${name}"]`)
    if (!input) throw new Error("Missing form field: " + name)
    return input
  }
  const fill = (name: string, value: string) => {
    const input = field(name)
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    return input
  }
  const submit = () =>
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  return { host, field, fill, submit, writes, setProps }
}

test("real local fields retain input node/focus while typing masked environment values and collapsing", async () => {
  const f = mount()
  await settle()
  expect((f.field("name") as HTMLInputElement).readOnly).toBe(true)
  const connectionType = f.host.querySelector('[data-component="select-v2"]')!
  const typeLabel = connectionType
    .getAttribute("aria-labelledby")
    ?.split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ")
  expect(typeLabel).toContain("Connection type")
  const input = f.field("environment-0-value") as HTMLInputElement
  expect(input.type).toBe("password")
  input.focus()
  f.fill("environment-0-value", "synthetic-new")
  expect(f.field("environment-0-value")).toBe(input)
  expect(document.activeElement).toBe(input)
  const details = f.host.querySelector("details")!
  details.open = false
  details.open = true
  expect(f.field("environment-0-value").value).toBe("synthetic-new")
  f.submit()
  await settle()
  expect(f.writes).toMatchObject([{ name: "local", value: { environment: { TOKEN: "synthetic-new" } } }])
})

test("real remote form masks headers/client secret and preserves them during an unrelated URL edit", async () => {
  const f = mount({ name: "remote" })
  await settle()
  expect((f.field("clientSecret") as HTMLInputElement).type).toBe("password")
  expect((f.field("headers-0-value") as HTMLInputElement).type).toBe("password")
  expect(f.field("callbackPort").value).toBe("19876")
  f.fill("url", "https://new.example.test/mcp")
  f.submit()
  await settle()
  expect(f.writes).toEqual([{ name: "remote", value: { ...remote, url: "https://new.example.test/mcp" } }])
})

test("an existing reserved object name remains visible in a truthful read-only form", async () => {
  const f = mount({ name: "constructor", load: async () => Object.fromEntries([["constructor", local]]) })
  await settle()
  expect(f.field("name").value).toBe("constructor")
  expect((f.field("name") as HTMLInputElement).readOnly).toBe(true)
  expect(f.field("cwd").disabled).toBe(true)
  expect(f.host.textContent).toContain("configuration is read-only")
  f.submit()
  await settle()
  expect(f.writes).toHaveLength(0)
})

test("rendered invalid input/save failure retains fields and does not expose raw error secrets", async () => {
  const f = mount({
    save: async () => {
      throw new Error("NEVER-ECHO-THIS-SYNTHETIC-SECRET")
    },
  })
  await settle()
  f.fill("command", "not-json")
  f.submit()
  await settle()
  expect(f.field("command").value).toBe("not-json")
  expect(f.host.textContent).toContain("Enter a JSON array")
  f.fill("command", '["node", "new.js"]')
  f.submit()
  await settle()
  expect(f.field("command").value).toBe('["node", "new.js"]')
  expect(f.host.textContent).toContain("Your input is retained")
  expect(f.host.textContent).not.toContain("NEVER-ECHO")
})

test("catalog callback replacement does not reload or replace a draft; source epochs do", async () => {
  let loads = 0
  const f = mount({
    load: async () => {
      loads++
      return { local, remote }
    },
  })
  await settle()
  f.fill("cwd", "./draft")
  const input = f.field("cwd")
  f.setProps("load", () => async () => {
    loads++
    return { local, remote }
  })
  await settle()
  expect(loads).toBe(1)
  expect(f.field("cwd")).toBe(input)
  expect(f.field("cwd").value).toBe("./draft")
  f.setProps({ scope: "a/workspace/2", name: "remote" })
  await settle()
  expect(loads).toBe(2)
  expect(f.field("url").value).toBe("https://mcp.example.test")
})

test("a newly saved connection keeps its acknowledgement until an actual edit and locks only its name", async () => {
  let saved = 0
  const f = mount({ name: undefined, load: async () => ({}), onSaved: () => saved++ })
  await settle()
  f.fill("name", "new-connection")
  f.fill("command", '["node", "--version"]')
  f.fill("cwd", "./owned")
  f.submit()
  await settle()
  expect(f.writes).toHaveLength(1)
  expect(f.field("name").value).toBe("new-connection")
  expect((f.field("name") as HTMLInputElement).readOnly).toBe(true)
  expect(f.field("command").value).toBe('["node", "--version"]')
  expect(f.host.textContent).toContain("Configuration saved.")
  expect(saved).toBe(1)
  f.fill("cwd", "./new-edit")
  expect(f.host.textContent).not.toContain("Configuration saved.")
  f.submit()
  await settle()
  expect(f.writes).toHaveLength(2)
  expect(f.writes[1]).toMatchObject({ name: "new-connection", value: { cwd: "./new-edit" } })
  expect(f.host.textContent).toContain("Configuration saved.")
  expect(saved).toBe(2)
})

test("mount focuses from its own opener once; a delayed read never steals later focus", async () => {
  let resolve!: (map: ConfigMcpMap) => void
  const pending = new Promise<ConfigMcpMap>((accept) => {
    resolve = accept
  })
  const host = document.createElement("section")
  host.dataset.testid = "mcp-management"
  const opener = document.createElement("button")
  const editorHost = document.createElement("div")
  const otherInput = document.createElement("input")
  host.append(opener, editorHost, otherInput)
  document.body.append(host)
  opener.focus()
  disposals.push(
    render(
      () =>
        createComponent(Editor, {
          name: "local",
          scope: "a",
          ready: true,
          load: () => pending,
          save: async () => {},
          onClose: () => {},
        }),
      editorHost,
    ),
  )
  expect(document.activeElement).toBe(editorHost.querySelector("summary"))
  otherInput.focus()
  resolve({ local })
  await settle()
  expect(document.activeElement).toBe(otherInput)
})
