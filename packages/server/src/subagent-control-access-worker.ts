// Isolated settled-control replay: no HTTP credentials or caller-supplied session identity.
const [databasePath, workspace, runID, mode = "replay", readyMarker] = Bun.argv.slice(2)
if (!databasePath || !workspace || !runID) throw new Error("missing isolated access probe arguments")
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = workspace
process.env.ARFORGE_AUTH_MODE = "users"

const { Effect, Layer } = await import("effect")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { Database } = await import("@arforge-ai/core/database/database")
const { EventV2 } = await import("@arforge-ai/core/event")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const access = await import("@arforge-ai/core/runtime/subagent-control-access")
const { rebuildMaterial, executeControlGateway, receiptFromResult, decodeControlGatewayReceipt } = await import(
  "@arforge-ai/core/runtime/subagent-control-recovery"
)
const gateway = await import("@arforge-ai/core/action-gateway")
const controlService = await import("@arforge-ai/core/runtime/subagent-control")
const { Location } = await import("@arforge-ai/core/location")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { ProjectID } = await import("@arforge-ai/schema/project-id")
const ControlClaimIndex = await import("@arforge-ai/core/runtime/control-claim-index")
const { DateTime } = await import("effect")
const { writeFileSync, readFileSync, existsSync } = await import("node:fs")
const { canonicalHash } = await import("@arforge-ai/core/util/canonical-hash")
const recovery = await import("@arforge-ai/core/runtime/subagent-control-recovery")
const invariants = await import("@arforge-ai/core/runtime/invariants")
const { buildSharedLocationServiceMap } = await import("@arforge-ai/core/location-services")
if (
  ![
    "replay",
    "replay-revoke",
    "recover-revoke",
    "prepare",
    "prepare-settled",
    "prepare-periodic",
    "recover",
    "recover-settled",
    "recover-scan",
    "recover-scan-settled",
    "recover-scan-periodic",
  ].includes(mode)
)
  throw new Error("invalid control recovery fixture mode")

