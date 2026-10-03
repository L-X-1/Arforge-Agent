import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type Diagnostic = { time: number; stage: string; event: string; csp?: string | null; elapsed_ms?: number }
type DesktopReport = {
  passed: boolean
  run_root: string
  checks: string[]
  diagnostics: Diagnostic[]
  security_console: { url: string; message: string }[]
  app_stderr: string
  renderer_errors: unknown[]
  api_failures: unknown[]
  vcs_diff_responses: number[]
}

const appRoot = fileURLToPath(new URL("../", import.meta.url))
const reportPath = resolve(appRoot, "../../artifacts/desktop-browser-security-audit.json")
const baseline = process.env.ARFORGE_SECURITY_BASELINE_NAV_MS
  ? Number(process.env.ARFORGE_SECURITY_BASELINE_NAV_MS)
  : undefined
if (baseline !== undefined) assert.ok(Number.isFinite(baseline) && baseline >= 0, "Invalid navigation baseline")
const summary: Record<string, unknown> = { passed: false, launch_mode: "real-built-desktop" }

try {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./desktop-browser-workbench.acceptance.ts", import.meta.url))], {
    cwd: appRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let stdout = ""
  let pending = ""
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString()
    stdout += text
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) {
      if (line.startsWith("BROWSER_DESKTOP_STAGE ")) console.log(line)
    }
  })
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const line = stdout.split(/\r?\n/).find((line) => line.startsWith("BROWSER_DESKTOP_ACCEPTANCE "))
  assert.ok(line, "The real desktop acceptance did not produce a report")
  const report = JSON.parse(line.slice("BROWSER_DESKTOP_ACCEPTANCE ".length)) as DesktopReport
  summary.desktop_run_root = report.run_root
  summary.desktop_checks = report.checks
  assert.equal(code, 0, "Real desktop acceptance failed")
  assert.equal(report.passed, true)

  const policies = report.diagnostics.filter((event) => event.event === "renderer-document-policy")
  assert.ok(policies.length > 0, "No real renderer document response was observed")
  for (const event of policies) {
    assert.ok(event.csp, "The application renderer has no CSP response header")
    const scripts = event.csp.split(";").map((entry) => entry.trim().split(/\s+/)).find(([name]) => name === "script-src")
    assert.deepEqual(scripts, ["script-src", "'self'", "'wasm-unsafe-eval'"], "Renderer script policy was weakened")
  }
  const ownWarnings = report.security_console.filter((entry) => entry.url.startsWith("arforge://renderer/"))
  assert.deepEqual(ownWarnings, [], "The application renderer still produces security warnings")
  assert.ok(!report.app_stderr.includes("'console-message' arguments are deprecated"), "Deprecated console listener remains")
  assert.ok(!report.app_stderr.includes("Failed to load sessions"), "Reload still reports a session loading failure")
  assert.ok(!report.app_stderr.includes("Failed to resume session loading"), "Page restoration failed")
  assert.deepEqual(report.renderer_errors, [])
  assert.deepEqual(report.api_failures, [])
  assert.ok(report.vcs_diff_responses.length > 0 && report.vcs_diff_responses.every((status) => status === 200))

  const firstTime = (stage: string) => report.diagnostics.find((entry) => entry.stage === stage)?.time
  const navigation = firstTime("wait-for-home-and-open-real-session-tabs")
  const browser = firstTime("ui-browser-open-address-and-native-bounds")
  assert.ok(navigation !== undefined && browser !== undefined, "Navigation timing evidence is missing")
  const navigationMs = browser - navigation
  Object.assign(summary, {
    passed: true,
    renderer_csp: policies.map((entry) => entry.csp),
    own_security_warnings: ownWarnings.length,
    external_document_security_warnings: report.security_console.length - ownWarnings.length,
    deprecated_console_listener: false,
    session_reload_failure: false,
    vcs_diff_responses: report.vcs_diff_responses,
    performance: {
      kind: "single-run production-build diagnostic timing, not a statistical benchmark",
      session_navigation_to_browser_stage_ms: navigationMs,
      baseline_ms: baseline,
      delta_ms: baseline === undefined ? undefined : navigationMs - baseline,
      native_close_ms: report.diagnostics.find((entry) => entry.event === "native-page-destroyed")?.elapsed_ms,
    },
  })
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(summary, null, 2) + "\n")
  console.log(`BROWSER_DESKTOP_SECURITY_ACCEPTANCE ${JSON.stringify(summary)}`)
}
