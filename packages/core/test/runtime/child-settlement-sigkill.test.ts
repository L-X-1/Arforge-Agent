import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { childRunID, parentRunID } from "../fixture/child-settlement-crash-contract"
import { tmpdir } from "../fixture/tmpdir"

const recoverInFreshProcess = async (
  databasePath: string,
  readyMarker: string,
  barrier?: { release: string; ready: () => void },
) => {
  const worker = Bun.spawn(
    [
      process.execPath,
      "test/fixture/child-settlement-crash-worker.ts",
      databasePath,
      readyMarker,
      "recover",
      ...(barrier ? [barrier.release] : []),
    ],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1", ARFORGE_DISABLE_CHANNEL_DB: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = new Response(worker.stdout).text()
  const stderr = new Response(worker.stderr).text()
  const deadline = setTimeout(() => worker.kill(), 15_000)
  try {
    if (barrier) {
      while (!existsSync(readyMarker)) {
        if (worker.exitCode !== null) throw new Error(`Recovery worker exited before barrier: ${await stderr}`)
        await Bun.sleep(10)
      }
      barrier.ready()
    }
    const code = await worker.exited
    const output = await stdout
    const error = await stderr
    if (code !== 0) throw new Error(`Recovery worker failed (${code}): ${error}`)
    const marker = output.split(/\r?\n/).find((line) => line.startsWith("CHILD_RECOVERY_RESULT="))
    if (!marker) throw new Error("Recovery worker returned no result marker")
    return JSON.parse(marker.slice("CHILD_RECOVERY_RESULT=".length))
  } finally {
    clearTimeout(deadline)
    worker.kill()
    await worker.exited
    await Promise.all([stdout, stderr])
  }
}

describe("real SQLite child settlement crash/recovery", () => {
  for (const concurrent of [false, true])
    test(`reconciles a persisted parent intent after SIGKILL (concurrent=${concurrent})`, async () => {
      const temporary = await tmpdir()
      const root = temporary.path
      const databasePath = join(root, "settlement.sqlite")
      const readyMarker = join(root, "ready.json")
      const worker = Bun.spawn(
        [process.execPath, "test/fixture/child-settlement-crash-worker.ts", databasePath, readyMarker],
        {
          cwd: join(import.meta.dir, "..", ".."),
          env: {
            ...process.env,
            ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
            ARFORGE_DISABLE_CHANNEL_DB: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const workerStdout = new Response(worker.stdout).text()
      const workerStderr = new Response(worker.stderr).text()

      try {
        for (let attempt = 0; attempt < 800 && !existsSync(readyMarker); attempt += 1) {
          if (worker.exitCode !== null) throw new Error(`Crash worker exited before readiness: ${await workerStderr}`)
          await Bun.sleep(25)
        }
        expect(existsSync(readyMarker)).toBe(true)
        const marker = JSON.parse(readFileSync(readyMarker, "utf8")) as {
          readonly parentRunID: string
          readonly childRunID: string
        }
        expect(marker.parentRunID).toBe(parentRunID)
        expect(marker.childRunID).toBe(childRunID)

        worker.kill("SIGKILL")
        expect(await worker.exited).not.toBe(0)

        let arrivals = 0
        const release = join(root, "release")
        const barrier = {
          release,
          ready: () => {
            if (++arrivals === 2) writeFileSync(release, "go", "utf8")
          },
        }
        const outcomes = await Promise.allSettled(
          concurrent
            ? [
                recoverInFreshProcess(databasePath, join(root, "one-ready"), barrier),
                recoverInFreshProcess(databasePath, join(root, "two-ready"), barrier),
              ]
            : [recoverInFreshProcess(databasePath, readyMarker)],
        )
        const results = outcomes.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason
          return outcome.value
        })
        const recovered = results[0]
        if (concurrent) expect(arrivals).toBe(2)
        for (const result of results) {
          expect(result.before).toEqual({ childResult: { state: "missing" }, parentBudget: { state: "missing" } })
          expect(result.after).toEqual(recovered.after)
          expect(result.childSequence).toBe(result.childSequenceBefore + 1)
          expect(result.parentSequence).toBe(result.parentSequenceBefore + 1)
        }

        expect(recovered.before).toEqual({
          childResult: { state: "missing" },
          parentBudget: { state: "missing" },
        })
        if (!concurrent) expect(recovered.repaired).toBe(1)
        expect(recovered.after.childResult.state).toBe("present")
        expect(recovered.after.parentBudget.state).toBe("present")
        expect(Number.isInteger(recovered.parentSequence)).toBe(true)
        expect(Number.isInteger(recovered.childSequence)).toBe(true)
        const replay = await recoverInFreshProcess(databasePath, readyMarker)
        expect(replay.repaired).toBe(0)
        expect(replay.before).toEqual(recovered.after)
        expect(replay.after).toEqual(recovered.after)
        expect(replay.parentSequence).toBe(recovered.parentSequence)
        expect(replay.childSequence).toBe(recovered.childSequence)
      } finally {
        worker.kill()
        await worker.exited
        await Promise.all([workerStdout, workerStderr])
        await temporary[Symbol.asyncDispose]()
      }
    }, 60_000)
})
