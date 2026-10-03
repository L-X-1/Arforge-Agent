import type { AgentRuntime as AgentRuntimeSchema } from "@arforge-ai/schema/agent-runtime"

const [databasePath, workspace, mode] = Bun.argv.slice(2)
if (!databasePath || !workspace) throw new Error("subagent control route child requires database and workspace paths")

process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = workspace
process.env.ARFORGE_AUTH_MODE = mode === "users" ? "users" : "private"
process.env.ARFORGE_AUTH_SECRET = "subagent-auth-route-fixture-secret-32-characters"
process.env.ARFORGE_AUTH_EXPOSE_TOKENS = "true"
process.env.ARFORGE_PUBLIC_URL = "http://localhost"
process.env.ARFORGE_AUTH_EMAIL_WEBHOOK_URL = ""
process.env.ARFORGE_AUTH_EMAIL_WEBHOOK_TOKEN = ""

const { Effect, Layer } = await import("effect")
const { HttpRouter } = await import("effect/unstable/http")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { ProjectID } = await import("@arforge-ai/schema/project-id")
const { SessionSchema } = await import("@arforge-ai/core/session/schema")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { Database } = await import("@arforge-ai/core/database/database")
const { EventV2 } = await import("@arforge-ai/core/event")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const { ProjectTable } = await import("@arforge-ai/core/project/sql")
const { SessionTable } = await import("@arforge-ai/core/session/sql")
const { EventTable } = await import("@arforge-ai/core/event/sql")
const { eq } = await import("drizzle-orm")

const project = ProjectID.global
const location = AbsolutePath.make(workspace)
const parentSessionID = SessionSchema.ID.create()
const childSessionID = SessionSchema.ID.create()
const descendantSessionID = SessionSchema.ID.create()
const parentBudget = AgentRuntime.Budget.make({
  maxAttempts: 4,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 100_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})
const childBudget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 30_000,
  maxCostMicros: 10_000,
  maxTokens: 10_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const running = (
  runtime: import("@arforge-ai/core/runtime/durable-run").DurableRun.Interface,
  runID: AgentRuntimeSchema.RunID,
) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "HTTP control route fixture preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "HTTP control route fixture queued" })
    yield* runtime.transition({ runID, to: "running", reason: "HTTP control route fixture running" })
  })

const seedLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.globalNode]))
const fixture = Effect.gen(function* () {
  const runtime = yield* DurableRun.Service
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: location, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const [id, title] of [
    [parentSessionID, "HTTP parent"],
    [childSessionID, "HTTP child"],
  ] as const) {
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: project,
        slug: `${title.toLowerCase().replaceAll(" ", "-")}-${String(id).slice(-8)}`,
        directory: String(location),
        title,
        version: "route-test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
  const parent = yield* runtime.create({
    sessionID: parentSessionID,
    initiator: "agent",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "HTTP control route parent",
    budget: parentBudget,
    traceID: "http-control-parent",
    visibility: "details",
    project,
    location,
  })
  yield* running(runtime, parent.run.id)
  const child = yield* runtime.createChild({
    parentRunID: parent.run.id,
    sessionID: childSessionID,
    idempotencyKey: `http-control-child-${String(childSessionID)}`,
    delegatedObjective: "HTTP control route child",
    allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
    project,
    location,
    expectedDeliverable: {
      summaryRequired: true,
      artifactKinds: [],
      evidenceKinds: [],
      verifier: "parent",
    },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "HTTP control route child",
    budget: childBudget,
    traceID: "http-control-child",
    parentTraceID: "http-control-parent",
    visibility: "details",
  })
  yield* running(runtime, child.run.id)
  const leased = yield* runtime.acquireLease({ runID: parent.run.id, ownerID: "http-route-worker", ttlMs: 60_000 })
  if (!leased.lease) throw new Error("HTTP control route fixture did not acquire parent lease")
  if (mode === "users") {
    yield* db
      .insert(SessionTable)
      .values({
        id: descendantSessionID,
        project_id: project,
        slug: `auth-descendant-${descendantSessionID}`,
        directory: String(location),
        title: "Auth descendant",
        version: "route-test",
      })
      .run()
      .pipe(Effect.orDie)
    const descendant = yield* runtime.createChild({
      ...child.run,
      ...child.run.child,
      parentRunID: child.run.id,
      sessionID: descendantSessionID,
      idempotencyKey: `http-grandchild-${descendantSessionID}`,
      budget: { ...childBudget, maxAttempts: 1, maxDurationMs: 10_000, maxCostMicros: 1_000, maxTokens: 1_000 },
    })
    yield* running(runtime, descendant.run.id)
  }
  return { parentID: parent.run.id, childID: child.run.id }
})

