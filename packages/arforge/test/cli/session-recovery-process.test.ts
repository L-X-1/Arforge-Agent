import { expect } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { existsSync } from "node:fs"
import { Clock, Effect, Schema } from "effect"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { raw } from "../lib/llm-server"

// Validate just the worker metadata used by this CLI journey. The worker is
// test-only and independently records these values from the original owners.
const RecoveryReport = Schema.Struct({
  sessionID: Schema.String,
  runID: Schema.String,
  status: Schema.String,
  revision: Schema.Number,
  pendingInputCount: Schema.Number,
  pendingInputFingerprint: Schema.String,
  runFingerprint: Schema.String,
  historyFingerprint: Schema.String,
  policyFingerprint: Schema.String,
  eventCount: Schema.Number,
  runCount: Schema.Number,
  runStates: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String, attempts: Schema.Number })),
  leaseExpiresAt: Schema.NullOr(Schema.Number),
  checkpoint: Schema.String,
  usageFingerprint: Schema.String,
  eventFingerprint: Schema.String,
  now: Schema.Number,
  success: Schema.optional(Schema.Boolean),
  answerPresent: Schema.optional(Schema.Boolean),
})

const recoveryFixture = ({ home, llm }: CliFixture) => {
  const fixture = fileURLToPath(new URL("../fixture/request-recovery-worker.ts", import.meta.url))
  const worker = (
    mode: "legacy" | "admitted" | "inspect" | "resume" | "cancel-unknown" | "new-request",
    original?: typeof RecoveryReport.Type,
  ) =>
    Effect.gen(function* () {
      const child = Bun.spawn(
        [
          Bun.argv[0],
          fixture,
          home,
          llm.url,
          mode,
          "admission-draft",
          ...(original ? [original.sessionID, original.runID] : []),
        ],
        { cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      const timer = setTimeout(() => child.kill("SIGKILL"), 75_000)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearTimeout(timer)
          child.kill()
        }),
      )
      if (mode === "cancel-unknown") {
        yield* llm.wait(1).pipe(Effect.timeout("20 seconds"))
        child.stdin.write("cancel\n")
        child.stdin.end()
      } else child.stdin.end()
      const result = yield* Effect.promise(() =>
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      )
      clearTimeout(timer)
      expect({ exitCode: result[0], stderr: result[2] }).toMatchObject({ exitCode: 0 })
      const line = result[1].split("\n").find((line) => line.startsWith("@@request-recovery "))
      if (!line) throw new Error(`Fixture produced no report: ${result[2]}`)
      return Schema.decodeUnknownSync(Schema.fromJsonString(RecoveryReport))(line.slice("@@request-recovery ".length))
    })
  const profile = join(home, "profile")
  return {
    worker,
    options: {
      timeoutMs: 60_000,
      env: {
        ARFORGE_HOME: profile,
        ARFORGE_TEST_HOME: profile,
        ARFORGE_TEST_MANAGED_CONFIG_DIR: join(profile, "managed"),
        ARFORGE_DB: join(home, "recovery.sqlite"),
        ARFORGE_DB_URL: "",
        ARFORGE_DB_ADMIN_URL: "",
        ARFORGE_DB_READ_ONLY: "0",
        ARFORGE_EXPERIMENTAL_EVENT_SYSTEM: "true",
      },
    },
  }
}

