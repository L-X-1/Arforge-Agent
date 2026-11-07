import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

const stage = resolve(import.meta.dir, "../..")
const repo = resolve(stage, "../..")
const outputs = process.env.ARFORGE_OAUTH_COORDINATOR_EVIDENCE_ROOT ?? join(tmpdir(), "arforge-oauth-coordinator")

test("two real services/providers preserve one encrypted rotating credential", async () => {
  await mkdir(outputs, { recursive: true })
  const runRoot = await mkdtemp(join(outputs, "protected-"))
  const profile = join(runRoot, "profile"), home = join(profile, "home")
  const env: Record<string, string> = {}
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"])
    if (process.env[name]) env[name] = process.env[name]!
  Object.assign(env, {
    NODE_ENV: "production", ARFORGE_HOME: join(profile, "runtime"), ARFORGE_TEST_HOME: home, HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    XDG_DATA_HOME: join(profile, "xdg/data"), XDG_CONFIG_HOME: join(profile, "xdg/config"),
    XDG_CACHE_HOME: join(profile, "xdg/cache"), XDG_STATE_HOME: join(profile, "xdg/state"),
    TEMP: join(profile, "tmp"), TMP: join(profile, "tmp"),
    ARFORGE_SECRET_MASTER_KEY: randomBytes(32).toString("base64"),
    ARFORGE_DISABLE_DEFAULT_PLUGINS: "1", ARFORGE_DISABLE_MODELS_FETCH: "1", ARFORGE_DISABLE_AUTOUPDATE: "1",
    ARFORGE_DISABLE_PROJECT_CONFIG: "1", npm_config_offline: "true", npm_config_ignore_scripts: "true",
    CROSS_PROVIDER_REPO: repo, CROSS_PROVIDER_RUN_ROOT: runRoot, CROSS_PROVIDER_STAGE_ROOT: stage,
  })
  for (const dir of [home, env.APPDATA, env.LOCALAPPDATA, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TEMP]) await mkdir(dir, { recursive: true })
  const child = spawn(join(repo, ".tools/bun-1.3.14/bun.exe"), [join(stage, "test/fixtures/oauth-refresh-protected.child.mjs")], {
    cwd: stage, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  delete env.ARFORGE_SECRET_MASTER_KEY
  let stdoutBytes = 0, stderrBytes = 0, timedOut = false
  let startupError = ""
  child.stdout.on("data", value => { stdoutBytes += value.length })
  child.stderr.on("data", value => {
    stderrBytes += value.length
    if (startupError.length < 8000) startupError += value.toString()
  })
  const watchdog = setTimeout(() => { timedOut = true; child.kill() }, 25_000)
  try {
    const exit = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done) })
    const bytes = await readFile(join(runRoot, "cross-provider-causal.child-result.json"), "utf8").catch(async error => {
      // Startup failures precede the fixture's sanitized receipt. Preserve
      // module diagnostics with random credential/key-shaped data removed.
      const diagnostic = startupError.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[redacted]")
      await writeFile(join(runRoot, "startup-error.txt"), diagnostic)
      throw error
    })
    const report = JSON.parse(bytes)
    expect({ exit, timedOut, stderrBytes }).toEqual({ exit: 0, timedOut: false, stderrBytes: 0 })
    expect(stdoutBytes).toBeGreaterThan(0)
    expect(report.passed).toBe(true)
    expect(report.counts).toMatchObject({ realAuthServices: 2, realProviders: 2, codeExchanges: 1, refreshExchanges: 1, acceptedRefreshes: 1, invalidRefreshes: 0, tokenClearsAfterWinnerSave: 0 })
    expect(report.outcomes).toEqual({ resources: "fulfilled", healthPing: "fulfilled" })
    expect(report.invariant.observedWinnerRetained).toBe(true)
    expect(report.storeFenceCases).toMatchObject({ sameByteReplacementRejectsOldSave: true, revokeRejectsOldSave: true, reconnectSurvivesOldInvalidation: true, targetAndKeyIsolationNoWire: true })
    expect(report.encryptedSnapshots.every((item: { encrypted: boolean; plaintextTokenAbsent: boolean }) => item.encrypted && item.plaintextTokenAbsent)).toBe(true)
    expect(report.cleanup).toMatchObject({ serverListening: false, clientsClosed: 2, serviceScopeClosed: true, liveOwnedHandles: [], incompleteWrites: [] })
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}, 30_000)
