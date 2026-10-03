import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Cause, DateTime, Effect, Exit } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { mutationAction, runtimeLayer } from "../../core/test/fixture/action-crash-contract"
import { createEmbeddedRoutes } from "./routes"

type ProbeMode = "postimage" | "preimage" | "changed" | "missing" | "error" | "review" | "rollback" | "blocked"

const [databasePath, workspace, rawMode = "postimage"] = Bun.argv.slice(2)
if (!databasePath || !workspace) throw new Error("live recovery route child requires database and workspace paths")
if (
  !(
    ["postimage", "preimage", "changed", "missing", "error", "review", "rollback", "blocked"] as ReadonlyArray<string>
  ).includes(rawMode)
)
  throw new Error(`unknown live recovery route probe mode: ${rawMode}`)
const mode = rawMode as ProbeMode

const beforeContent = "runtime-insight-before"
const afterContent = "runtime-insight-postimage"
const changedContent = "runtime-insight-changed"
const target = mode === "error" ? "../runtime-insight-outside.txt" : `runtime-insight-${mode}.txt`

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex")
const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> =
  mode === "preimage" || mode === "changed"
    ? [
        {
          target,
          operation: "write",
          beforeDigest: digest(beforeContent),
          afterDigest: digest(afterContent),
          afterByteLength: Buffer.byteLength(afterContent),
          recovery: "manual-review",
        },
      ]
    : [
        {
          target,
          operation: "create",
          afterDigest: digest(afterContent),
          afterByteLength: Buffer.byteLength(afterContent),
          recovery: "remove-if-matching",
        },
      ]
const manifestDigest = MutationIntent.manifestDigest(entries)
ensure(manifestDigest !== undefined, "mutation manifest digest was not produced")

if (mode === "preimage") writeFileSync(join(workspace, target), beforeContent, { encoding: "utf8", flag: "wx" })
if (mode === "changed") writeFileSync(join(workspace, target), changedContent, { encoding: "utf8", flag: "wx" })

const actionInput = mutationAction()
const transactionID = AgentRuntime.MutationTransactionID.create()
const execution = await Effect.runPromise(
  Effect.gen(function* () {
    const gateway = yield* ActionGateway.Service
    const result = yield* gateway
      .execute(actionInput, {
        execute: () =>
          Effect.gen(function* () {
            if (!gateway.recordMutationIntent) return yield* Effect.fail(new Error("mutation recorder missing"))
            const now = yield* DateTime.now
            yield* gateway.recordMutationIntent({
              actionID: actionInput.actionID,
              transactionID,
              phase: "prepared",
              entries,
              manifestDigest,
              createdAt: now,
              updatedAt: now,
              summary: `prepared for live recovery inspection route (${mode})`,
            })
            if (mode === "review")
              yield* gateway.recordMutationIntent({
                actionID: actionInput.actionID,
                transactionID,
                phase: "committed",
                entries,
                manifestDigest,
                createdAt: now,
                updatedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1),
                summary: "committed for live recovery review route",
              })
            if (mode === "postimage" || mode === "review" || mode === "rollback" || mode === "blocked")
              writeFileSync(join(workspace, target), afterContent, { encoding: "utf8", flag: "wx" })
            return yield* Effect.fail(new Error("intentional route fixture failure"))
          }),
      })
      .pipe(Effect.exit)
    const actions = yield* DurableAction.Service
    return { result, state: yield* actions.load(actionInput.actionID) }
  }).pipe(Effect.scoped, Effect.provide(runtimeLayer(databasePath))),
)

ensure(Exit.isFailure(execution.result), "route fixture unexpectedly succeeded")
ensure(execution.state.action.status === "blocked", "route fixture action did not block")
ensure(
  execution.state.mutationIntent?.phase === (mode === "review" ? "committed" : "prepared"),
  "route fixture mutation intent phase changed",
)
ensure(
  String(Cause.squash(execution.result.cause)).includes("intentional route fixture failure"),
  "fixture failure mismatch",
)
if (mode === "postimage" || mode === "review" || mode === "rollback" || mode === "blocked")
  ensure(readFileSync(join(workspace, target), "utf8") === afterContent, "postimage was not written")
if (mode === "preimage") ensure(readFileSync(join(workspace, target), "utf8") === beforeContent, "preimage changed")
if (mode === "changed")
  ensure(readFileSync(join(workspace, target), "utf8") === changedContent, "changed image missing")
if (mode === "missing") ensure(!existsSync(join(workspace, target)), "missing target unexpectedly exists")

