import { expect } from "bun:test"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../fixture/fixture"
import type { RecoveryReport } from "../fixture/request-recovery-worker"
import { it } from "../lib/effect"

for (const phase of [
  "prepared",
  "dispatching",
  "inflight",
  "lease-held",
  "race-new",
  "race-expired",
  "admission-draft",
  "admission-preflight",
  "admission-queued",
  "admission-running",
  "scoped-prepared",
  "scoped-missing",
  "scoped-budget",
  "scoped-credentials",
] as const) {
  it.live(
    phase === "lease-held"
      ? "product AppRuntime rejects another process while its lease is held: lease-held"
      : `product AppRuntime recovers after hard process termination: ${phase}`,
    () =>
      Effect.promise(async () => {
        await using directory = await tmpdir()
        const hits: { url: string; body: unknown; authorized: boolean }[] = []
        let received: () => void
        const requestReceived = new Promise<void>((resolve) => {
          received = resolve
        })
        let releaseResponse: () => void
        const responseReleased = new Promise<void>((resolve) => {
          releaseResponse = resolve
        })
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            // A local port probe is not a model call. Reject unsupported
            // methods before reading a JSON body; the Provider must still use
            // the exact POST endpoint and a valid request to complete the test.
            if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
            if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
            hits.push({
              url: request.url,
              body: await request.json(),
              authorized:
                request.headers.get("authorization") ===
                (phase.startsWith("scoped-") ? "Bearer fixture-scoped-cold-key" : "Bearer test-key"),
            })
            received!()
            if (["inflight", "race-new", "race-expired"].includes(phase)) await responseReleased
            const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
              `data: ${JSON.stringify({ id: "cold-product", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
            return new Response(
              chunk({ role: "assistant", content: "Cold product request recovered" }, null) +
                chunk({}, "stop") +
                "data: [DONE]\n\n",
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          },
        })
        const workerPath = fileURLToPath(new URL("../fixture/request-recovery-worker.ts", import.meta.url))
        const workers: {
          worker: Bun.Subprocess<"pipe", "pipe", "pipe">
          report: Promise<RecoveryReport>
          ready: Promise<RecoveryReport>
          result: Promise<{ exitCode: number; stdout: string; stderr: string }>
        }[] = []
        function start(mode: "seed" | "initialize" | "resume" | "wake" | "probe" | "race", original?: RecoveryReport) {
          const worker = Bun.spawn(
            [
              process.execPath,
              workerPath,
              directory.path,
              `${server.url.href}v1`,
              mode,
              phase,
              ...(original ? [original.sessionID, original.runID] : []),
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: directory.path },
          )
          const timer = setTimeout(() => worker.kill("SIGKILL"), 75_000)
          let resolveReport: (value: RecoveryReport) => void
          let rejectReport: (reason: unknown) => void
          const report = new Promise<RecoveryReport>((resolve, reject) => {
            resolveReport = resolve
            rejectReport = reject
          })
          let resolveReady: ((value: RecoveryReport) => void) | undefined
          let rejectReady: ((reason: unknown) => void) | undefined
          const ready =
            mode === "race"
              ? new Promise<RecoveryReport>((resolve, reject) => {
                  resolveReady = resolve
                  rejectReady = reject
                })
              : report
          void report.catch(() => undefined)
          const stderr = new Response(worker.stderr).text()
          const stdout = (async () => {
            let output = ""
            let pending = ""
            const decoder = new TextDecoder()
            const reader = worker.stdout.getReader()
            while (true) {
              const { value: bytes, done } = await reader.read()
              if (done) break
              const chunk = decoder.decode(bytes, { stream: true })
              output += chunk
              pending += chunk
              let index: number
              while ((index = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, index)
                pending = pending.slice(index + 1)
                if (line.startsWith("@@request-recovery "))
                  resolveReport!(JSON.parse(line.slice("@@request-recovery ".length)))
                if (line.startsWith("@@request-ready "))
                  resolveReady?.(JSON.parse(line.slice("@@request-ready ".length)))
              }
            }
            return output
          })()
          const result = Promise.all([worker.exited, stdout, stderr]).then(
            ([exitCode, stdout, stderr]) => {
              clearTimeout(timer)
              const error = new Error(`Worker exited before reporting (${exitCode}): ${stderr}\n${stdout}`)
              rejectReport!(error)
              rejectReady?.(error)
              return { exitCode, stdout, stderr }
            },
            (error) => {
              clearTimeout(timer)
              rejectReport!(error)
              rejectReady?.(error)
              throw error
            },
          )
          const handle = { worker, report, ready, result }
          workers.push(handle)
          return handle
        }
        try {
          if (phase === "lease-held") {
            const probe = await fetch(server.url)
            expect(probe.status).toBe(405)
            await probe.arrayBuffer()
            expect(hits).toHaveLength(0)
          }
          const seed = start(phase === "race-new" ? "initialize" : "seed")
          const original = await seed.report
          if (phase.startsWith("admission-")) {
            expect(original.status).toBe(phase.slice("admission-".length))
            expect(original.runCount).toBe(1)
            expect(original.eventCount).toBe(0)
            expect(original.attempts).toBe(0)
            expect(original.leaseOwner).not.toBeNull()
            expect(original.leaseExpiresAt).toBeGreaterThan(original.now)
            expect(hits).toHaveLength(0)
            if (phase === "admission-draft") {
              const probe = start("probe", original)
              const rejected = await probe.report
              expect((await probe.result).exitCode).toBe(0)
              expect(rejected.success).toBe(false)
              expect(rejected.error).toContain("Session already has an unfinished run")
              expect(rejected.runFingerprint).toBe(original.runFingerprint)
              expect(rejected.leaseExpiresAt).toBeGreaterThan(rejected.now)
              expect(hits).toHaveLength(0)
            }
            seed.worker.kill("SIGKILL")
            expect((await seed.result).exitCode).not.toBe(0)
            const resume = start("resume", original)
            const resumed = await resume.report
            expect((await resume.result).exitCode).toBe(0)
            expect({ success: resumed.success, error: resumed.error }).toEqual({ success: true, error: "" })
            expect(resumed.runID).toBe(original.runID)
            expect(resumed.runCount).toBe(1)
            expect(resumed.policyFingerprint).toBe(original.policyFingerprint)
            expect(resumed.status).toBe("completed")
            expect(resumed.attempts).toBe(1)
            expect(resumed.eventCount).toBe(1)
            expect(resumed.activeAttempt).toBeNull()
            expect(resumed.leaseOwner).toBeNull()
            expect(resumed.answerPresent).toBe(true)
            expect(hits).toHaveLength(1)
            return
          }
          if (phase === "race-new" || phase === "race-expired") {
            if (phase === "race-new") {
              expect((await seed.result).exitCode).toBe(0)
              expect(original.status).toBe("unstarted")
              expect(original.runCount).toBe(0)
              expect(original.eventCount).toBe(0)
            } else {
              expect(original.status).toBe("running")
              expect(original.activeAttempt).toBe(1)
              seed.worker.kill("SIGKILL")
              expect((await seed.result).exitCode).not.toBe(0)
            }
            const contenders = [start("race", original), start("race", original)]
            const readiness = await Promise.all(contenders.map((handle) => handle.ready))
            expect(new Set(readiness.map((report) => report.pid)).size).toBe(2)
            for (const ready of readiness) {
              expect(ready.pid).not.toBe(original.pid)
              expect(ready.historyFingerprint).toBe(original.historyFingerprint)
              expect(ready.runFingerprint).toBe(original.runFingerprint)
              expect(ready.eventFingerprint).toBe(original.eventFingerprint)
              if (phase === "race-expired") expect(ready.leaseExpiresAt).toBeLessThanOrEqual(ready.now)
            }
            expect(hits).toHaveLength(0)
            await Promise.all(
              contenders.map(async (handle) => {
                await handle.worker.stdin.write("resume\n")
                await handle.worker.stdin.end()
              }),
            )
            // The successful contender is held inside the real HTTP request.
            // Only the rejected contender can finish before this response gate.
            const rejected = await Promise.race(contenders.map((handle) => handle.report))
            expect(rejected.success).toBe(false)
            expect(rejected.runCount).toBe(1)
            expect(rejected.error).toMatch(
              /Session already has an unfinished run|Another execution currently owns this run/,
            )
            let timer: ReturnType<typeof setTimeout>
            try {
              await Promise.race([
                requestReceived,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("Winning contender never reached the HTTP server")), 15_000)
                }),
              ])
            } finally {
              clearTimeout(timer!)
            }
            expect(hits).toHaveLength(1)
            releaseResponse!()
            const results = await Promise.all(contenders.map((handle) => handle.report))
            for (const handle of contenders) expect((await handle.result).exitCode).toBe(0)
            const winners = results.filter((report) => report.success)
            expect(winners).toHaveLength(1)
            const winner = winners[0]
            expect(winner.status).toBe("completed")
            expect(winner.runCount).toBe(1)
            expect(winner.attempts).toBe(phase === "race-new" ? 1 : 2)
            expect(winner.activeAttempt).toBeNull()
            expect(winner.leaseOwner).toBeNull()
            expect(winner.eventCount).toBe(1)
            expect(winner.answerPresent).toBe(true)
            if (phase === "race-expired") {
              expect(winner.runID).toBe(original.runID)
              expect(winner.envelope).toBe(original.envelope)
              expect(winner.eventFingerprint).toBe(original.eventFingerprint)
            }
            const envelope = JSON.parse(winner.envelope)
            expect(hits[0]).toEqual({
              url: envelope.request.transmission.endpoint.url,
              body: envelope.request.transmission.body,
              authorized: true,
            })
            return
          }
          expect(original.pid).not.toBe(process.pid)
          expect(original.status).toBe("running")
          expect(original.attempts).toBe(1)
          expect(original.activeAttempt).toBe(1)
          expect(original.runCount).toBe(1)
          expect(original.eventCount).toBe(1)
          expect(original.leaseExpiresAt).toBeGreaterThan(original.now)
          expect(original.leaseOwner).not.toBeNull()
          if (phase === "inflight") {
            let timeout: ReturnType<typeof setTimeout>
            try {
              await Promise.race([
                requestReceived,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("Original request never reached the HTTP server")),
                    15_000,
                  )
                }),
              ])
            } finally {
              clearTimeout(timeout!)
            }
          }
          expect(hits).toHaveLength(phase === "inflight" ? 1 : 0)
          if (phase === "lease-held") {
            const contender = start("probe", original)
            const rejected = await contender.report
            expect((await contender.result).exitCode).toBe(0)
            expect(rejected.before?.leaseOwner).toBe(original.leaseOwner)
            expect(rejected.before?.activeAttempt).toBe(1)
            expect(rejected.before?.leaseExpiresAt).toBeGreaterThan(rejected.before?.now ?? Infinity)
            expect(rejected.error).toContain("Session already has an unfinished run")
            expect({ success: rejected.success, runs: rejected.runCount, http: hits.length }).toEqual({
              success: false,
              runs: 1,
              http: 0,
            })
            expect(rejected.runCount).toBe(1)
            expect(rejected.status).toBe("running")
            expect(rejected.activeAttempt).toBe(1)
            expect(rejected.attempts).toBe(1)
            expect(rejected.eventFingerprint).toBe(original.eventFingerprint)
            expect(rejected.checkpoint).toBe(original.checkpoint)
            expect(hits).toHaveLength(0)
            return
          }
          seed.worker.kill("SIGKILL")
          expect((await seed.result).exitCode).not.toBe(0)
          const resume = start("resume", original)
          const restored = await resume.report
          const result = await resume.result
          if (phase.startsWith("scoped-")) {
            expect(result.exitCode).toBe(0)
            expect(restored.pid).not.toBe(original.pid)
            expect(restored.runID).toBe(original.runID)
            expect(restored.runCount).toBe(1)
            expect(restored.policyFingerprint).toBe(original.policyFingerprint)
            expect(restored.eventFingerprint).toBe(original.eventFingerprint)
            expect(restored.envelope).toBe(original.envelope)
            expect(original.envelope).toContain("credential_identity")
            expect(original.envelope).not.toContain("fixture-scoped-cold-key")
            if (phase !== "scoped-prepared") {
              expect(restored.success).toBe(false)
              expect(restored.error).toContain(
                phase === "scoped-credentials" ? "credential or estimator constraints" : "billing",
              )
              expect(restored.runFingerprint).toBe(original.runFingerprint)
              expect(restored.historyFingerprint).toBe(original.historyFingerprint)
              expect(restored.pendingInputFingerprint).toBe(original.pendingInputFingerprint)
              expect(restored.usageFingerprint).toBe(original.usageFingerprint)
              expect(hits).toHaveLength(0)
            } else {
              expect({ success: restored.success, error: restored.error }).toEqual({ success: true, error: "" })
              expect(restored.status).toBe("completed")
              expect(restored.attempts).toBe(2)
              expect(restored.activeAttempt).toBeNull()
              expect(restored.leaseOwner).toBeNull()
              expect(restored.answerPresent).toBe(true)
              expect(restored.billingReceiptCount).toBe(1)
              expect(restored.billingAmountMinor).toBeGreaterThan(0)
              expect(restored.activeBillingReservations).toBe(0)
              const envelope = JSON.parse(original.envelope)
              expect(hits).toEqual([
                {
                  url: envelope.request.transmission.endpoint.url,
                  body: envelope.request.transmission.body,
                  authorized: true,
                },
              ])
              const idle = start("wake", restored)
              const after = await idle.report
              expect((await idle.result).exitCode).toBe(0)
              expect(after.success).toBe(true)
              expect(after.runFingerprint).toBe(restored.runFingerprint)
              expect(after.usageFingerprint).toBe(restored.usageFingerprint)
              expect(hits).toHaveLength(1)
            }
            expect(result.stdout + result.stderr).not.toContain("fixture-scoped-cold-key")
            return
          }
          expect({ code: result.exitCode, error: restored.error }).toEqual({
            code: 0,
            error: phase === "prepared" ? "" : expect.stringContaining("may already have been sent"),
          })
          expect(restored.pid).not.toBe(original.pid)
          expect(restored.pid).not.toBe(process.pid)
          expect(restored.runID).toBe(original.runID)
          expect(restored.sessionID).toBe(original.sessionID)
          expect(restored.before).toMatchObject({
            status: "running",
            attempts: 1,
            checkpoint: original.checkpoint,
            eventFingerprint: original.eventFingerprint,
            leaseOwner: original.leaseOwner,
            activeAttempt: 1,
          })
          expect(restored.attempts).toBe(2)
          expect(restored.activeAttempt).toBeNull()
          expect(restored.leaseOwner).toBeNull()
          expect(restored.runCount).toBe(1)
          expect(restored.eventCount).toBe(1)
          expect(restored.eventFingerprint).toBe(original.eventFingerprint)
          expect(restored.envelope).toBe(original.envelope)
          expect(restored.success).toBe(phase === "prepared")
          expect(restored.status).toBe(phase === "prepared" ? "completed" : "paused")
          expect(restored.answerPresent).toBe(phase === "prepared")
          expect(hits).toHaveLength(phase === "dispatching" ? 0 : 1)
          if (phase === "prepared") {
            const envelope = JSON.parse(original.envelope)
            expect(hits[0]).toEqual({
              url: envelope.request.transmission.endpoint.url,
              body: envelope.request.transmission.body,
              authorized: true,
            })
            const idle = start("wake", restored)
            const observed = await idle.report
            expect((await idle.result).exitCode).toBe(0)
            expect(observed.pid).not.toBe(restored.pid)
            expect(observed.success).toBe(true)
            expect(observed.status).toBe("completed")
            expect(observed.runCount).toBe(1)
            expect(observed.attempts).toBe(2)
            expect(observed.runFingerprint).toBe(restored.runFingerprint)
            expect(observed.eventFingerprint).toBe(restored.eventFingerprint)
            expect(observed.answerPresent).toBe(true)
            expect(hits).toHaveLength(1)
          } else expect(restored.checkpoint).toBe(original.checkpoint)
          expect(result.stdout).not.toContain("test-key")
          expect(result.stderr).not.toContain("test-key")
        } finally {
          for (const handle of workers) handle.worker.kill("SIGKILL")
          await Promise.allSettled(workers.map((handle) => handle.result))
          releaseResponse!()
          await server.stop(true)
        }
      }),
    160_000,
  )
}