cliIt.live(
  "TS session recovery abandons only an acknowledged unknown request and continues new input in a fresh process",
  (fixture) =>
    Effect.gen(function* () {
      const { arforge, llm } = fixture
      const { worker, options } = recoveryFixture(fixture)
      yield* llm.push(raw({ hang: true }))
      const original = yield* worker("cancel-unknown")
      expect(original.status).toBe("paused")
      expect(original.leaseExpiresAt).toBeNull()
      expect(yield* llm.calls).toBe(1)
      const inspect = yield* arforge.spawn(["session", "recovery", original.sessionID, "--json"], options)
      arforge.expectExit(inspect, 0, "inspect unknown request")
      const item = JSON.parse(inspect.stdout).items[0]
      expect(item.request).toMatchObject({ outcome: "unknown", abandonmentBlocker: null })
      const command = [
        "session",
        "abandon-request",
        original.sessionID,
        original.runID,
        "--revision",
        String(item.revision),
        "--request-event",
        item.request.eventID,
        "--request-digest",
        item.request.digest,
        "--json",
      ]
      const noConfirmation = yield* arforge.spawn(command, options)
      arforge.expectExit(noConfirmation, 1, "missing unknown outcome confirmation")
      expect(noConfirmation.stderr).toContain("可能已执行或产生费用")
      expect((yield* worker("inspect", original)).runFingerprint).toBe(original.runFingerprint)
      const abandoned = yield* arforge.spawn([...command, "--acknowledge-unknown-outcome"], options)
      arforge.expectExit(abandoned, 0, "abandon original unknown request")
      expect(JSON.parse(abandoned.stdout)).toMatchObject({
        status: "cancelled",
        outcome: "unknown",
        requestReplayed: false,
        budgetPreserved: true,
      })
      const after = yield* worker("inspect", original)
      expect(after.checkpoint).toBe(original.checkpoint)
      expect(after.usageFingerprint).toBe(original.usageFingerprint)
      expect(after.eventFingerprint).toBe(original.eventFingerprint)
      expect(after.historyFingerprint).toBe(original.historyFingerprint)
      expect(after.pendingInputFingerprint).toBe(original.pendingInputFingerprint)
      expect(after.policyFingerprint).toBe(original.policyFingerprint)
      expect(after.runCount).toBe(1)
      const repeated = yield* arforge.spawn([...command, "--acknowledge-unknown-outcome"], options)
      arforge.expectExit(repeated, 1, "stale repeated decision")
      const unsafeResume = yield* worker("resume", original)
      expect(unsafeResume.success).toBe(false)
      expect(unsafeResume.runFingerprint).toBe(after.runFingerprint)
      expect(yield* llm.calls).toBe(1)
      yield* llm.text("Cold product request recovered")
      const next = yield* worker("new-request", original)
      expect(next.success).toBe(true)
      expect(next.answerPresent).toBe(true)
      expect(next.runCount).toBe(2)
      expect(next.runFingerprint).toBe(after.runFingerprint)
      expect(yield* llm.calls).toBe(2)
      expect(JSON.stringify(yield* llm.inputs)).toContain("Only answer this new explicit user request")
    }),
  180_000,
)