const web = HttpRouter.toWebHandler(createEmbeddedRoutes() as never, { disableLogger: true }) as unknown as {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

try {
  const locationQuery = `location[directory]=${encodeURIComponent(workspace)}`
  const missingResponse = await web.handler(
    new Request(`http://localhost/api/runtime-insight/actions/act_missing/recovery?${locationQuery}`),
  )
  const missingBody = (await missingResponse.json()) as {
    readonly kind?: string
    readonly field?: string
    readonly message?: string
  }
  ensure(missingResponse.status === 400, "missing action route did not return 400")
  ensure(missingBody.kind === "durable-action-not-found", "missing action error kind changed")
  ensure(missingBody.field === "actionID", "missing action error field changed")
  ensure(
    missingBody.message === "The requested durable action was not found in this workspace.",
    "missing action message changed",
  )

  const response = await web.handler(
    new Request(`http://localhost/api/runtime-insight/actions/${actionInput.actionID}/recovery?${locationQuery}`),
  )
  const body = (await response.json()) as {
    readonly actionID?: string
    readonly actionStatus?: string
    readonly state?: string
    readonly mutationRecovery?: {
      readonly phase?: string
      readonly decision?: string
      readonly automaticRetryAllowed?: boolean
      readonly requiresReview?: boolean
    } | null
    readonly inspection?: {
      readonly observationDigest?: string
      readonly decision?: string
      readonly automaticRetryAllowed?: boolean
      readonly entries?: ReadonlyArray<{ readonly target?: string; readonly state?: string }>
    } | null
    readonly inspectionError?: string | null
  }

  ensure(response.status === 200, `recovery route returned ${response.status}`)
  ensure(body.actionID === actionInput.actionID, "recovery action identity changed")
  ensure(body.actionStatus === "blocked", "recovery action status changed")
  ensure(body.state === "blocked", "recovery projection state changed")
  const expectedPhase = mode === "review" ? "committed" : "prepared"
  ensure(
    body.mutationRecovery?.phase === expectedPhase &&
      body.mutationRecovery.decision === "inspect" &&
      body.mutationRecovery.automaticRetryAllowed === false &&
      body.mutationRecovery.requiresReview === true,
    "mutation recovery safety projection changed",
  )

  const expectedDecision =
    mode === "postimage" || mode === "review" || mode === "rollback" || mode === "blocked"
      ? "postimage_matches"
      : mode === "preimage" || mode === "missing"
        ? "preimage_matches"
        : "manual_review"
  if (mode === "error") {
    ensure(body.inspection === null, "containment failure unexpectedly returned inspection data")
    ensure(
      body.inspectionError === "Current target fingerprints could not be read; manual inspection is required.",
      "inspection error was not sanitized",
    )
  } else {
    ensure(body.inspection?.decision === expectedDecision, `${mode} inspection decision changed`)
    ensure(body.inspection.automaticRetryAllowed === false, `${mode} inspection unexpectedly allowed retry`)
    ensure(body.inspection.entries?.[0]?.target === target, `${mode} inspection target changed`)
    const expectedState =
      mode === "postimage" || mode === "review" || mode === "rollback" || mode === "blocked"
        ? "postimage_matches"
        : mode === "changed"
          ? "changed"
          : "preimage_matches"
    ensure(body.inspection.entries?.[0]?.state === expectedState, `${mode} inspection image state changed`)
    ensure(body.inspectionError === null, `${mode} inspection unexpectedly failed`)
  }
  const observationDigest = body.inspection?.observationDigest
  if (mode !== "error") ensure(typeof observationDigest === "string", `${mode} observation digest missing`)
  const inspectCurrentDigest = async () => {
    const currentResponse = await web.handler(
      new Request(`http://localhost/api/runtime-insight/actions/${actionInput.actionID}/recovery?${locationQuery}`),
    )
    const currentBody = (await currentResponse.json()) as {
      readonly inspection?: { readonly observationDigest?: string } | null
    }
    ensure(currentResponse.status === 200, "fresh recovery inspection did not return 200")
    ensure(typeof currentBody.inspection?.observationDigest === "string", "fresh observation digest missing")
    return currentBody.inspection.observationDigest
  }

  if (mode === "review") {
    const reviewURL = `http://localhost/api/runtime-insight/actions/${actionInput.actionID}/recovery/review?${locationQuery}`
    const mismatchResponse = await web.handler(
      new Request(reviewURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionID: transactionID,
          expectedPhase: "committed",
          observationDigest,
          decision: "settle_postimage",
          inspectedDecision: "manual_review",
        }),
      }),
    )
    const mismatchBody = (await mismatchResponse.json()) as { readonly kind?: string }
    ensure(mismatchResponse.status === 400, "review mismatch route did not return 400")
    ensure(mismatchBody.kind === "mutation-review-inspection-mismatch", "review mismatch error kind changed")

    const staleResponse = await web.handler(
      new Request(reviewURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionID,
          expectedPhase: "committed",
          observationDigest: "0".repeat(64),
          decision: "settle_postimage",
          inspectedDecision: "postimage_matches",
        }),
      }),
    )
    const staleBody = (await staleResponse.json()) as { readonly kind?: string }
    ensure(staleResponse.status === 400, "stale observation route did not return 400")
    ensure(staleBody.kind === "mutation-review-observation-stale", "stale observation error kind changed")

    const reviewResponse = await web.handler(
      new Request(reviewURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionID: transactionID,
          expectedPhase: "committed",
          observationDigest,
          decision: "settle_postimage",
          inspectedDecision: "postimage_matches",
        }),
      }),
    )
    const reviewBody = (await reviewResponse.json()) as {
      readonly actionStatus?: string
      readonly mutationRecovery?: {
        readonly phase?: string
        readonly decision?: string
        readonly automaticRetryAllowed?: boolean
      } | null
      readonly inspection?: { readonly observationDigest?: string; readonly decision?: string } | null
    }
    ensure(reviewResponse.status === 200, `review route returned ${reviewResponse.status}`)
    ensure(reviewBody.actionStatus === "blocked", "review route changed action status")
    ensure(
      reviewBody.mutationRecovery?.phase === "settled" &&
        reviewBody.mutationRecovery.decision === "settled" &&
        reviewBody.mutationRecovery.automaticRetryAllowed === false,
      "review route did not persist the safe settlement projection",
    )
    ensure(reviewBody.inspection?.decision === "postimage_matches", "review route inspection changed")
  }
  if (mode === "rollback" || mode === "blocked") {
    const reviewURL = `http://localhost/api/runtime-insight/actions/${actionInput.actionID}/recovery/review?${locationQuery}`
    const requiredRollbackResponse = await web.handler(
      new Request(reviewURL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transactionID,
          expectedPhase: "prepared",
          observationDigest,
          decision: "require_rollback",
          inspectedDecision: "postimage_matches",
        }),
      }),
    )
    const requiredRollbackBody = (await requiredRollbackResponse.json()) as {
      readonly actionStatus?: string
      readonly mutationRecovery?: { readonly phase?: string; readonly decision?: string } | null
      readonly inspection?: { readonly phase?: string; readonly decision?: string } | null
    }
    ensure(
      requiredRollbackResponse.status === 200,
      `require rollback route returned ${requiredRollbackResponse.status}`,
    )
    ensure(requiredRollbackBody.actionStatus === "blocked", "require rollback changed action status")
    ensure(
      requiredRollbackBody.mutationRecovery?.phase === "rollback_required" &&
        requiredRollbackBody.mutationRecovery.decision === "manual_rollback" &&
        requiredRollbackBody.inspection?.phase === "rollback_required" &&
        requiredRollbackBody.inspection.decision === "postimage_matches",
      "require rollback review projection changed",
    )

    if (mode === "rollback") {
      rmSync(join(workspace, target), { force: true })
      const rollbackObservationDigest = await inspectCurrentDigest()
      const confirmResponse = await web.handler(
        new Request(reviewURL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transactionID,
            expectedPhase: "rollback_required",
            observationDigest: rollbackObservationDigest,
            decision: "confirm_rolled_back",
            inspectedDecision: "preimage_matches",
          }),
        }),
      )
      const confirmBody = (await confirmResponse.json()) as {
        readonly actionStatus?: string
        readonly mutationRecovery?: { readonly phase?: string; readonly decision?: string } | null
        readonly inspection?: { readonly phase?: string; readonly decision?: string } | null
      }
      ensure(confirmResponse.status === 200, `confirm rollback route returned ${confirmResponse.status}`)
      ensure(confirmBody.actionStatus === "blocked", "confirm rollback changed action status")
      ensure(
        confirmBody.mutationRecovery?.phase === "rolled_back" &&
          confirmBody.mutationRecovery.decision === "settled" &&
          confirmBody.inspection?.phase === "rolled_back" &&
          confirmBody.inspection.decision === "preimage_matches",
        "confirm rollback review projection changed",
      )
    } else {
      writeFileSync(join(workspace, target), changedContent, { encoding: "utf8", flag: "w" })
      const blockedObservationDigest = await inspectCurrentDigest()
      const blockResponse = await web.handler(
        new Request(reviewURL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transactionID,
            expectedPhase: "rollback_required",
            observationDigest: blockedObservationDigest,
            decision: "block_rollback",
            inspectedDecision: "manual_review",
          }),
        }),
      )
      const blockBody = (await blockResponse.json()) as {
        readonly actionStatus?: string
        readonly mutationRecovery?: { readonly phase?: string; readonly decision?: string } | null
        readonly inspection?: { readonly phase?: string; readonly decision?: string } | null
      }
      ensure(blockResponse.status === 200, `block rollback route returned ${blockResponse.status}`)
      ensure(blockBody.actionStatus === "blocked", "block rollback changed action status")
      ensure(
        blockBody.mutationRecovery?.phase === "rollback_blocked" &&
          blockBody.mutationRecovery.decision === "blocked" &&
          blockBody.inspection?.phase === "rollback_blocked" &&
          blockBody.inspection.decision === "manual_review",
        "block rollback review projection changed",
      )
    }
  }
} finally {
  await web.dispose()
}

console.log(`runtime-insight-route-ok:${mode}`)