const fixtureResult = await Effect.runPromise(fixture.pipe(Effect.scoped, Effect.provide(seedLayer)))

const { createEmbeddedRoutes } = await import("./routes")
const web = HttpRouter.toWebHandler(createEmbeddedRoutes() as never, { disableLogger: true }) as unknown as {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

const query = `location[directory]=${encodeURIComponent(workspace)}`
const endpoint = (operation: string) =>
  `http://localhost/api/subagent-control/${fixtureResult.parentID}/${fixtureResult.childID}/${operation}?${query}`
const childrenEndpoint = () => `http://localhost/api/subagent-control/${fixtureResult.parentID}/children?${query}`
if (mode === "users") {
  try {
    await Effect.runPromise(
      DurableRun.Service.use((runtime) =>
        Effect.gen(function* () {
          const parent = yield* runtime.load(fixtureResult.parentID)
          yield* runtime.releaseLease({
            runID: parent.run.id,
            leaseID: parent.lease!.id,
            ownerID: parent.lease!.ownerID,
            reason: "authenticated read-only history fixture",
          })
        }),
      ).pipe(Effect.scoped, Effect.provide(seedLayer)),
    )
    const snapshots = () =>
      Effect.runPromise(
        DurableRun.Service.use((runtime) =>
          Effect.all([
            runtime.load(fixtureResult.parentID),
            runtime.load(fixtureResult.childID),
            runtime.listChildren({ parentRunID: fixtureResult.childID, includeTerminal: true, limit: 1_000 }),
          ]),
        ).pipe(Effect.scoped, Effect.provide(seedLayer)),
      )
    const beforeReads = JSON.stringify(await snapshots())
    const { verifyAuthenticatedChildren } = await import("./subagent-control-auth-fixture")
    let interruptedRecoveryChecked = false
    await verifyAuthenticatedChildren({
      databasePath,
      parentSessionID,
      childSessionID,
      descendantSessionID,
      childRunID: fixtureResult.childID,
      endpoint: childrenEndpoint(),
      handler: web.handler,
      persistedAccess: async (runID) => {
        const probe = Bun.spawn(
          [process.execPath, `${import.meta.dir}/subagent-control-access-worker.ts`, databasePath, workspace, runID],
          {
            env: { ...process.env },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const stdout = new Response(probe.stdout).text()
        const stderr = new Response(probe.stderr).text()
        const deadline = setTimeout(() => probe.kill(), 15_000)
        try {
          const code = await probe.exited
          const output = await stdout
          const error = await stderr
          if (code !== 0) throw new Error(`isolated access probe failed (${code}): ${error}`)
          const result = output.split(/\r?\n/).find((line) => line.startsWith("SUBAGENT_ACCESS="))
          if (result === "SUBAGENT_ACCESS=allowed") {
            if (!interruptedRecoveryChecked) {
              interruptedRecoveryChecked = true
              const { verifyInterruptedControlRecovery } = await import("./subagent-control-crash-fixture")
              await verifyInterruptedControlRecovery(databasePath, workspace, runID)
            }
            return true
          }
          if (result === "SUBAGENT_ACCESS=denied") return false
          throw new Error("isolated access probe returned no decision")
        } finally {
          clearTimeout(deadline)
          probe.kill()
          await probe.exited
          await Promise.all([stdout, stderr])
        }
      },
      withControlLease: async (verify, afterVerification) => {
        if (JSON.stringify(await snapshots()) !== beforeReads)
          throw new Error("authenticated discovery mutated durable parent or child state")
        const lease = await Effect.runPromise(
          DurableRun.Service.use((runtime) =>
            runtime.acquireLease({
              runID: fixtureResult.parentID,
              ownerID: "auth-control-fixture",
              ttlMs: 120_000,
            }),
          ).pipe(Effect.scoped, Effect.provide(seedLayer)),
        )
        try {
          const beforeControl = JSON.stringify(await snapshots())
          await verify()
          if (JSON.stringify(await snapshots()) !== beforeControl)
            throw new Error("denied controls mutated durable state")
          await Effect.runPromise(
            DurableRun.Service.use((runtime) =>
              runtime.beginAttempt({
                runID: fixtureResult.childID,
              }),
            ).pipe(Effect.scoped, Effect.provide(seedLayer)),
          )
          await afterVerification()
          const cancelled = await Effect.runPromise(
            DurableRun.Service.use((runtime) => runtime.load(fixtureResult.childID)).pipe(
              Effect.scoped,
              Effect.provide(seedLayer),
            ),
          )
          if (cancelled.activeAttempt !== undefined || cancelled.run.status !== "cancelled")
            throw new Error("authorized cancellation did not settle the active attempt")
        } finally {
          await Effect.runPromise(
            DurableRun.Service.use((runtime) =>
              runtime.releaseLease({
                runID: fixtureResult.parentID,
                leaseID: lease.lease!.id,
                ownerID: lease.lease!.ownerID,
                reason: "auth control fixture finished",
              }),
            ).pipe(Effect.scoped, Effect.provide(seedLayer)),
          )
        }
      },
    })
  } finally {
    await web.dispose()
  }
  console.log("subagent-control-auth-route-ok")
  process.exit(0)
}
const statusEndpoint = (operation: string, requestID: string) =>
  `http://localhost/api/subagent-control/${fixtureResult.parentID}/${fixtureResult.childID}/${operation}/${requestID}?${query}`
const json = async (response: Response) => (await response.json()) as Record<string, any>
const actionEvents = async (actionID: string) =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db
          .select({ type: EventTable.type, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, actionID))
          .all()
          .pipe(Effect.orDie)
      }),
    ).pipe(Effect.provide(Database.layerFromPath(databasePath))),
  )

