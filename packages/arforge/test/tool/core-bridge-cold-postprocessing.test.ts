import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "../fixture/fixture"

type Record = {
  actionID: string
  executions: number
  hooks: number
  sequence: number
  state: string
  originalEncoding: string
  projectedEncoding?: string
  catalogSequence: number
  original: unknown
  projected?: unknown
  result?: { result: { type: string; value?: string }; output?: { structured?: unknown } }
}

const runWorker = async (
  directory: string,
  mode: "started" | "completed" | "historical" | "read",
  size = "small",
  carrierKind = "external",
) => {
  const databasePath = join(directory, "actions.db")
  const markerPath = join(directory, `${mode}.json`)
  let requestedKill = false
  let timedOut = false
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../fixture/tool-postprocessing-worker.ts"),
      databasePath,
      mode,
      markerPath,
      size,
      carrierKind,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        ARFORGE_HOME: join(directory, "profile"),
        ARFORGE_DB: databasePath,
        ARFORGE_DB_URL: "",
        ARFORGE_DB_ADMIN_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      ...(mode === "read"
        ? {}
        : {
            ipc: (message: unknown, subprocess: Pick<Bun.Subprocess, "kill">) => {
              if (
                !message ||
                typeof message !== "object" ||
                !("type" in message) ||
                message.type !== "native-post-ready"
              )
                return
              requestedKill = true
              subprocess.kill("SIGKILL")
            },
          }),
    },
  )
  const guard = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 20_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(guard))
  if (timedOut) throw new Error(`Native postprocessing ${mode} worker timed out`)
  if (mode === "read") {
    if (exitCode !== 0) throw new Error(`Native postprocessing reader failed: ${stderr || stdout}`)
  } else {
    if (!requestedKill) throw new Error(`Native postprocessing seed exited before readiness: ${stderr || stdout}`)
    expect(child.killed).toBe(true)
    expect(exitCode).not.toBe(0)
  }
  return JSON.parse(readFileSync(markerPath, "utf8")) as Record
}

for (const carrierKind of ["external", "legacy", "native-task"] as const) {
  for (const phase of ["started", "completed", "historical"] as const) {
    if (carrierKind === "external" && phase === "historical") continue
    for (const size of carrierKind === "external"
      ? (["small", "original", "display", "both"] as const)
      : (["both"] as const)) {
      test(`${carrierKind} Core tool retains raw success across SIGKILL at postprocessing ${phase} (${size})`, async () => {
        await using temporary = await tmpdir()
        const seed = await runWorker(temporary.path, phase, size, carrierKind)
        expect([seed.executions, seed.hooks]).toEqual([1, phase === "historical" ? 0 : 1])
        if (phase === "historical") expect(seed.state).toBeUndefined()
        else expect(seed.state).toBe(phase)
        expect(seed.original).toMatchObject({
          structured: {
            title: "original title",
            output: size === "original" || size === "both" ? "原".repeat(400_000) : "original result",
            metadata: { original: true },
          },
        })
        expect(seed.originalEncoding).toBe(size === "original" || size === "both" ? "artifact" : "json")
        const cold = await runWorker(temporary.path, "read", size, carrierKind)
        expect([cold.executions, cold.hooks]).toEqual([0, 0])
        expect(cold.actionID).toBe(seed.actionID)
        expect(cold.sequence).toBe(seed.sequence)
        expect(cold.state).toBe(seed.state)
        expect(cold.original).toEqual(seed.original)
        expect(cold.catalogSequence).toBe(seed.catalogSequence)
        if (phase === "historical") {
          expect(cold.projected).toBeUndefined()
          expect(cold.result).toEqual(seed.result)
          expect(cold.result?.output?.structured).toMatchObject({
            title: "original title",
            output: "原".repeat(400_000),
          })
        } else if (phase === "started") {
          expect(cold.result?.result).toMatchObject({
            type: "error",
            value: expect.stringContaining("has no confirmed result"),
          })
          expect(cold.projected).toBeUndefined()
        } else {
          expect(cold.projected).toEqual(seed.projected)
          expect(cold.projectedEncoding).toBe(size === "display" || size === "both" ? "artifact" : "json")
          expect(cold.result).toEqual(seed.result)
          if (size === "display" || size === "both")
            expect(Buffer.byteLength(cold.result?.result.value ?? "")).toBeLessThanOrEqual(512)
          expect(cold.result?.output?.structured).toMatchObject({
            title: "display title",
            output: size === "display" || size === "both" ? "展".repeat(400_000) : "display result",
            metadata: { transformed: true },
          })
        }
      }, 60_000)
    }
  }
}
