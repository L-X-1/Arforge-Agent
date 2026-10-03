// Test-only process boundary around the unchanged product runtime. The parent
// kills seed after a real admission/checkpoint COMMIT; no cleanup or lease edits simulate a crash.
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { Effect as EffectType } from "effect/Effect"

const [directory, endpoint, mode, phase, requestedSessionID, requestedRunID] = Bun.argv.slice(2)
const scoped = phase?.startsWith("scoped-") ?? false
if (
  !directory ||
  !endpoint ||
  ![
    "seed",
    "initialize",
    "legacy",
    "admitted",
    "inspect",
    "resume",
    "wake",
    "probe",
    "race",
    "cancel-unknown",
    "new-request",
  ].includes(mode) ||
  ![
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
  ].includes(phase) ||
  (!["seed", "initialize", "legacy", "admitted", "cancel-unknown"].includes(mode) &&
    (!requestedSessionID || (!requestedRunID && phase !== "race-new")))
)
  throw new Error("Invalid request recovery fixture arguments")
const profile = join(directory, "profile")
Object.assign(process.env, {
  ARFORGE_HOME: profile,
  ARFORGE_TEST_HOME: profile,
  ARFORGE_TEST_MANAGED_CONFIG_DIR: join(profile, "managed"),
  HOME: profile,
  XDG_CONFIG_HOME: join(profile, "config"),
  XDG_DATA_HOME: join(profile, "data"),
  XDG_STATE_HOME: join(profile, "state"),
  XDG_CACHE_HOME: join(profile, "cache"),
  ARFORGE_DB: join(directory, "recovery.sqlite"),
  ARFORGE_DB_URL: "",
  ARFORGE_DB_ADMIN_URL: "",
  ARFORGE_DB_READ_ONLY: "0",
  ARFORGE_DISABLE_PROJECT_CONFIG: "1",
  ARFORGE_DISABLE_AUTOUPDATE: "1",
  ARFORGE_DISABLE_AUTOCOMPACT: "1",
  ARFORGE_DISABLE_MODELS_FETCH: "1",
  ARFORGE_DISABLE_CLAUDE_CODE: "1",
  ARFORGE_PURE: "1",
  ARFORGE_AUTH_CONTENT: "{}",
  ARFORGE_EXPERIMENTAL_EVENT_SYSTEM: "true",
  // Public test-only key, shared by these isolated processes. Never consult
  // the host keychain or a user's master key when exercising stored credentials.
  ARFORGE_SECRET_MASTER_KEY: "2b".repeat(32),
  NODE_ENV: "production",
  BUN_ENV: "production",
})
const { testProviderConfig } = await import("../lib/test-provider")
const providerConfig = testProviderConfig(endpoint)
process.env.ARFORGE_CONFIG_CONTENT = JSON.stringify({
  ...providerConfig,
  ...(scoped
    ? {
        provider: {
          ...providerConfig.provider,
          test: { ...providerConfig.provider.test, options: { baseURL: endpoint } },
        },
      }
    : {}),
  model: "test/test-model",
  small_model: "test/test-model",
  enabled_providers: ["test"],
  snapshot: false,
  share: "disabled",
})