try {
  const rawLease = await web.handler(
    new Request(endpoint("steer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestID: "cpr_http_raw_lease",
        prompt: { text: "this must be rejected before admission" },
        leaseID: "lea_forged_client_value",
      }),
    }),
  )
  if (rawLease.status !== 400) throw new Error(`raw lease field was accepted (${rawLease.status})`)

  const children = await web.handler(
    new Request(childrenEndpoint(), {
      method: "GET",
    }),
  )
  if (children.status !== 200) throw new Error(`children returned ${children.status}: ${await children.text()}`)
  const childrenBody = await json(children)
  const listedChild = childrenBody.children?.[0]
  if (childrenBody.controlAvailable !== true) throw new Error("active parent controls should be available")
  if (
    childrenBody.parentRunID !== fixtureResult.parentID ||
    childrenBody.children?.length !== 1 ||
    listedChild?.childRunID !== fixtureResult.childID ||
    listedChild?.status !== "running" ||
    listedChild?.resultReceiptStatus !== "pending" ||
    listedChild?.depth !== 1 ||
    !/^[a-f0-9]{64}$/i.test(String(listedChild?.objectiveDigest))
  )
    throw new Error("children response did not expose the direct-child metadata projection")
  if (
    JSON.stringify(childrenBody).includes("HTTP control route child") ||
    JSON.stringify(childrenBody).includes("leaseID")
  )
    throw new Error("children response leaked delegated objective or lease metadata")

  const { RuntimeInsight } = await import("@arforge-ai/core/runtime/insight")
  const childrenAudit = RuntimeInsight.auditList(100).entries.find(
    (entry: { readonly action: string; readonly resource: string }) =>
      entry.action === "subagent.control.children.list" && entry.resource === fixtureResult.parentID,
  )
  if (!childrenAudit) throw new Error("children query did not append a durable-scope audit projection")
  if (
    JSON.stringify(childrenAudit).includes("HTTP control route child") ||
    JSON.stringify(childrenAudit).includes("leaseID")
  )
    throw new Error("children audit projection leaked delegated objective or lease metadata")

  const scopeConflict = await web.handler(
    new Request(
      `http://localhost/api/subagent-control/${fixtureResult.parentID}/children?location[directory]=${encodeURIComponent(
        process.cwd(),
      )}`,
      { method: "GET" },
    ),
  )
  if (scopeConflict.status !== 409)
    throw new Error(`children scope mismatch returned ${scopeConflict.status}: ${await scopeConflict.text()}`)

  const promptText = "private HTTP steering instruction"
  const steerRequest = {
    requestID: "cpr_http_steer_replay",
    prompt: { text: promptText },
  }
  const firstSteer = await web.handler(
    new Request(endpoint("steer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(steerRequest),
    }),
  )
  if (firstSteer.status !== 200) throw new Error(`steer returned ${firstSteer.status}: ${await firstSteer.text()}`)
  const firstBody = await json(firstSteer)
  if (firstBody.operation !== "steer" || firstBody.admission?.delivery !== "steer" || firstBody.claim !== "claimed")
    throw new Error("steer response did not expose deterministic admission metadata")
  if (JSON.stringify(firstBody).includes(promptText) || JSON.stringify(firstBody).includes("leaseID"))
    throw new Error("steer response leaked prompt or lease metadata")
  const firstActionEvents = await actionEvents(firstBody.actionID)
  if (
    !firstActionEvents.some((event) => event.type === "agent.action.observed.1") ||
    !firstActionEvents.some(
      (event) =>
        event.type === "agent.action.state-changed.1" && (event.data as Record<string, unknown>)?.to === "settled",
    )
  )
    throw new Error("steer did not persist a settled ActionGateway aggregate")
  if (JSON.stringify(firstActionEvents).includes(promptText))
    throw new Error("durable action events leaked the raw prompt")

  const replay = await web.handler(
    new Request(endpoint("steer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(steerRequest),
    }),
  )
  if (replay.status !== 200) throw new Error(`steer replay returned ${replay.status}: ${await replay.text()}`)
  const replayBody = await json(replay)
  if (replayBody.claim !== "existing" || replayBody.admission?.messageID !== firstBody.admission?.messageID)
    throw new Error("steer replay did not reuse the same claim and message identity")
  const replayActionEvents = await actionEvents(firstBody.actionID)
  if (replayActionEvents.length !== firstActionEvents.length)
    throw new Error("steer replay appended a second durable action execution")

  const claimStatus = await web.handler(
    new Request(statusEndpoint("steer", "cpr_http_steer_replay"), {
      method: "GET",
    }),
  )
  if (claimStatus.status !== 200) throw new Error(`claim status returned ${claimStatus.status}`)
  const claimStatusBody = await json(claimStatus)
  if (
    claimStatusBody.operation !== "steer" ||
    claimStatusBody.status !== "completed" ||
    claimStatusBody.claim !== "existing" ||
    claimStatusBody.actionID !== firstBody.actionID
  )
    throw new Error("claim status did not project the durable control identity")
  if (JSON.stringify(claimStatusBody).includes(promptText) || JSON.stringify(claimStatusBody).includes("leaseID"))
    throw new Error("claim status leaked prompt or lease metadata")

  const drift = await web.handler(
    new Request(endpoint("steer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...steerRequest, prompt: { text: "same request identity with changed prompt" } }),
    }),
  )
  if (drift.status !== 409) throw new Error(`steer drift returned ${drift.status}`)

  const followup = await web.handler(
    new Request(endpoint("followup"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_followup", prompt: { text: "queue one follow-up" } }),
    }),
  )
  if (followup.status !== 200) throw new Error(`followup returned ${followup.status}: ${await followup.text()}`)
  const followupBody = await json(followup)
  if (followupBody.operation !== "followup" || followupBody.admission?.delivery !== "queue")
    throw new Error("followup response did not use the shared queue delivery")
  const followupActionEvents = await actionEvents(followupBody.actionID)
  if (!followupActionEvents.some((event) => event.type === "agent.action.observed.1"))
    throw new Error("followup did not persist an observed ActionGateway result")

  const wait = await web.handler(
    new Request(endpoint("wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_wait", timeoutMs: 0 }),
    }),
  )
  if (wait.status !== 200) throw new Error(`wait returned ${wait.status}: ${await wait.text()}`)
  const waitBody = await json(wait)
  if (waitBody.timedOut !== true || waitBody.status !== "running") throw new Error("bounded wait changed running state")
  const waitActionEvents = await actionEvents(waitBody.actionID)
  if (!waitActionEvents.some((event) => event.type === "agent.action.observed.1"))
    throw new Error("wait did not persist an observed ActionGateway result")

  const cancel = await web.handler(
    new Request(endpoint("cancel"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_cancel", reason: "user stopped this child", timeoutMs: 0 }),
    }),
  )
  if (cancel.status !== 200) throw new Error(`cancel returned ${cancel.status}: ${await cancel.text()}`)
  const cancelBody = await json(cancel)
  if (cancelBody.resultReceiptStatus !== "not-required") throw new Error("cancel must not imply a result receipt")
  if (cancelBody.status !== "cancelled" || cancelBody.timedOut !== false) throw new Error("cancel did not settle child")
  if (JSON.stringify(cancelBody).includes("user stopped this child") || JSON.stringify(cancelBody).includes("leaseID"))
    throw new Error("cancel response leaked reason or lease metadata")
  const cancelActionEvents = await actionEvents(cancelBody.actionID)
  if (
    !cancelActionEvents.some((event) => event.type === "agent.action.observed.1") ||
    JSON.stringify(cancelActionEvents).includes("user stopped this child")
  )
    throw new Error("cancel did not persist a safe observed ActionGateway result")
  const cancelReplay = await web.handler(
    new Request(endpoint("cancel"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_cancel", reason: "user stopped this child", timeoutMs: 0 }),
    }),
  )
  if (cancelReplay.status !== 200) throw new Error(`cancel replay returned ${cancelReplay.status}`)
  const cancelReplayBody = await json(cancelReplay)
  if (cancelReplayBody.claim !== "existing" || cancelReplayBody.actionID !== cancelBody.actionID)
    throw new Error("cancel replay did not reuse the settled ActionGateway result")
  if ((await actionEvents(cancelBody.actionID)).length !== cancelActionEvents.length)
    throw new Error("cancel replay appended a second durable action execution")

  const afterCancelWait = await web.handler(
    new Request(endpoint("wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_wait_terminal", timeoutMs: 0 }),
    }),
  )
  if (afterCancelWait.status !== 200) throw new Error(`terminal wait returned ${afterCancelWait.status}`)
  const terminalBody = await json(afterCancelWait)
  if (terminalBody.status !== "cancelled" || terminalBody.timedOut !== false)
    throw new Error("terminal wait did not expose the cancelled snapshot")

  const terminalStatus = await web.handler(
    new Request(statusEndpoint("cancel", "cpr_http_cancel"), {
      method: "GET",
    }),
  )
  if (terminalStatus.status !== 200) throw new Error(`terminal claim status returned ${terminalStatus.status}`)
  const terminalStatusBody = await json(terminalStatus)
  if (terminalStatusBody.status !== "completed")
    throw new Error("control claim status should remain a claim snapshot independent of child terminal state")
  if (JSON.stringify(terminalStatusBody).includes("user stopped this child"))
    throw new Error("claim status leaked cancellation reason")

  const missingStatus = await web.handler(
    new Request(statusEndpoint("cancel", "cpr_http_missing_status"), {
      method: "GET",
    }),
  )
  if (missingStatus.status !== 404) throw new Error(`missing claim status returned ${missingStatus.status}`)

  const statusAudit = RuntimeInsight.auditList(100).entries.find(
    (entry: { readonly action: string; readonly resource: string }) =>
      entry.action === "subagent.control.status" && entry.resource === fixtureResult.childID,
  )
  if (!statusAudit) throw new Error("status query did not append a durable-scope audit projection")
  if (
    JSON.stringify(statusAudit).includes(promptText) ||
    JSON.stringify(statusAudit).includes("user stopped this child") ||
    JSON.stringify(statusAudit).includes("leaseID")
  )
    throw new Error("status audit projection leaked prompt, reason, or lease metadata")

  const leaseGone = await web.handler(
    new Request(endpoint("wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestID: "cpr_http_no_lease", timeoutMs: 0 }),
    }),
  )
  // The parent lease is still held intentionally: a terminal child remains
  // observable, and a parent owner can repeat the safe wait operation.
  if (leaseGone.status !== 200) throw new Error(`terminal replay wait returned ${leaseGone.status}`)

  for (const status of ["completed", "failed"] as const) {
    const terminalChild = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* DurableRun.Service
        const original = (yield* runtime.load(
          fixtureResult.childID,
        )) as import("@arforge-ai/core/runtime/durable-run").DurableRun.ChildSnapshot
        const child = yield* runtime.createChild({
          ...original.run,
          ...original.run.child,
          idempotencyKey: `receipt-projection-${status}`,
          budget: childBudget,
        })
        yield* running(runtime, child.run.id)
        yield* runtime.transition({ runID: child.run.id, to: status, reason: "receipt projection fixture" })
        return yield* runtime.load(child.run.id)
      }).pipe(Effect.scoped, Effect.provide(seedLayer)),
    )
    for (const receiptStatus of ["missing", "present"] as const) {
      if (receiptStatus === "present")
        await Effect.runPromise(
          Effect.gen(function* () {
            const runtime = yield* DurableRun.Service
            yield* runtime.recordChildResult({
              runID: terminalChild.run.id,
              result: {
                status,
                summary: "private receipt projection summary",
                artifactRefs: [],
                evidenceRefs: [],
                usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
              },
            })
          }).pipe(Effect.scoped, Effect.provide(seedLayer)),
        )
      const before = await Effect.runPromise(
        DurableRun.Service.use((runtime) => runtime.load(terminalChild.run.id)).pipe(
          Effect.scoped,
          Effect.provide(seedLayer),
        ),
      )
      const response = await web.handler(new Request(childrenEndpoint()))
      if (response.status !== 200) throw new Error(`receipt projection returned ${response.status}`)
      const body = await json(response)
      const projected = body.children.find((item: { childRunID: string }) => item.childRunID === terminalChild.run.id)
      if (projected?.status !== status || projected?.resultReceiptStatus !== receiptStatus)
        throw new Error(`${status} child did not expose ${receiptStatus} receipt`)
      if (JSON.stringify(body).includes("private receipt projection summary")) throw new Error("receipt summary leaked")
      const waitResponse = await web.handler(
        new Request(endpoint("wait").replace(fixtureResult.childID, terminalChild.run.id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestID: `cpr_receipt_${status}_${receiptStatus}`, timeoutMs: 0 }),
        }),
      )
      if (waitResponse.status !== 200) throw new Error(`receipt wait returned ${waitResponse.status}`)
      const waitProjection = await json(waitResponse)
      if (waitProjection.status !== status || waitProjection.resultReceiptStatus !== receiptStatus)
        throw new Error("wait and children receipt projections disagree")
      if (JSON.stringify(waitProjection).includes("private receipt projection summary"))
        throw new Error("wait leaked receipt summary")
      const after = await Effect.runPromise(
        DurableRun.Service.use((runtime) => runtime.load(terminalChild.run.id)).pipe(
          Effect.scoped,
          Effect.provide(seedLayer),
        ),
      )
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("receipt query mutated child state")
    }
  }
  await Effect.runPromise(
    DurableRun.Service.use((runtime) =>
      Effect.gen(function* () {
        const parent = yield* runtime.load(fixtureResult.parentID)
        yield* runtime.releaseLease({
          runID: parent.run.id,
          leaseID: parent.lease!.id,
          ownerID: parent.lease!.ownerID,
          reason: "read-only discovery after worker release",
        })
      }),
    ).pipe(Effect.scoped, Effect.provide(seedLayer)),
  )
  const unownedChildren = await web.handler(new Request(childrenEndpoint()))
  if (unownedChildren.status !== 200)
    throw new Error(`read-only discovery without a worker lease returned ${unownedChildren.status}`)
  if ((await json(unownedChildren)).controlAvailable !== false) throw new Error("unowned parent exposed controls")
  const { IdentityTenantTable, IdentityUserTable } = await import("@arforge-ai/core/identity/sql")
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(IdentityUserTable)
        .values({
          id: "usr_receipt_fixture",
          email: "receipt-fixture@example.invalid",
          normalized_email: "receipt-fixture@example.invalid",
          password_hash: "fixture-not-a-password",
          status: "active",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(IdentityTenantTable)
        .values({
          id: "ten_foreign_receipt",
          name: "Foreign receipt fixture",
          slug: "foreign-receipt",
          created_by_user_id: "usr_receipt_fixture",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.scoped, Effect.provide(seedLayer)),
  )
  for (const sessionID of [parentSessionID, childSessionID]) {
    const setTenant = (tenantID: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db
            .update(SessionTable)
            .set({ tenant_id: tenantID })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
        }).pipe(Effect.scoped, Effect.provide(seedLayer)),
      )
    await setTenant("ten_foreign_receipt")
    try {
      const forbidden = await web.handler(new Request(childrenEndpoint()))
      if (forbidden.status !== 403) throw new Error(`foreign session discovery returned ${forbidden.status}`)
      const denied = await forbidden.text()
      if (denied.includes(fixtureResult.childID) || denied.includes("objectiveDigest"))
        throw new Error("foreign session rejection leaked child metadata")
    } finally {
      await setTenant("ten_local")
    }
  }
  for (const operation of ["steer", "followup", "wait", "cancel"]) {
    const response = await web.handler(
      new Request(endpoint(operation), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestID: `cpr_no_lease_${operation}`,
          ...(operation === "steer" || operation === "followup"
            ? { prompt: { text: "must not run" } }
            : operation === "cancel"
              ? { reason: "must not cancel" }
              : { timeoutMs: 0 }),
        }),
      }),
    )
    if (response.status !== 409) throw new Error(`${operation} accepted missing parent lease`)
  }
} finally {
  await web.dispose()
}

console.log("subagent-control-route-ok")
