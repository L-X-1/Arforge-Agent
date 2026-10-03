import { describe, expect, it } from "bun:test"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import { createHash } from "node:crypto"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

describe("AssetLocalization", () => {
  it("creates a stable pre-fetch discovery snapshot and rejects a changed document", () => {
    const html = '<script src="https://cdn.example.test/app.js"></script>'
    const discovery = AssetLocalization.discover({ htmlResource: "src/index.html", html, assetRoot: "vendor" })
    expect(discovery.schemaVersion).toBe(1)
    expect(discovery.htmlDigest).toBe(digest(html))
    expect(discovery.networkScope).toEqual(["https://cdn.example.test/app.js"])
    expect(discovery.filesystemScope).toEqual(["src/index.html"])
    expect(discovery.requestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      AssetLocalization.discover({ htmlResource: "src/index.html", html, assetRoot: "vendor" }).requestDigest,
    ).toBe(discovery.requestDigest)

    const plan = AssetLocalization.plan({
      htmlResource: "src/index.html",
      html,
      assetRoot: "vendor",
      discovery,
      fetchedAssets: [
        {
          url: "https://cdn.example.test/app.js",
          contentType: "text/javascript",
          bytes: new TextEncoder().encode("console.log('ok')"),
        },
      ],
    })
    expect(plan.discoveryDigest).toBe(discovery.requestDigest)
    expect(AssetLocalization.actionDescriptor(plan).discoveryDigest).toBe(discovery.requestDigest)

    expect(() =>
      AssetLocalization.plan({
        htmlResource: "src/index.html",
        html: '<script src="https://cdn.example.test/changed.js"></script>',
        assetRoot: "vendor",
        discovery,
        fetchedAssets: [],
      }),
    ).toThrow("changed after discovery")
  })

  it("plans one deterministic rewrite, deduplicating equal bytes by kind", () => {
    const html = [
      '<script src="https://cdn.example.test/vue.js"></script>',
      '<link rel="stylesheet" href="https://cdn.example.test/app.css">',
      '<script src="https://mirror.example.test/vue.js"></script>',
      "<!-- https://cdn.example.test/vue.js must not be rewritten -->",
    ].join("\n")
    const vue = "window.Vue = {};"
    const plan = AssetLocalization.plan({
      htmlResource: "src/index.html",
      html,
      assetRoot: "vendor",
      fetchedAssets: [
        {
          url: "https://cdn.example.test/vue.js",
          contentType: "text/javascript; charset=utf-8",
          bytes: new TextEncoder().encode(vue),
        },
        {
          url: "https://mirror.example.test/vue.js",
          contentType: "application/javascript",
          bytes: new TextEncoder().encode(vue),
        },
        {
          url: "https://cdn.example.test/app.css",
          contentType: "text/css",
          bytes: new TextEncoder().encode("body { color: red; }"),
        },
      ],
    })

    expect(plan.changed).toBe(true)
    expect(plan.references).toHaveLength(3)
    expect(plan.stagedAssets).toHaveLength(2)
    expect(plan.writes).toHaveLength(3)
    expect(plan.htmlDigest).toBe(digest(html))
    expect(plan.networkScope).toEqual([
      "https://cdn.example.test/app.css",
      "https://cdn.example.test/vue.js",
      "https://mirror.example.test/vue.js",
    ])
    expect(plan.filesystemScope).toEqual([
      "src/index.html",
      `src/vendor/css/${digest("body { color: red; }")}.css`,
      `src/vendor/js/${digest(vue)}.js`,
    ])

    const rewritten = plan.writes.find((write) => write.target === "src/index.html")?.content
    expect(rewritten).toContain(`vendor/js/${digest(vue)}.js`)
    expect(rewritten).toContain(`vendor/css/${digest("body { color: red; }")}.css`)
    expect(rewritten).toContain("<!-- https://cdn.example.test/vue.js must not be rewritten -->")
    expect(AssetLocalization.actionDescriptor(plan)).toEqual({
      actionKind: "asset-localization",
      actionVersion: "1",
      inputDigest: plan.inputDigest,
      discoveryDigest: plan.discoveryDigest,
      idempotencyKey: plan.idempotencyKey,
      networkScope: plan.networkScope,
      filesystemScope: plan.filesystemScope,
      expectedArtifacts: plan.filesystemScope,
    })
  })

  it("is a no-op when a document has no external script or stylesheet", () => {
    const plan = AssetLocalization.plan({
      htmlResource: "index.html",
      html: '<script src="/app.js"></script><link rel="stylesheet" href="./app.css">',
      fetchedAssets: [],
    })
    expect(plan.changed).toBe(false)
    expect(plan.references).toEqual([])
    expect(plan.writes).toEqual([])
    expect(plan.networkScope).toEqual([])
    expect(plan.rewrittenHtmlDigest).toBe(plan.htmlDigest)
  })

  it("fails closed before returning writes when a reference is missing", () => {
    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<script src="https://cdn.example.test/app.js"></script>',
        fetchedAssets: [],
      }),
    ).toThrow("Every external reference must be fetched")
  })

  it("binds a validated redirect destination into the action scope", () => {
    const plan = AssetLocalization.plan({
      htmlResource: "index.html",
      html: '<script src="https://cdn.example.test/app.js"></script>',
      fetchedAssets: [
        {
          url: "https://cdn.example.test/app.js",
          redirects: ["https://redirect.example.test/app.js", "https://assets.example.test/app-v2.js"],
          finalURL: "https://assets.example.test/app-v2.js",
          contentType: "text/javascript",
          bytes: new TextEncoder().encode("console.log('ok')"),
        },
      ],
    })
    expect(plan.networkScope).toEqual([
      "https://assets.example.test/app-v2.js",
      "https://cdn.example.test/app.js",
      "https://redirect.example.test/app.js",
    ])
    expect(plan.stagedAssets[0]?.resolvedURLs).toEqual([
      "https://redirect.example.test/app.js",
      "https://assets.example.test/app-v2.js",
    ])
  })

  it("rejects unsafe URLs, credentials, invalid redirects, and wrong MIME types", () => {
    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<script src="https://user:secret@cdn.example.test/app.js"></script>',
        fetchedAssets: [],
      }),
    ).toThrow("credentials")

    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<script src="https://cdn.example.test/app.js"></script>',
        fetchedAssets: [
          {
            url: "https://cdn.example.test/app.js",
            finalURL: "file:///tmp/app.js",
            contentType: "text/javascript",
            bytes: new Uint8Array([1]),
          },
        ],
      }),
    ).toThrow("http:// or https://")

    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<link rel="stylesheet" href="https://cdn.example.test/app.css">',
        fetchedAssets: [
          {
            url: "https://cdn.example.test/app.css",
            contentType: "text/html",
            bytes: new Uint8Array([1]),
          },
        ],
      }),
    ).toThrow("JavaScript/CSS content type")
  })

  it("rejects nested stylesheet URLs and oversized inputs", () => {
    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<link rel="stylesheet" href="https://cdn.example.test/app.css">',
        fetchedAssets: [
          {
            url: "https://cdn.example.test/app.css",
            contentType: "text/css",
            bytes: new TextEncoder().encode('@import url("https://cdn.example.test/other.css");'),
          },
        ],
      }),
    ).toThrow("nested external references")

    expect(() =>
      AssetLocalization.plan({
        htmlResource: "index.html",
        html: '<script src="https://cdn.example.test/app.js"></script>',
        fetchedAssets: [
          {
            url: "https://cdn.example.test/app.js",
            contentType: "text/javascript",
            bytes: new Uint8Array(AssetLocalization.MAX_ASSET_BYTES + 1),
          },
        ],
      }),
    ).toThrow("byte limit")

    expect(() =>
      AssetLocalization.plan({
        htmlResource: "../index.html",
        html: "<html></html>",
        fetchedAssets: [],
      }),
    ).toThrow("workspace-relative")
  })

  it("bounds the number of external references before any fetch is required", () => {
    const html = Array.from(
      { length: AssetLocalization.MAX_REFERENCES + 1 },
      (_, index) => `<script src="https://cdn.example.test/${index}.js"></script>`,
    ).join("")
    expect(() => AssetLocalization.plan({ htmlResource: "index.html", html, fetchedAssets: [] })).toThrow(
      `at most ${AssetLocalization.MAX_REFERENCES}`,
    )
  })
})