cliIt.live(
  "TS session recovery inspects and cancels a legacy pending task without losing its accepted input",
  (fixture) =>
    Effect.gen(function* () {
      const { arforge, llm } = fixture
      const { worker, options } = recoveryFixture(fixture)
      const original = yield* worker("legacy")
      expect(original.status).toBe("draft")
      expect(original.pendingInputCount).toBe(1)
      expect(yield* llm.calls).toBe(0)
      const inspect = yield* arforge.spawn(["session", "recovery", original.sessionID, "--json"], options)
      arforge.expectExit(inspect, 0, "session recovery JSON")
      expect(JSON.parse(inspect.stdout)).toMatchObject({
        sessionID: original.sessionID,
        items: [
          {
            runID: original.runID,
            revision: original.revision,
            status: "draft",
            admissionRecorded: false,
            cancellationBlocker: null,
          },
        ],
      })
      const human = yield* arforge.spawn(["session", "recovery", original.sessionID], options)
      arforge.expectExit(human, 0, "session recovery human")
      expect(human.stdout).toContain("历史任务缺少恢复约束")
      expect(human.stdout).toContain(
        `cancel-pending ${original.sessionID} ${original.runID} --revision ${original.revision}`,
      )
      expect(human.stdout).toContain("不会自动取消、重发请求或删除输入")
      const unchanged = yield* worker("inspect", original)
      expect(unchanged.runFingerprint).toBe(original.runFingerprint)
      expect(unchanged.historyFingerprint).toBe(original.historyFingerprint)
      expect(unchanged.pendingInputFingerprint).toBe(original.pendingInputFingerprint)
      expect(unchanged.eventCount).toBe(0)
      const stale = yield* arforge.spawn(
        [
          "session",
          "cancel-pending",
          original.sessionID,
          original.runID,
          "--revision",
          String(original.revision + 1),
          "--json",
        ],
        options,
      )
      arforge.expectExit(stale, 1, "stale cancellation")
      expect(stale.stderr).toContain("任务已发生变化")
      const foreign = yield* worker("legacy")
      const wrongSession = yield* arforge.spawn(
        [
          "session",
          "cancel-pending",
          foreign.sessionID,
          original.runID,
          "--revision",
          String(original.revision),
          "--json",
        ],
        options,
      )
      arforge.expectExit(wrongSession, 1, "cannot cancel another session's task")
      expect(wrongSession.stderr).toContain("运行不属于指定会话")
      const cancel = yield* arforge.spawn(
        [
          "session",
          "cancel-pending",
          original.sessionID,
          original.runID,
          "--revision",
          String(original.revision),
          "--json",
        ],
        options,
      )
      arforge.expectExit(cancel, 0, "cancel original pending task")
      expect(JSON.parse(cancel.stdout)).toMatchObject({
        status: "cancelled",
        runID: original.runID,
        inputPreserved: true,
        historyPreserved: true,
      })
      const cancelled = yield* worker("inspect", original)
      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.runCount).toBe(1)
      expect(cancelled.policyFingerprint).toBe(original.policyFingerprint)
      expect(cancelled.pendingInputFingerprint).toBe(original.pendingInputFingerprint)
      expect(cancelled.historyFingerprint).toBe(original.historyFingerprint)
      expect(cancelled.eventCount).toBe(0)
      const replay = yield* arforge.spawn(
        [
          "session",
          "cancel-pending",
          original.sessionID,
          original.runID,
          "--revision",
          String(original.revision),
          "--json",
        ],
        options,
      )
      arforge.expectExit(replay, 1, "repeated cancellation must not append another event")
      expect(replay.stderr).toContain("任务已发生变化")
      const repeated = yield* worker("inspect", original)
      expect(repeated.runFingerprint).toBe(cancelled.runFingerprint)
      expect(repeated.pendingInputFingerprint).toBe(original.pendingInputFingerprint)
      const other = yield* worker("inspect", foreign)
      expect(other.runFingerprint).toBe(foreign.runFingerprint)
      expect(other.pendingInputFingerprint).toBe(foreign.pendingInputFingerprint)
      expect(yield* llm.calls).toBe(0)
      yield* llm.text("Cold product request recovered")
      const resumed = yield* worker("resume", original)
      expect(resumed.success).toBe(true)
      expect(resumed.answerPresent).toBe(true)
      expect(yield* llm.calls).toBe(1)
      expect(JSON.stringify(yield* llm.inputs)).toContain("Recover this exact request after a process crash")
      expect(resumed.runStates).toEqual(
        expect.arrayContaining([
          { id: original.runID, status: "cancelled", attempts: 0 },
          { id: expect.any(String), status: "completed", attempts: 1 },
        ]),
      )
      expect(resumed.runCount).toBe(2)
      expect(resumed.pendingInputCount).toBe(0)
      expect(resumed.eventCount).toBe(1)
      const empty = yield* arforge.spawn(["session", "recovery", original.sessionID, "--json"], options)
      arforge.expectExit(empty, 0, "settled session recovery")
      expect(JSON.parse(empty.stdout).items).toEqual([])
    }),
  180_000,
)

cliIt.live(
  "TS session recovery is read-only even when an admitted task lease has expired",
  (fixture) =>
    Effect.gen(function* () {
      const { arforge, llm, home } = fixture
      const { worker, options } = recoveryFixture(fixture)
      const original = yield* worker("admitted")
      expect(original.status).toBe("draft")
      expect(original.leaseExpiresAt).toBeGreaterThan(original.now)
      if (original.leaseExpiresAt === null) throw new Error("Fixture has no original lease")
      const leased = yield* arforge.spawn(
        [
          "session",
          "cancel-pending",
          original.sessionID,
          original.runID,
          "--revision",
          String(original.revision),
          "--json",
        ],
        options,
      )
      arforge.expectExit(leased, 1, "live lease cannot be cancelled by maintenance")
      expect(leased.stderr).toContain("有效租约")
      // Let the real persisted lease expire, without editing timestamps or the DB.
      yield* Effect.sleep(Math.max(0, original.leaseExpiresAt - (yield* Clock.currentTimeMillis) + 1))
      const facts = () => {
        const db = new SQLite(join(home, "recovery.sqlite"), { readonly: true })
        try {
          return {
            events: db.query("SELECT * FROM event ORDER BY id").all(),
            sequences: db.query("SELECT * FROM event_sequence ORDER BY aggregate_id").all(),
            inputs: db.query("SELECT * FROM session_input ORDER BY id").all(),
            usage: db.query("SELECT * FROM session_run_usage ORDER BY id").all(),
          }
        } finally {
          db.close()
        }
      }
      const before = facts()
      const inspected = yield* arforge.spawn(["session", "recovery", original.sessionID, "--json"], options)
      arforge.expectExit(inspected, 0, "inspect expired admission without waking it")
      expect(facts()).toEqual(before)
      expect(yield* llm.calls).toBe(0)
      expect(JSON.parse(inspected.stdout).items).toEqual([
        {
          runID: original.runID,
          sessionID: original.sessionID,
          status: "draft",
          revision: original.revision,
          admissionRecorded: true,
          leaseExpiresAt: original.leaseExpiresAt,
          cancellationBlocker: null,
        },
      ])
    }),
  150_000,
)

