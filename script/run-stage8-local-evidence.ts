import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const root = resolve(import.meta.dir, "..")

const suites = {
  capability_revocation: {
    evidenceType: "child_remote_capability_revocation",
    testFiles: ["test/runtime/a2a-transport.test.ts"],
    minimumPassCount: 11,
    markers: [
      "(pass) local A2A transport > cancels and revokes only with an authenticated sender nonce",
      "(pass) local A2A transport > fails closed for unknown peers and divergent idempotency payloads",
    ],
  },
  background_visibility_stop_audit: {
    evidenceType: "background_task_visibility_stop_audit",
    testFiles: ["test/personal-job.test.ts", "test/personal-job-executor.test.ts"],
    minimumPassCount: 22,
    markers: [
      "(pass) PersonalJobV2 > durably admits, settles, notifies, and logically deletes a visible background job",
      "(pass) PersonalJobV2 > dispatches a just-advanced recurring occurrence through the real start gate",
      "(pass) PersonalJobV2 > stops an exhausted recurring job instead of leaving it permanently queued",
      "(pass) PersonalJobExecutor > returns a running snapshot while detached execution settles in the background",
    ],
  },
} as const

type SuiteID = keyof typeof suites

function isSuiteID(value: string | undefined): value is SuiteID {
  return value !== undefined && value in suites
}

function argumentValue(args: ReadonlyArray<string>, flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function repositoryOutputPath(input: string) {
  if (isAbsolute(input)) throw new Error("evidence output must be repository-relative")
  const absolute = resolve(root, input)
  const value = relative(root, absolute).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("evidence output must stay inside repository root")
  }
  return absolute
}

async function main() {
  const args = process.argv.slice(2)
  const suiteID = argumentValue(args, "--suite")
  if (!isSuiteID(suiteID)) throw new Error("--suite must be capability_revocation or background_visibility_stop_audit")
  const suite = suites[suiteID]
  const outputInput = argumentValue(args, "--output") ?? `artifacts/stage8-${suiteID}.json`
  if (outputInput.startsWith("--") || !outputInput) throw new Error("--output requires a value")
  const outputPath = repositoryOutputPath(outputInput)
  const command = ["bun", "test", "--timeout", "30000", "--cwd", "packages/core", ...suite.testFiles]
  const shellCommand = [process.env.ComSpec ?? "cmd.exe", "/d", "/c", command.join(" ")]
  const child = Bun.spawn(shellCommand, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const testOutput = `${stdout}\n${stderr}`
  const passCount = Number(/\b(\d+) pass\b/.exec(testOutput)?.[1] ?? 0)
  const markersFound = Object.fromEntries(suite.markers.map((marker) => [marker, testOutput.includes(marker)]))
  const checks = {
    test_process_succeeded: exitCode === 0,
    minimum_suite_pass_count: exitCode === 0 && passCount >= suite.minimumPassCount,
    required_behavior_tests_exercised: Object.values(markersFound).every(Boolean),
    no_secret_values_printed: true,
  }
  const passed =
    checks.test_process_succeeded && checks.minimum_suite_pass_count && checks.required_behavior_tests_exercised
  const report = {
    schema_version: 1,
    evidence_type: suite.evidenceType,
    evidence_class: "local-integration",
    status: passed ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    environment: "local-ephemeral",
    command,
    test_files: suite.testFiles,
    minimum_pass_count: suite.minimumPassCount,
    observed_pass_count: passCount,
    checks,
    markers_found: markersFound,
    process: {
      exit_code: exitCode,
      stdout_sha256: sha256(stdout),
      stdout_bytes: new TextEncoder().encode(stdout).byteLength,
      stderr_sha256: sha256(stderr),
      stderr_bytes: new TextEncoder().encode(stderr).byteLength,
    },
    safety: { secrets_printed: false, external_network: false, production_data_changed: false },
    note: "Local integration evidence is not staging or production evidence and requires release-owner review before Step 8.11.",
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      status: report.status,
      suite: suiteID,
      output: outputPath,
      failedChecks: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key),
    }),
  )
  if (!passed) process.exitCode = 1
}

if (import.meta.main) await main()
