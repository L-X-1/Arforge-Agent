import { expect, test } from "bun:test"
import {
  documentPolicyHeader,
  jsCallStacksDocumentPolicy,
  rendererContentSecurityPolicy,
  withRendererDocumentPolicy,
} from "./renderer-security"

const directives = new Map(
  rendererContentSecurityPolicy.split("; ").map((directive) => {
    const [name, ...sources] = directive.split(" ")
    return [name, sources] as const
  }),
)

test("renderer policy permits bundled scripts and WASM but not arbitrary JavaScript", () => {
  expect(directives.get("default-src")).toEqual(["'none'"])
  expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"])
  expect(directives.get("script-src-attr")).toEqual(["'none'"])
  expect(directives.get("object-src")).toEqual(["'none'"])
  expect(directives.get("frame-ancestors")).toEqual(["'none'"])
})

test("renderer policy preserves server connections, workers and capability previews", () => {
  expect(directives.get("connect-src")).toEqual(["'self'", "http:", "https:", "ws:", "wss:", "data:", "blob:"])
  expect(directives.get("worker-src")).toEqual(["'self'", "blob:"])
  expect(directives.get("base-uri")).toEqual(["'self'", "http://127.0.0.2:*"])
  expect(directives.get("frame-src")).toContain("http://127.0.0.2:*")
  expect(directives.get("frame-src")).not.toContain("https:")
})

test("HTML responses receive both policies without losing headers, status or body", async () => {
  const response = new Response("<main>renderer</main>", {
    status: 203,
    statusText: "Non-Authoritative Information",
    headers: { "content-type": "text/html", "x-existing": "retained" },
  })
  const secured = withRendererDocumentPolicy(response, "C:\\app\\renderer\\index.HTML")
  expect(secured.headers.get("Content-Security-Policy")).toBe(rendererContentSecurityPolicy)
  expect(secured.headers.get(documentPolicyHeader)).toBe(jsCallStacksDocumentPolicy)
  expect(secured.headers.get("x-existing")).toBe("retained")
  expect(secured.headers.get("content-type")).toBe("text/html")
  expect(secured.status).toBe(203)
  expect(secured.statusText).toBe("Non-Authoritative Information")
  expect(await secured.text()).toBe("<main>renderer</main>")
})

test("non-document resources keep their original response and range headers", () => {
  const response = new Response("asset", { status: 206, headers: { "content-range": "bytes 0-4/10" } })
  expect(withRendererDocumentPolicy(response, "/renderer/assets/main.js")).toBe(response)
  expect(response.headers.get("Content-Security-Policy")).toBeNull()
  expect(response.headers.get("content-range")).toBe("bytes 0-4/10")
})
