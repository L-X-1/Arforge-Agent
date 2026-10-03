// A fresh Runner over a test-only SQLite snapshot; no prior process state is available.
const [databasePath, workspace, projectID, sessionID, recoveryArgument] = Bun.argv.slice(2)
const summaryRecovery = recoveryArgument?.startsWith("summary-") === true
const recovery = summaryRecovery ? recoveryArgument?.replace("summary-", "pending-") : recoveryArgument
if (
  !databasePath ||
  !workspace ||
  !projectID ||
  !sessionID ||
  ![
    "available",
    "exhausted",
    "missing-policy",
    "changed-policy",
    "pending-available",
    "pending-missing",
    "pending-estimated",
    "pending-rejected",
    "pending-idle",
  ].includes(recovery ?? "")
)
  throw new Error("Invalid billing recovery fixture arguments")
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = databasePath.slice(
  0,
  Math.max(databasePath.lastIndexOf("/"), databasePath.lastIndexOf("\\")),
)

const { Effect, Layer, Stream, DateTime, Exit, Cause } = await import("effect")
const { LLMClient, Model, LLMEvent } = await import("@arforge-ai/llm")
const OpenAIChat = await import("@arforge-ai/llm/protocols/openai-chat")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { llmClient } = await import("@arforge-ai/core/effect/app-node-platform")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { Location } = await import("@arforge-ai/core/location")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { ProjectID } = await import("@arforge-ai/schema/project-id")
const { AgentV2 } = await import("@arforge-ai/core/agent")
const { Config } = await import("@arforge-ai/core/config")
const { Snapshot } = await import("@arforge-ai/core/snapshot")
const runner = await import("@arforge-ai/core/session/runner/llm")
const { SessionRunner } = await import("@arforge-ai/core/session/runner")
const { SessionRunnerModel } = await import("@arforge-ai/core/session/runner/model")
const { SessionProjector } = await import("@arforge-ai/core/session/projector")
const { SessionSchema } = await import("@arforge-ai/core/session/schema")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const { Database } = await import("@arforge-ai/core/database/database")
const { SessionRunUsageTable } = await import("@arforge-ai/core/runtime/sql")
const { decodeReceipt, decodeReservationReceipt, fromStepTokens, estimateCallUsage } = await import(
  "@arforge-ai/core/runtime/billing"
)
const { Billing } = await import("@arforge-ai/schema/billing")
const { eq } = await import("drizzle-orm")
let providerCalls = 0
let reconciliationCalls = 0
let lookupBindingValid = true
const pendingRecovery = recovery.startsWith("pending-")
const outcomeUnknown = pendingRecovery && !summaryRecovery
const directory = AbsolutePath.make(workspace)
// Summary recovery retains a real compaction-capable model; absence of model
// limits must not be the reason an interrupted summary is not sent again.
const model = Model.make({
  id: summaryRecovery ? "recovery" : "fake-model",
  provider: "fake",
  route: summaryRecovery ? OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }) : OpenAIChat.route,
})
const layer = AppNodeBuilder.build(
  LayerNode.group([runner.node, SessionProjector.node, AgentV2.node, DurableRun.node, Database.node]),
  [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({ directory, project: { id: ProjectID.make(projectID), directory } }),
      ),
    ],
    [Snapshot.node, Snapshot.noopLayer],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
    [
      llmClient,
      Layer.mock(LLMClient.Service, {
        prepare: LLMClient.prepare,
        streamPrepared: () => {
          providerCalls++
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "fresh-answer" }),
            LLMEvent.textDelta({ id: "fresh-answer", text: "Resumed in a new process" }),
            LLMEvent.textEnd({ id: "fresh-answer" }),
            LLMEvent.stepFinish({
              index: 0,
              reason: "stop",
              usage: { inputTokens: 2, nonCachedInputTokens: 2, outputTokens: 1, totalTokens: 3 },
            }),
            LLMEvent.finish({ reason: "stop" }),
          ])
        },
      }),
    ],
  ],
)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const id = SessionSchema.ID.make(sessionID)
    const db = (yield* Database.Service).db
    const runs = yield* DurableRun.Service
    const allBeforeRuns = yield* runs.list({ sessionID: id })
    const allBefore = yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.session_id, id)).all()
    const summaryRun = summaryRecovery ? allBefore.find((row) => row.id.includes("_compaction_"))?.run_id : undefined
    if (summaryRecovery && !summaryRun) throw new Error("Expected durable summary reservation")
    const beforeRuns = summaryRecovery ? allBeforeRuns.filter((item) => item.run.id === summaryRun) : allBeforeRuns
    const before = summaryRecovery ? allBefore.filter((row) => row.run_id === summaryRun) : allBefore
    const originalRow = summaryRecovery ? before.find((row) => row.id.includes("_compaction_"))! : before[0]!
    const originalCount = summaryRecovery ? 2 : 1
    if (
      recovery !== "pending-idle" &&
      (before.length !== originalCount || beforeRuns.length !== 1 || beforeRuns[0]?.run.status !== "paused")
    )
      throw new Error("Expected one paused billed run")
    if (
      recovery === "pending-idle" &&
      (before.length !== originalCount + (outcomeUnknown ? 0 : 1) ||
        beforeRuns.length !== 1 ||
        beforeRuns[0]?.run.status !== (outcomeUnknown ? "paused" : "completed"))
    )
      throw new Error("Expected one completed recovered run")
    const pending =
      pendingRecovery && recovery !== "pending-idle"
        ? decodeReservationReceipt(originalRow.billing_receipt, {
            runID: beforeRuns[0].run.id,
            reservationID: originalRow.id,
            providerID: originalRow.provider_id,
            modelID: originalRow.model_id,
          })
        : undefined
    const catalog = Billing.PriceCatalog.make({
      revision: "resume-prices",
      currency: "USD",
      minorUnit: summaryRecovery ? 2 : 6,
      unit: "token",
      effectiveFrom: DateTime.makeUnsafe(0),
      source: "fixture:resume",
      rates: {
        unknownInput: { amountMinor: pendingRecovery ? 2 : 1 },
        textOutput: { amountMinor: pendingRecovery ? 2 : 1 },
      },
    })
    const execution = yield* SessionRunner.Service
    const exit = yield* execution
      .run({
        sessionID: id,
        force: recovery !== "pending-idle",
        billing:
          recovery === "missing-policy"
            ? undefined
            : {
                budget: { currency: "USD", limitMinor: recovery === "changed-policy" ? 200_000 : 100_000 },
                resolveCatalog: () => catalog,
                reconcileUsage: pendingRecovery
                  ? (input) => {
                      reconciliationCalls++
                      if (
                        !pending ||
                        input.runID !== pending.runID ||
                        input.reservationID !== pending.reservation.id ||
                        input.providerID !== pending.providerID ||
                        input.modelID !== pending.modelID ||
                        input.requestDigest !== pending.requestDigest ||
                        input.failureCategory !== "recovery"
                      ) {
                        lookupBindingValid = false
                        throw new Error("Recovery lookup did not bind the stored request")
                      }
                      if (recovery === "pending-rejected") return Promise.reject(new Error("fixture unavailable"))
                      if (recovery === "pending-missing") return undefined
                      if (recovery === "pending-estimated")
                        return estimateCallUsage({ inputText: "unknown", outputTokens: 4 })
                      return fromStepTokens({ input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
                    }
                  : undefined,
              },
      })
      .pipe(Effect.exit)
    const allAfter = yield* db.select().from(SessionRunUsageTable).where(eq(SessionRunUsageTable.session_id, id)).all()
    const allAfterRuns = yield* runs.list({ sessionID: id })
    const after = summaryRecovery ? allAfter.filter((row) => row.run_id === summaryRun) : allAfter
    const afterRuns = summaryRecovery ? allAfterRuns.filter((item) => item.run.id === summaryRun) : allAfterRuns
    if (
      summaryRecovery &&
      (after.filter((row) => row.id.includes("_compaction_")).length !== 1 ||
        !allBefore
          .filter((row) => row.id !== originalRow.id)
          .every((row) => JSON.stringify(allAfter.find((next) => next.id === row.id)) === JSON.stringify(row)) ||
        JSON.stringify(allBeforeRuns.map((item) => item.run.id)) !==
          JSON.stringify(allAfterRuns.map((item) => item.run.id)))
    )
      throw new Error("Summary recovery duplicated its request or changed prior work")
    const priorUsageUnchanged =
      JSON.stringify(after.find((row) => row.id === originalRow.id)) === JSON.stringify(originalRow)
    const sameRun =
      JSON.stringify(beforeRuns.map((item) => item.run.id)) === JSON.stringify(afterRuns.map((item) => item.run.id))
    if ((!priorUsageUnchanged && recovery !== "pending-available") || !sameRun)
      throw new Error("Recovery changed prior usage or allocated another run")
    if (pendingRecovery) {
      if (!lookupBindingValid) throw new Error("Reconciliation swallowed a request binding mismatch")
      if (recovery === "pending-available") {
        const original = decodeReceipt(after.find((row) => row.id === originalRow.id)?.billing_receipt)
        const previousSpending = pending?.state.settledMinor ?? 0
        if (
          reconciliationCalls !== 1 ||
          original.charge.amountMinor !== 4 ||
          original.catalog.revision !== pending?.catalog.revision ||
          original.settlement.state.settledMinor !== previousSpending + 4 ||
          original.settlement.state.activeReservationIDs.length !== 0
        )
          throw new Error("Pending recovery lost frozen prices or spending")
        if (outcomeUnknown) {
          if (
            Exit.isSuccess(exit) ||
            !Cause.pretty(exit.cause).includes("may already have been sent") ||
            providerCalls !== 0 ||
            after.length !== originalCount ||
            afterRuns[0]?.run.status !== "paused" ||
            JSON.stringify(afterRuns[0]?.checkpoint) !== JSON.stringify(beforeRuns[0]?.checkpoint)
          )
            throw new Error("Confirmed billing must not authorize replay of an unknown request outcome")
        } else {
          if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
          const next = decodeReceipt(after.find((row) => !before.some((prior) => prior.id === row.id))?.billing_receipt)
          if (
            providerCalls !== 1 ||
            after.length !== originalCount + 1 ||
            next.before.settledMinor !== previousSpending + 4 ||
            next.settlement.state.settledMinor !== previousSpending + 10 ||
            next.catalog.revision !== "resume-prices"
          )
            throw new Error("Summary continuation lost the recovered budget")
        }
      } else if (recovery === "pending-idle") {
        if (
          Exit.isFailure(exit) ||
          providerCalls !== 0 ||
          reconciliationCalls !== 0 ||
          JSON.stringify(after) !== JSON.stringify(before)
        )
          throw new Error("A fresh idle wake repeated settled work")
      } else if (
        Exit.isSuccess(exit) ||
        providerCalls !== 0 ||
        reconciliationCalls !== 1 ||
        after.length !== originalCount ||
        afterRuns[0]?.run.status !== "paused"
      ) {
        throw new Error("Unconfirmed pending usage was not preserved as paused")
      }
      return {
        recovery,
        providerCalls,
        reconciliationCalls,
        priorUsageUnchanged,
        sameRun,
        success: Exit.isSuccess(exit),
      }
    }
    if (recovery === "available") {
      if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
      const receipt = decodeReceipt(after.find((row) => row.id !== before[0]?.id)?.billing_receipt)
      if (
        providerCalls !== 1 ||
        after.length !== 2 ||
        receipt.before.settledMinor !== 1 ||
        receipt.settlement.state.settledMinor !== 4
      )
        throw new Error("Fresh recovery lost or duplicated spending")
    } else {
      const reason =
        recovery === "exhausted"
          ? "Budget exceeded"
          : recovery === "missing-policy"
            ? "requires its billing policy"
            : "budget policy changed"
      if (
        Exit.isSuccess(exit) ||
        !Cause.pretty(exit.cause).includes(reason) ||
        providerCalls !== 0 ||
        after.length !== 1
      )
        throw new Error(
          `Fresh recovery did not enforce ${recovery}: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "unexpected success"}`,
        )
    }
    return { recovery, providerCalls, priorUsageUnchanged, sameRun, success: Exit.isSuccess(exit) }
  }).pipe(Effect.provide(layer), Effect.scoped),
)
console.log(JSON.stringify(result))
