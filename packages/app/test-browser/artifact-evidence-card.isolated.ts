// Full production card/collection/detail/reader, including real metadata replacement after a read.
import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createOperationsApiForServer } from "@/utils/server"
import type { ArtifactReference } from "@/components/control-center/artifact-content"

let Card: typeof import("@/components/control-center/artifact-evidence-workbench").ArtifactEvidenceWorkbench
const disposals: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid")), babel = require("@babel/core"), solid = require("babel-preset-solid")
  await plugin({ name: "artifact-card-solid-dom", setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await Bun.file(path).text(), { filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solid.default ?? solid, { generate: "dom" }]] })
      if (!result?.code) throw Error("Solid compilation failed: " + path)
      return { contents: result.code, loader: "ts" }
    })
  } })
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en", intl: () => "en-US", t: (key: string) => key }) }))
  Card = (await import("@/components/control-center/artifact-evidence-workbench")).ArtifactEvidenceWorkbench
})
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren() })
const bytes = new TextEncoder().encode("Full card retained tool output")
const digest = createHash("sha256").update(bytes).digest("hex")
const original: ArtifactReference = { version: 1, artifactID: "art_" + digest, kind: "tool_output", digest, mime: "text/plain", sizeBytes: bytes.length,
  owner: { scope: "session", id: "ses_owned" }, retention: { mode: "session" }, retrievalHint: { kind: "managed", handle: "artifact_bound_owned" }, createdAt: 1000 }

function fixture() {
  let reads = 0, catalogs = 0, audits = 0, changed = false
  const makeAPI = () => createOperationsApiForServer({ server: { url: "http://127.0.0.1:4096" }, fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname
    const reference = changed ? { ...original, retrievalHint: { kind: "managed", handle: "new_receipt" } } : original
    if (path.endsWith("/catalog")) { catalogs++; return Response.json({ entries: [{reference, firstSeenAt: 1000, lastSeenAt: 1000 + reads, lastSequence: 1 + reads, readCount: reads}], headSequence: 1 + reads, headHash: "b".repeat(64), droppedAuditEntries: 0 }) }
    if (path.endsWith("/audit")) { audits++; return Response.json([{sequence: 1 + reads, recordedAt: 1000, actor: reads ? "usr_owner" : "runtime", action: reads ? "read" : "registered", artifactID: original.artifactID, digest, owner: original.owner, previousHash: "genesis", recordHash: "b".repeat(64)}]) }
    if (path.endsWith("/read")) { reads++; return new Response(bytes) }
    throw Error("Unexpected fixture route " + path)
  }, { preconnect: globalThis.fetch.preconnect }) })
  const clients = [makeAPI()], [state, setState] = createStore({ apiIndex: 0 })
  const host = document.createElement("div"); document.body.append(host)
  disposals.push(render(() => createComponent(Card, { api: () => clients[state.apiIndex]!, sessionID: "ses_owned", ready: () => true }), host))
  const select = () => host.querySelector<HTMLButtonElement>('[data-management-detail-id="receipt:' + original.artifactID + '"]')!.click()
  const click = (id: string) => host.querySelector<HTMLButtonElement>('[data-testid="artifact-' + id + '"]')!.click()
  return {host, select, click, counts: () => ({reads, catalogs, audits}), changeReceipt: () => { changed = true }, replaceAPI: () => { clients.push(makeAPI()); setState("apiIndex", clients.length - 1) }}
}

test("full artifact card retains verified preview through the onRead catalog/audit replacement", async () => {
  const f = fixture(); await settle(); f.select(); await settle(); f.click("content-preview"); await settle()
  expect(f.counts()).toEqual({reads: 1, catalogs: 2, audits: 2})
  expect(f.host.querySelector('[data-testid="artifact-content-text"]')?.textContent).toBe(new TextDecoder().decode(bytes))
  expect(f.host.querySelector('[data-testid="artifact-content-preview"]')?.getAttribute("data-component")).toBe("button-v2")
  expect(f.host.textContent).toContain("usr_owner")
})

test("full card clears preview on changed receipt and equal-session API replacement", async () => {
  const f = fixture(); await settle(); f.select(); await settle(); f.click("content-preview"); await settle()
  f.changeReceipt(); f.click("evidence-refresh"); await settle()
  expect(f.host.querySelector('[data-testid="artifact-content-text"]') === null).toBe(true)
  f.select(); await settle(); f.click("content-preview"); await settle()
  expect(f.host.querySelector('[data-testid="artifact-content-text"]')?.textContent).toBe(new TextDecoder().decode(bytes))
  f.replaceAPI(); await settle()
  expect(f.host.querySelector('[data-testid="artifact-content-text"]') === null).toBe(true)
})

test("collapsing the selected receipt hides its whole inspector and reopening retains verified bytes", async () => {
  const f = fixture(); await settle(); f.select(); await settle(); f.click("content-preview"); await settle()
  const details = f.host.querySelector<HTMLDetailsElement>("details")!, summary = details.querySelector("summary")!
  summary.click(); await settle()
  expect(details.open).toBe(false)
  const content = f.host.querySelector('[data-testid="artifact-content-text"]')
  expect(content !== null).toBe(true)
  expect(content?.closest("details")?.open === false || content?.closest('[hidden], [inert], [aria-hidden="true"]') !== null).toBe(true)
  summary.click(); await settle()
  expect(details.open).toBe(true)
  expect(f.host.querySelector('[data-testid="artifact-content-text"]')?.textContent).toBe(new TextDecoder().decode(bytes))
  expect(f.counts().reads).toBe(1)
})
