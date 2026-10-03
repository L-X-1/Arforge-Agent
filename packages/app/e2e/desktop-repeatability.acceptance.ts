import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const e2eRoot = resolve(import.meta.dir)
const artifacts = join(root, "artifacts")
const requestedTarget = process.env.ARFORGE_DESKTOP_ACCEPTANCE_TARGET ?? "desktop-evolution-visibility.acceptance.ts"
const target = resolve(e2eRoot, requestedTarget)
const scopedTarget = relative(e2eRoot, target)
if (scopedTarget.startsWith("..") || scopedTarget === "" || scopedTarget.includes(":"))
  throw new Error(`desktop acceptance target must stay inside ${e2eRoot}`)
if (target === resolve(import.meta.file)) throw new Error("desktop repeatability runner cannot invoke itself")

const rounds = Number(process.env.ARFORGE_DESKTOP_REPEAT ?? "3")
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
  throw new Error("ARFORGE_DESKTOP_REPEAT must be an integer between 1 and 10")

type RoundResult = {
  round: number
  duration_ms: number
  exit_code: number | null
  signal: NodeJS.Signals | null
}

const runRound = (round: number) =>
  new Promise<RoundResult>((done, fail) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [target], {
      cwd: root,
      env: {
        ...process.env,
        ARFORGE_ACCEPTANCE_ARTIFACT_SUFFIX: `-run-${round}`,
        ARFORGE_KEEP_ACCEPTANCE_PROFILE: "0",
      },
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", fail)
    child.once("exit", (exitCode, signal) =>
      done({ round, duration_ms: Date.now() - startedAt, exit_code: exitCode, signal }),
    )
  })

await mkdir(artifacts, { recursive: true })
const results: RoundResult[] = []
for (let round = 1; round <= rounds; round += 1) {
  process.stdout.write(`desktop acceptance ${round}/${rounds}: ${basename(target)}\n`)
  const result = await runRound(round)
  results.push(result)
  if (result.exit_code !== 0 || result.signal) break
}

const passed = results.length === rounds && results.every((result) => result.exit_code === 0 && !result.signal)
const report = {
  schema_version: 1,
  target: scopedTarget.replaceAll("\\", "/"),
  requested_rounds: rounds,
  completed_rounds: results.length,
  passed,
  flaky_failures_ignored: false,
  isolated_profile_per_round: true,
  generated_at: new Date().toISOString(),
  results,
}
const reportPath = join(artifacts, "desktop-repeatability-audit.json")
await writeFile(reportPath, JSON.stringify(report, null, 2))
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!passed) process.exitCode = 1