cliIt.live(
  "TS session recovery does not create a database for a missing profile",
  (fixture) =>
    Effect.gen(function* () {
      const { options } = recoveryFixture(fixture)
      for (const prefix of [[], ["--log-level", "ERROR"]]) {
        const result = yield* fixture.arforge.spawn(
          [...prefix, "session", "recovery", "ses_missing", "--json"],
          options,
        )
        fixture.arforge.expectExit(result, 1, "missing recovery profile")
        expect(result.stdout).toBe("")
        expect(existsSync(options.env.ARFORGE_DB)).toBe(false)
      }
      expect(yield* fixture.llm.calls).toBe(0)
    }),
  90_000,
)

cliIt.live(
  "TS session recovery does not migrate an incompatible existing database",
  (fixture) =>
    Effect.gen(function* () {
      const { options } = recoveryFixture(fixture)
      const seeded = new SQLite(options.env.ARFORGE_DB)
      try {
        seeded.exec("CREATE TABLE original_history (note TEXT); INSERT INTO original_history VALUES ('retained')")
      } finally {
        seeded.close()
      }
      const before = yield* Effect.promise(() => Bun.file(options.env.ARFORGE_DB).arrayBuffer())
      const result = yield* fixture.arforge.spawn(["session", "recovery", "ses_missing", "--json"], options)
      fixture.arforge.expectExit(result, 1, "incompatible recovery database")
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("无法安全读取或处理该任务")
      expect(yield* Effect.promise(() => Bun.file(options.env.ARFORGE_DB).arrayBuffer())).toEqual(before)
      expect(yield* fixture.llm.calls).toBe(0)
    }),
  90_000,
)

for (const revision of [undefined, "-1", "0.5", "NaN", "9007199254740992"] as const) {
  cliIt.live(
    `TS pending cancellation rejects invalid revision ${revision ?? "missing"} before opening a database`,
    (fixture) =>
      Effect.gen(function* () {
        const { options } = recoveryFixture(fixture)
        const result = yield* fixture.arforge.spawn(
          [
            "session",
            "cancel-pending",
            "ses_missing",
            "run_missing",
            ...(revision === undefined ? [] : ["--revision", revision]),
            "--json",
          ],
          options,
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("revision")
        expect(existsSync(options.env.ARFORGE_DB)).toBe(false)
        expect(yield* fixture.llm.calls).toBe(0)
      }),
    90_000,
  )
}

cliIt.live(
  "TS recovery explains missing session IDs and cancellation help without opening a database",
  (fixture) =>
    Effect.gen(function* () {
      const { options } = recoveryFixture(fixture)
      const missing = yield* fixture.arforge.spawn(["session", "recovery", "--json"], options)
      fixture.arforge.expectExit(missing, 2, "missing recovery session")
      expect(missing.stdout).toBe("")
      expect(missing.stderr).toContain("session recovery <sessionID>")
      const help = yield* fixture.arforge.spawn(["session", "cancel-pending", "--help"], options)
      fixture.arforge.expectExit(help, 0, "pending cancellation help")
      expect(help.stdout + help.stderr).toContain("revision")
      expect(existsSync(options.env.ARFORGE_DB)).toBe(false)
      expect(yield* fixture.llm.calls).toBe(0)
    }),
  90_000,
)