const { Cause, Clock, DateTime, Effect, Exit, Fiber, Schema } = await import("effect")
const { AppRuntime } = await import("../../src/effect/app-runtime")
type AppServices = import("../../src/effect/app-runtime").AppServices
const { InstanceStore } = await import("../../src/project/instance-store")
const { Session } = await import("../../src/session/session")
const { SessionPrompt } = await import("../../src/session/prompt")
const { SessionExecution } = await import("@arforge-ai/core/session/execution")
const { Database } = await import("@arforge-ai/core/database/database")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const { EventV2 } = await import("@arforge-ai/core/event")
const { SessionEvent } = await import("@arforge-ai/core/session/event")
const { SessionV2 } = await import("@arforge-ai/core/session")
const { SessionHistory } = await import("@arforge-ai/core/session/history")
const { SessionInput } = await import("@arforge-ai/core/session/input")
const { LocationServiceMap } = await import("@arforge-ai/core/location-service-map")
const { Location } = await import("@arforge-ai/core/location")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { Integration } = await import("@arforge-ai/core/integration")
const { Catalog } = await import("@arforge-ai/core/catalog")
const { ProviderV2 } = await import("@arforge-ai/core/provider")
const { ModelV2 } = await import("@arforge-ai/core/model")
const { Billing } = await import("@arforge-ai/schema/billing")
const RuntimeBilling = await import("@arforge-ai/core/runtime/billing")
const { SessionRunUsageTable } = await import("@arforge-ai/core/runtime/sql")
const { eq } = await import("drizzle-orm")
const SessionCheckpoint = await import("@arforge-ai/core/session/checkpoint")

export interface RecoveryReport {
  pid: number
  sessionID: string
  runID: string
  status: string
  attempts: number
  activeAttempt: number | null
  runCount: number
  revision: number
  runStates: Array<{ id: string; status: string; attempts: number }>
  pendingInputCount: number
  pendingInputFingerprint: string
  runFingerprint: string
  historyFingerprint: string
  policyFingerprint: string
  usageFingerprint: string
  usageCount: number
  billingReceiptCount: number
  billingAmountMinor: number
  activeBillingReservations: number
  checkpoint: string
  envelope: string
  eventCount: number
  eventFingerprint: string
  leaseExpiresAt: number | null
  leaseOwner: string | null
  now: number
  before?: {
    status: string
    attempts: number
    checkpoint: string
    eventFingerprint: string
    leaseOwner: string | null
    activeAttempt: number | null
    leaseExpiresAt: number | null
    now: number
  }
  success?: boolean
  error?: string
  answerPresent?: boolean
}

const emit = (report: RecoveryReport, prefix = "@@request-recovery") =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(`${prefix} ${JSON.stringify(report)}\n`, (error) => (error ? reject(error) : resolve()))
      }),
  )