const directory = AbsolutePath.make(workspace)
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, gateway.node, controlService.node, invariants.node]),
  [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of({ directory, project: { id: ProjectID.global, directory } })),
    ],
  ],
)
const allowed = await Effect.runPromise(
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const database = yield* Database.Service
    const control = yield* runtime.load(AgentRuntime.RunID.make(runID))
    if (!("subject" in control.run)) throw new Error("access probe requires a ControlRun")
    if (!mode.startsWith("recover") && control.run.status !== "completed")
      throw new Error("settled replay probe requires a completed ControlRun")
    const material = rebuildMaterial(control.run)
    if (mode === "recover-revoke" && (control.run.status !== "running" || !control.activeAttempt))
      throw new Error("running revocation requires the original unfinished attempt")
    const parent = yield* runtime.load(material.envelope.parentRunID)
    if (!("sessionID" in parent.run) || !parent.lease)
      throw new Error("replay probe requires the original parent lease")
    if (mode.startsWith("prepare")) {
      if (!readyMarker) throw new Error("prepare requires a ready marker")
      const principal = yield* access.principalForClaim(database, control.run)
      const requestID = AgentRuntime.ControlPlaneRequestID.make(`cpr_crash_${crypto.randomUUID()}`)
      const service = yield* controlService.Service
      const pending = yield* service
        .claim({
          ...material.envelope,
          requestID,
          subject: { ...control.run.subject, requestID },
        })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const pendingID = pending.snapshot.run.id
      const acquired = yield* runtime.acquireControlLease({
        runID: pendingID,
        ownerID: "crash-fixture-worker",
        ttlMs: mode === "prepare-periodic" ? 8_000 : 2_000,
      })
      for (const to of ["preflight", "queued", "running"] as const)
        yield* runtime.transitionControl(acquired.capability, {
          runID: pendingID,
          to,
          reason: "isolated worker crash preparation",
        })
      const started = yield* runtime.beginControlAttempt(acquired.capability, { runID: pendingID })
      if (!started.activeAttempt || !started.lease) throw new Error("crash fixture did not persist attempt and lease")
      let settledReceipt: ReturnType<typeof receiptFromResult> | undefined
      if (mode === "prepare-settled") {
        const pendingMaterial = rebuildMaterial(pending.snapshot.run)
        const engine = yield* gateway.Service
        settledReceipt = yield* engine.execute(
          { ...pendingMaterial.gateway, runID: pendingID, runLease: acquired.capability, allowControlRecovery: true },
          {
            authorization: pendingMaterial.authorization,
            durableResult: {
              encode: (value: ReturnType<typeof receiptFromResult>) => value,
              decode: decodeControlGatewayReceipt,
            },
            execute: () =>
              service
                .wait({
                  callerRunID: parent.run.id,
                  parentRunID: parent.run.id,
                  childRunID: pendingMaterial.envelope.childRunID,
                  leaseID: parent.lease!.id,
                  ownerID: parent.lease!.ownerID,
                  operation: "wait",
                  timeoutMs: 0,
                })
                .pipe(Effect.map((result) => receiptFromResult(result, pendingMaterial))),
          },
        )
        const unclosed = yield* runtime.load(pendingID)
        if (unclosed.run.status !== "running" || !unclosed.activeAttempt)
          throw new Error("settled-action crash window lost its unfinished control attempt")
      }
      writeFileSync(
        readyMarker,
        JSON.stringify({
          runID: pendingID,
          expiresAt: DateTime.toEpochMillis(started.lease.expiresAt),
          settledReceipt,
        }),
        "utf8",
      )
      return yield* Effect.never
    }
    if (mode.startsWith("recover-scan")) {
      if (!readyMarker || control.run.status !== "running" || !control.activeAttempt)
        throw new Error("scan barrier requires the original unfinished control attempt")
      writeFileSync(`${readyMarker}.scan-${process.pid}`, "ready", "utf8")
      yield* Effect.gen(function* () {
        while (!existsSync(`${readyMarker}.scan-release`)) yield* Effect.sleep("10 millis")
      }).pipe(Effect.timeout("10 seconds"))
      // No start/recover call: only the production service's own scans may wake this run.
      yield* Effect.gen(function* () {
        const scanStartedAt = Date.now()
        const periodic = mode === "recover-scan-periodic"
        if (periodic && (!control.lease || DateTime.toEpochMillis(control.lease.expiresAt) < scanStartedAt + 1_500))
          throw new Error("periodic fixture missed the active lease window")
        yield* recovery.make
        if (periodic) {
          yield* Effect.sleep("1 second")
          const held = yield* runtime.load(control.run.id)
          if (JSON.stringify(held) !== JSON.stringify(control))
            throw new Error("initial scan mutated a control run with an active lease")
        }
        while (true) {
          const observed = yield* runtime.load(control.run.id)
          if (observed.run.status === "completed" && !observed.activeAttempt) {
            if (periodic && Date.now() - scanStartedAt < 29_000)
              throw new Error("periodic recovery completed before the scheduled rescan")
            return
          }
          yield* Effect.sleep("20 millis")
        }
      }).pipe(
        Effect.timeout(mode === "recover-scan-periodic" ? "40 seconds" : "10 seconds"),
        Effect.provide(buildSharedLocationServiceMap()),
      )
    }
    const engine = yield* gateway.Service
    const guardedEngine: typeof engine = mode.endsWith("-revoke")
      ? {
          ...engine,
          execute: (...args) =>
            engine.execute(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (!readyMarker) throw new Error("revocation replay requires a barrier")
                  writeFileSync(
                    `${readyMarker}.revoke-ready`,
                    JSON.stringify({ sessionID: material.envelope.sessionID }),
                    "utf8",
                  )
                  while (!existsSync(`${readyMarker}.revoke-release`)) yield* Effect.sleep("10 millis")
                }).pipe(Effect.timeout("10 seconds"), Effect.orDie),
              ),
            ),
        }
      : engine
    const receipt = mode.startsWith("recover-scan")
      ? undefined
      : yield* executeControlGateway({
          runID: control.run.id,
          material,
          sealedKind: "existing",
          parentLease: parent.lease,
          durable: runtime,
          database,
          gateway: guardedEngine,
          control: yield* controlService.Service,
          ...(mode.startsWith("replay") ||
          mode === "recover-revoke" ||
          mode === "recover-settled" ||
          mode.startsWith("recover-scan")
            ? { direct: () => Effect.die(new Error("Settled replay must not execute the direct operation again")) }
            : {}),
        }).pipe(
          Effect.catchIf(
            (error) => error instanceof access.AccessDeniedError,
            (error) =>
              Effect.gen(function* () {
                const denied = yield* runtime.load(control.run.id)
                if (mode.endsWith("-revoke")) {
                  if (
                    JSON.stringify(denied.run) !== JSON.stringify(control.run) ||
                    JSON.stringify(denied.activeAttempt) !== JSON.stringify(control.activeAttempt) ||
                    denied.lease
                  )
                    throw new Error("Revoked recovery changed the original run/attempt or retained its control lease")
                } else if (JSON.stringify(denied) !== JSON.stringify(control))
                  throw new Error("Denied control replay mutated the persisted control snapshot")
                return yield* Effect.fail(error)
              }),
          ),
        )
    if (mode === "recover-settled" || (mode === "replay" && readyMarker)) {
      if (!readyMarker) throw new Error("settled recovery requires its crash receipt")
      const expected = JSON.parse(readFileSync(readyMarker, "utf8")).settledReceipt
      if ((mode === "recover-settled" && !expected) || (expected && canonicalHash(receipt) !== canonicalHash(expected)))
        throw new Error("Recovered Gateway result differs from the pre-crash settled receipt")
    }
    const after = yield* runtime.load(control.run.id)
    if (after.run.status !== "completed" || after.activeAttempt !== undefined)
      throw new Error("Settled replay changed the completed control lifecycle")
    if (mode === "replay" && JSON.stringify(after.run.budget) !== JSON.stringify(control.run.budget))
      throw new Error("Settled replay charged the control budget again")
    if (mode.startsWith("recover") && (after.run.budget.maxAttempts !== 1 || after.run.budget.attemptsUsed !== 1))
      throw new Error("Interrupted recovery must settle the original single logical attempt")
    if (!("operation" in after.run) || JSON.stringify(after.run.operation) !== JSON.stringify(control.run.operation))
      throw new Error("Recovery changed the immutable control operation")
    return true
  }).pipe(
    Effect.catchIf(
      (error) => error instanceof access.AccessDeniedError,
      () => Effect.succeed(false),
    ),
    Effect.scoped,
    Effect.provide(layer),
  ),
)
console.log(`SUBAGENT_ACCESS=${allowed ? "allowed" : "denied"}`)
