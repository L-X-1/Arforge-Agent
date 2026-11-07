// Production Solid component and typed client; only transport, locale and download environment are controlled.
import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createOperationsApiForServer } from "@/utils/server"
import type { ArtifactReference } from "@/components/control-center/artifact-content"

let Content: typeof import("@/components/control-center/artifact-content-preview").ArtifactContentPreview
const disposals: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid")), babel = require("@babel/core"), solid = require("babel-preset-solid")
  await plugin({ name: "artifact-content-solid-dom", setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await Bun.file(path).text(), { filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solid.default ?? solid, { generate: "dom" }]] })
      if (!result?.code) throw Error("Solid compilation failed: " + path)
      return { contents: result.code, loader: "ts" }
    })
  } })
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  Content = (await import("@/components/control-center/artifact-content-preview")).ArtifactContentPreview
})
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren() })

const bytes = new TextEncoder().encode("<script>not executable</script>\nRetained output")
const digest = createHash("sha256").update(bytes).digest("hex")
const reference: ArtifactReference = { version: 1, artifactID: "art_" + digest, kind: "tool_output", digest, mime: "text/plain", sizeBytes: bytes.length,
  owner: { scope: "session", id: "ses_owned" }, retention: { mode: "session" }, retrievalHint: { kind: "managed", handle: "artifact_bound_owned" }, createdAt: 1000 }
function api(handler: () => Promise<Response> | Response) {
  return createOperationsApiForServer({ server: { url: "http://127.0.0.1:4096" }, fetch: Object.assign(async () => handler(), { preconnect: globalThis.fetch.preconnect }) })
}
function fixture(client = api(() => new Response(bytes))) {
  // API instances are immutable source owners. A store merge would mutate
  // methods in place and would not model the production instance replacement.
  const clients = [client]
  const [state, setState] = createStore({ apiIndex: 0, reference, scope: "server-A/session", ready: true, ownerPresent: true })
  let reads = 0
  const host = document.createElement("div"); document.body.append(host)
  disposals.push(render(() => createComponent(Content, { api: () => clients[state.apiIndex]!, get reference() { return state.reference },
    get owner() { return state.ownerPresent ? state.reference.owner : undefined }, get scopeKey() { return state.scope }, get ready() { return state.ready }, onRead: () => { reads++ } }), host))
  const click = (id: string) => host.querySelector<HTMLButtonElement>('[data-testid="artifact-content-' + id + '"]')!.click()
  return { host, setState, click, reads: () => reads, replaceAPI: (next: typeof client) => { clients.push(next); setState("apiIndex", clients.length - 1) } }
}

test("preview is explicit, verifies text, and does not interpret markup", async () => {
  let calls = 0
  const f = fixture(api(() => { calls++; return new Response(bytes) }))
  await settle(); expect(calls).toBe(0)
  f.click("preview"); await settle()
  expect(f.host.querySelector("pre")?.textContent).toBe(new TextDecoder().decode(bytes))
  expect(f.host.querySelector("script") === null).toBe(true)
  expect(f.host.textContent).toContain("Full content digest and size verified")
  expect(f.reads()).toBe(1)
})

test("cancelling a held read leaves selection intact and cannot display its late bytes", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(api(async () => { await gate; return new Response(bytes) }))
  await settle(); f.click("preview"); await settle(); f.click("cancel")
  release(); await settle()
  expect(f.host.querySelector("pre") === null).toBe(true); expect(f.reads()).toBe(0)
  expect(f.host.querySelector<HTMLButtonElement>('[data-testid="artifact-content-preview"]')?.disabled).toBe(false)
})

test("same-ID server rebind fences the captured response before new source can read", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(api(async () => { await gate; return new Response(bytes) }))
  await settle(); f.click("preview"); await settle()
  f.replaceAPI(api(() => new Response(bytes))); release(); await settle()
  expect(f.host.querySelector("pre") === null).toBe(true); expect(f.reads()).toBe(0)
  f.click("preview"); await settle(); expect(f.reads()).toBe(1)
})

test("receipt selection change and disposal suppress late preview callbacks", async () => {
  for (const dispose of [false, true]) {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    const f = fixture(api(async () => { await gate; return new Response(bytes) }))
    await settle(); f.click("preview"); await settle()
    if (dispose) disposals.pop()!()
    else f.setState("reference", { ...reference, retrievalHint: { kind: "managed", handle: "different_receipt" } })
    release(); await settle(); expect(f.host.querySelector("pre") === null).toBe(true); expect(f.reads()).toBe(0)
  }
})

test("a fresh denied read clears earlier content and reports the real failure", async () => {
  let denied = false
  const f = fixture(api(() => denied ? Response.json({ message: "denied" }, { status: 403 }) : new Response(bytes)))
  await settle(); f.click("preview"); await settle(); expect(f.reads()).toBe(1)
  denied = true; f.click("preview"); await settle()
  expect(f.host.querySelector("pre") === null).toBe(true); expect(f.host.querySelector('[role="alert"]') !== null).toBe(true)
  expect(f.reads()).toBe(1)
})

test("losing the selected owner fences a pending read without inferring one from the receipt", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(api(async () => { await gate; return new Response(bytes) }))
  await settle(); f.click("preview"); await settle(); f.setState("ownerPresent", false)
  release(); await settle()
  expect(f.host.querySelector("pre") === null).toBe(true); expect(f.reads()).toBe(0)
  expect(f.host.querySelector<HTMLButtonElement>('[data-testid="artifact-content-preview"]')?.disabled).toBe(true)
})

test("download makes a fresh authorized read and retains exact MIME/bytes", async () => {
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalClick = HTMLAnchorElement.prototype.click
  const blobs: Blob[] = [], downloads: string[] = [], revoked: string[] = []
  URL.createObjectURL = blob => { blobs.push(blob); return "blob:owned-artifact" }
  URL.revokeObjectURL = url => { revoked.push(url) }
  HTMLAnchorElement.prototype.click = function () { downloads.push(this.download) }
  try {
    let calls = 0; const f = fixture(api(() => { calls++; return new Response(bytes) }))
    await settle(); f.click("preview"); await settle(); f.click("download"); await settle()
    expect(calls).toBe(2); expect(f.reads()).toBe(2); expect(downloads).toHaveLength(1)
    expect(blobs[0].type).toBe("text/plain"); expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(bytes)
    disposals.pop()!(); expect(revoked).toContain("blob:owned-artifact")
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; HTMLAnchorElement.prototype.click = originalClick }
})