try {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const instances = yield* InstanceStore.Service
      yield* instances.provide(
        { directory },
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const execution = yield* SessionExecution.Service
          const locations = yield* LocationServiceMap.Service
          const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))
          const runs = yield* DurableRun.Service.pipe(Effect.provide(location))
          const scopedOptions = yield* Effect.gen(function* () {
            if (!scoped) return undefined
            const integrations = yield* Integration.Service.pipe(Effect.provide(location))
            const catalog = yield* Catalog.Service.pipe(Effect.provide(location))
            const integrationID = Integration.ID.make("test")
            yield* integrations.transform((editor) => {
              editor.update(integrationID, (draft) => {
                draft.name = "Scoped cold fixture"
              })
              editor.method.update({ integrationID, method: { type: "key", label: "Fixture key" } })
            })
            if (mode === "seed") yield* integrations.connection.key({ integrationID, key: "fixture-scoped-cold-key" })
            // Re-resolve the current permitted connection in this fresh process;
            // do not promote persisted admission metadata into new authority.
            const connection = (yield* integrations.get(integrationID))?.connections.find(
              (item) => item.type === "credential",
            )
            if (!connection || connection.type !== "credential") throw new Error("Current scoped credential missing")
            const price = Billing.PriceCatalog.make({
              revision: "fixture-cold-price-v1",
              currency: "USD",
              minorUnit: 2,
              unit: "1k-tokens",
              effectiveFrom: DateTime.makeUnsafe(0),
              source: "fixture:scoped-cold",
              rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 1 } },
            })
            yield* catalog.transform((editor) =>
              editor.model.update(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"), (draft) => {
                draft.priceCatalog = price
              }),
            )
            const current = yield* catalog.model.get(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
            if (!current?.priceCatalog) throw new Error("Current verified price missing")
            const currentPrice = current.priceCatalog
            return {
              credentialIDs: mode !== "seed" && phase === "scoped-credentials" ? [] : [connection.id],
              billing: {
                budget: {
                  currency: currentPrice.currency,
                  limitMinor: mode !== "seed" && phase === "scoped-budget" ? 2_000_000 : 1_000_000,
                },
                resolveCatalog: ({ providerID, modelID }: { providerID: string; modelID: string }) =>
                  providerID === "test" && modelID === "test-model" ? currentPrice : undefined,
              },
            }
          })
          const sessionID = ["seed", "initialize", "legacy", "admitted", "cancel-unknown"].includes(mode)
            ? SessionV2.ID.make((yield* sessions.create({ title: "Pinned cold request recovery" })).id)
            : SessionV2.ID.make(requestedSessionID)
          const snapshot = (runID?: typeof AgentRuntime.RunID.Type) =>
            Effect.gen(function* () {
              const all = yield* runs.list({ sessionID, limit: Number.MAX_SAFE_INTEGER })
              const current = runID ? yield* runs.load(runID) : all[0]
              const pending = [
                ...(yield* SessionInput.listPending(db, sessionID, "queue")),
                ...(yield* SessionInput.listPending(db, sessionID, "steer")),
              ]
              const usage = yield* db
                .select()
                .from(SessionRunUsageTable)
                .where(eq(SessionRunUsageTable.session_id, sessionID))
                .orderBy(SessionRunUsageTable.id)
                .all()
                .pipe(Effect.orDie)
              const receipts = usage
                .filter((row) => row.billing_receipt !== null)
                .map((row) => RuntimeBilling.decodeReceipt(row.billing_receipt))
              const rows = yield* EventV2.readSerialized(db, {
                aggregateIDs: [sessionID],
                types: [EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)],
              })
              const envelope = rows[0]?.data.envelope
              if (
                typeof envelope !== "string" &&
                !((phase === "race-new" || phase.startsWith("admission-")) && rows.length === 0)
              )
                throw new Error("Original request envelope is missing or invalid")
              return {
                pid: process.pid,
                sessionID,
                runID: current?.run.id ?? "",
                status: current?.run.status ?? "unstarted",
                attempts: current?.run.budget.attemptsUsed ?? 0,
                activeAttempt: current?.activeAttempt?.attempt ?? null,
                runCount: all.length,
                revision: current?.lastSequence ?? -1,
                usageFingerprint: createHash("sha256").update(JSON.stringify(usage)).digest("hex"),
                usageCount: usage.length,
                billingReceiptCount: receipts.length,
                billingAmountMinor: receipts.reduce((sum, receipt) => sum + receipt.charge.amountMinor, 0),
                activeBillingReservations: receipts.reduce(
                  (sum, receipt) => sum + receipt.settlement.state.activeReservationIDs.length,
                  0,
                ),
                runStates: all.map((item) => ({
                  id: item.run.id,
                  status: item.run.status,
                  attempts: item.run.budget.attemptsUsed,
                })),
                pendingInputCount: pending.length,
                pendingInputFingerprint: createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
                runFingerprint: createHash("sha256")
                  .update(JSON.stringify(current ?? null))
                  .digest("hex"),
                policyFingerprint: createHash("sha256")
                  .update(
                    JSON.stringify(
                      current
                        ? {
                            authority: current.run.authority,
                            riskTier: current.run.riskTier,
                            admission: "sessionID" in current.run ? current.run.admission : undefined,
                            project: "sessionID" in current.run ? current.run.project : undefined,
                            location: "sessionID" in current.run ? current.run.location : undefined,
                            capabilities: "sessionID" in current.run ? current.run.delegableCapabilities : undefined,
                            maxAttempts: current.run.budget.maxAttempts,
                            maxDurationMs: current.run.budget.maxDurationMs,
                            maxTokens: current.run.budget.maxTokens,
                            maxCostMicros: current.run.budget.maxCostMicros,
                          }
                        : null,
                    ),
                  )
                  .digest("hex"),
                historyFingerprint: createHash("sha256")
                  .update(JSON.stringify(yield* SessionHistory.load(db, sessionID)))
                  .digest("hex"),
                checkpoint: JSON.stringify(current?.checkpoint ?? null),
                envelope: typeof envelope === "string" ? envelope : "",
                eventCount: rows.length,
                eventFingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
                leaseExpiresAt: current?.lease ? DateTime.toEpochMillis(current.lease.expiresAt) : null,
                leaseOwner: current?.lease?.ownerID ?? null,
                now: yield* Clock.currentTimeMillis,
              } satisfies RecoveryReport
            })
          if (mode === "cancel-unknown") {
            const running = yield* prompt
              .prompt({
                sessionID,
                agent: "build",
                parts: [{ type: "text", text: "Recover this exact request after a process crash" }],
              })
              .pipe(Effect.forkChild)
            // The parent signals only after its real HTTP server has received
            // this request. Cancellation is the original public product call.
            const command = yield* Effect.promise(() => Bun.stdin.text())
            if (command.trim() !== "cancel") throw new Error("Cancellation worker was not released by its parent")
            yield* prompt.cancel(sessionID)
            const stopped = yield* Fiber.await(running)
            if (!Exit.isFailure(stopped) || !Cause.hasInterruptsOnly(stopped.cause))
              throw new Error("Unknown request did not preserve cancellation")
            yield* emit(yield* snapshot())
            return
          }
          if (mode === "initialize" || mode === "legacy" || mode === "admitted") {
            yield* prompt.prompt({
              sessionID,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "Recover this exact request after a process crash" }],
            })
            if (mode === "legacy" || mode === "admitted") {
              const session = yield* sessions.get(sessionID)
              yield* runs.create(
                {
                  sessionID,
                  initiator: "user",
                  authority: "automatic",
                  riskTier: "L0",
                  reasonSummary: "Legacy accepted session work",
                  project: session.projectID,
                  location: AbsolutePath.make(session.directory),
                  traceID: "trace-legacy-pending",
                  visibility: "details",
                  ...(mode === "admitted"
                    ? {
                        admission: {
                          version: 1 as const,
                          owner: "session-runner" as const,
                          credentialIDs: null,
                          billing: null,
                        },
                      }
                    : {}),
                  budget: {
                    maxAttempts: 3,
                    maxDurationMs: 60_000,
                    maxTokens: 100_000,
                    maxCostMicros: 100_000,
                    attemptsUsed: 0,
                    durationMsUsed: 0,
                    tokensUsed: 0,
                    costMicrosUsed: 0,
                  },
                },
                mode === "admitted"
                  ? { exclusiveSession: true, initialLease: { ownerID: "inspection-fixture", ttlMs: 30_000 } }
                  : undefined,
              )
            }
            yield* emit(yield* snapshot())
            return
          }
          if (mode === "seed") {
            const original = db.transaction
            const transact = original.bind(db)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                db.transaction = original
              }),
            )
            db.transaction = (callback, options) =>
              transact(callback, options).pipe(
                Effect.tap((result) =>
                  Effect.gen(function* () {
                    if (!result || typeof result !== "object" || !("event" in result)) return
                    const event = result.event
                    if (
                      phase.startsWith("admission-") &&
                      event &&
                      typeof event === "object" &&
                      "type" in event &&
                      "data" in event
                    ) {
                      const target = phase.slice("admission-".length)
                      if (event.type === AgentRuntime.Event.RunCreated.type) {
                        const data = Schema.decodeUnknownSync(Schema.toType(AgentRuntime.Event.RunCreated.data))(
                          event.data,
                        )
                        if (data.sessionID !== sessionID || data.run.status !== target) return
                        yield* emit(yield* snapshot(data.runID))
                        yield* Effect.never
                        return
                      }
                      if (event.type === AgentRuntime.Event.RunStateChanged.type) {
                        const data = Schema.decodeUnknownSync(Schema.toType(AgentRuntime.Event.RunStateChanged.data))(
                          event.data,
                        )
                        if (data.sessionID !== sessionID || data.to !== target) return
                        yield* emit(yield* snapshot(data.runID))
                        yield* Effect.never
                        return
                      }
                    }
                    if (
                      !event ||
                      typeof event !== "object" ||
                      !("type" in event) ||
                      event.type !== AgentRuntime.Event.RunCheckpointCreated.type ||
                      !("data" in event)
                    )
                      return
                    const data = Schema.decodeUnknownSync(Schema.toType(AgentRuntime.Event.RunCheckpointCreated.data))(
                      event.data,
                    )
                    if (data.sessionID !== sessionID) return
                    const cursor = SessionCheckpoint.fromContainer(data.checkpoint.state, sessionID)
                    if (
                      !cursor ||
                      cursor.legacy ||
                      cursor.kind !== SessionCheckpoint.KIND ||
                      cursor.dispatch?.phase !==
                        (phase === "inflight"
                          ? "dispatching"
                          : scoped || ["lease-held", "race-expired"].includes(phase)
                            ? "prepared"
                            : phase)
                    )
                      return
                    yield* emit(yield* snapshot(data.runID))
                    if (phase === "inflight") return
                    // Heartbeats remain genuine until the parent kills this owned process.
                    yield* Effect.never
                  }).pipe(Effect.orDie),
                ),
              )
            yield* prompt.prompt({
              sessionID,
              agent: "build",
              ...(scoped ? { noReply: true } : {}),
              parts: [{ type: "text", text: "Recover this exact request after a process crash" }],
            })
            if (scopedOptions) yield* execution.resumeWith({ sessionID, options: scopedOptions })
            throw new Error("Seed completed without reaching the committed checkpoint boundary")
          }
          const runID = requestedRunID ? AgentRuntime.RunID.make(requestedRunID) : undefined
          const before = yield* snapshot(runID)
          if (mode === "inspect") {
            yield* emit(before)
            return
          }
          // Observe real lease expiration. Do not rewrite its timestamp, release it,
          // shorten the product TTL, or execute another run while waiting.
          const deadline = (yield* Clock.currentTimeMillis) + 40_000
          while (true) {
            if (mode === "probe") break
            const current = yield* snapshot(runID)
            if (current.leaseExpiresAt === null || current.leaseExpiresAt <= current.now) break
            if (current.now >= deadline) throw new Error("Original execution lease did not expire")
            yield* Effect.sleep(100)
          }
          if (mode === "race") {
            yield* emit(yield* snapshot(runID), "@@request-ready")
            const command = yield* Effect.promise(() => Bun.stdin.text())
            if (command !== "resume\n") throw new Error("Race worker was not released by its parent")
          }
          const resumeEffect = (
            mode === "new-request"
              ? prompt
                  .prompt({
                    sessionID,
                    agent: "build",
                    parts: [{ type: "text", text: "Only answer this new explicit user request" }],
                  })
                  .pipe(Effect.asVoid)
              : mode === "wake"
                ? execution.wakeAndWait(sessionID)
                : scopedOptions && phase !== "scoped-missing"
                  ? execution.resumeWith({ sessionID, options: scopedOptions })
                  : execution.resume(sessionID)
          ) as EffectType<void, unknown, never>
          const resumed = yield* Effect.exit(resumeEffect)
          const after = yield* snapshot(runID)
          const context = JSON.stringify(yield* SessionHistory.load(db, sessionID))
          yield* emit({
            ...after,
            before,
            success: Exit.isSuccess(resumed),
            error: Exit.isFailure(resumed) ? Cause.pretty(resumed.cause) : "",
            answerPresent: context.includes("Cold product request recovered"),
          })
        }).pipe(Effect.scoped) as EffectType<void, unknown, AppServices>,
      )
    }),
  )
} finally {
  await AppRuntime.dispose()
}
