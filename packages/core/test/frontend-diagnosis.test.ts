import { describe, expect, test } from "bun:test"
import { FrontendDiagnosis } from "@arforge-ai/schema/frontend-diagnosis"
import { analyze, format, MAX_SOURCE_CHARS, suggestions } from "@arforge-ai/core/frontend-diagnosis"

describe("FrontendDiagnosis", () => {
  test("diagnoses a valid Vue page without probing the network", () => {
    const report = analyze({
      mode: "frontend",
      path: "index.html",
      source: `<!doctype html>
<html><body><div id="app"></div>
<script src="https://cdn.example.test/vue.js"></script>
<script defer>
const app = createApp({});
app.mount("#app");
</script></body></html>`,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      localOnly: true,
      mode: "frontend",
      success: true,
      framework: "vue3",
      script: { tags: 2, inline: 1, external: 1, blocking: 1 },
    })
    expect(report.externalAssets).toEqual([{ kind: "script", url: "https://cdn.example.test/vue.js", local: false }])
    expect(report.assetLocalizationPreview).toMatchObject({
      status: "ready",
      execution: "preview_only",
      htmlResource: "index.html",
      assetRoot: "vendor",
      networkScopeCount: 1,
      references: [{ kind: "script", url: "https://cdn.example.test/vue.js" }],
    })
    expect(report.assetLocalizationPreview?.discoveryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "blocking_script", severity: "warning" }),
        expect.objectContaining({ code: "external_asset_not_checked", severity: "info" }),
        expect.objectContaining({ code: "vue_detected", severity: "info" }),
      ]),
    )
    expect(report.issues.some((item) => item.code === "missing_mount_target")).toBe(false)
  })

  test("reports HTML, Vue, and inline JavaScript defects with line numbers", () => {
    const report = analyze({
      mode: "frontend",
      path: "broken.html",
      source: `<html><body>
<script src="https://cdn.example.test/app.js">
app = createApp({
</script>
<el-button prefix-icon="Edit">Save</el-button>
<script>createRouter({ routes: [] }); app.mount("#missing")</script>`,
    })

    expect(report.success).toBe(false)
    expect(new Set(report.issues.map((item) => item.code))).toEqual(
      new Set([
        "missing_body",
        "missing_html",
        "blocking_script",
        "unbalanced_parentheses",
        "unbalanced_braces",
        "external_asset_not_checked",
        "vue_detected",
        "missing_mount_target",
        "prefix_icon_literal",
        "router_history_unclear",
        "undeclared_app",
        "external_asset_not_checked",
      ]),
    )
    expect(report.issues.find((item) => item.code === "unbalanced_braces")?.line).toBe(3)
    expect(suggestions(report).some((item) => item.includes("line 3"))).toBe(true)
  })

  test("redacts query values and fails closed for an unsafe preview path", () => {
    const report = analyze({
      mode: "frontend",
      path: "index.html",
      source: `<html><body><script src="https://cdn.example.test/app.js?token=secret&v=1"></script></body></html>`,
    })
    expect(report.assetLocalizationPreview).toMatchObject({
      status: "ready",
      networkScopeCount: 1,
      references: [{ kind: "script" }],
    })
    const previewURL = report.assetLocalizationPreview?.references[0]?.url ?? ""
    expect(previewURL).toContain("token=")
    expect(previewURL).not.toContain("secret")
    expect(report.externalAssets[0]?.url).toBe("https://cdn.example.test/app.js?token=%5BREDACTED%5D&v=%5BREDACTED%5D")
    expect(report.issues.find((item) => item.code === "external_asset_not_checked")?.detail).not.toContain("secret")
    expect(format(report)).not.toContain("token=secret")

    const blocked = analyze({
      mode: "frontend",
      path: "C:\\outside\\index.html",
      source: "<html><body></body></html>",
    })
    expect(blocked.assetLocalizationPreview).toMatchObject({
      status: "blocked",
      execution: "preview_only",
      networkScopeCount: 0,
    })
    expect(blocked.assetLocalizationPreview?.reason).toContain("unsafe_resource")
  })

  test("ignores delimiters in strings and comments in JavaScript mode", () => {
    const valid = analyze({
      mode: "javascript",
      path: "app.js",
      source: `const text = "{ [ ] }";
// } ] )
function run() { return [1, 2].map((value) => value + 1) }
/* { [ ( ignored ) ] } */`,
    })
    expect(valid.success).toBe(true)
    expect(valid.issues).toEqual([])

    const invalid = analyze({ mode: "javascript", path: "bad.js", source: "function run( { return 1;" })
    expect(invalid.success).toBe(false)
    expect(invalid.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["unbalanced_parentheses", "unbalanced_braces"]),
    )
  })

  test("bounds source size and rejects empty input deterministically", () => {
    const report = analyze({ mode: "javascript", path: "large.js", source: "x".repeat(MAX_SOURCE_CHARS + 10) })
    expect(report.truncated).toBe(true)
    expect(report.textChars).toBe(MAX_SOURCE_CHARS)

    const empty = analyze({ mode: "javascript", path: "empty.js", source: "" })
    expect(empty).toMatchObject({ success: false, issues: [expect.objectContaining({ code: "empty_source" })] })
    expect(FrontendDiagnosis.Report).toBeDefined()
  })
})
