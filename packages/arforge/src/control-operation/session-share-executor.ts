import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { SessionShareProvider } from "@/share/provider"
import { SessionShareReceiptStore } from "@/share/receipt-store"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { Session } from "@/session/session"
import { SessionShareControlWorker } from "./session-share-worker"

const actionError = (actionID: AgentRuntime.ActionID, reason: string) =>
  new ActionGateway.BlockedError({ actionID, reason })

const recoveryError = (actionID: AgentRuntime.ActionID, reason: string) =>
  new ActionGateway.RecoveryRequiredError({ actionID, reason })

export type Error = ActionGateway.BlockedError | ActionGateway.RecoveryRequiredError

export const make = (input: {
  readonly provider: SessionShareProvider.Interface
  readonly receipts: SessionShareReceiptStore.Interface
  readonly sessions: Session.Interface
}): SessionShareControlWorker.SealedExecutor<SessionShareSnapshot.Snapshot, Error> => ({
  execute: Effect.fn("SessionShareControlExecutor.execute")(function* (command) {
    const { snapshot, runID, actionID, authorization } = command
    let grant: AgentRuntime.AuthorizationGrant | undefined
    try {
      grant = ActionGateway.capabilityGrant(authorization)
      const material = SessionShareSnapshot.actionMaterial(snapshot)
      const plan = SessionShareSnapshot.authorizationPlan(snapshot)
      if (
        !grant ||
        grant.subject?.type !== "control-plane" ||
        ActionGateway.capabilityAuthority(authorization) !== "human" ||
        grant.actionID !== actionID ||
        grant.runID !== runID ||
        canonicalHash(ActionGateway.capabilityRequests(authorization)) !== canonicalHash(plan.requests)
      )
        return yield* actionError(actionID, "The authorization grant does not match the sealed session share.")
      if (!/^[0-9a-f]{64}$/.test(snapshot.digest))
        return yield* actionError(actionID, "The sealed session share snapshot digest is invalid.")
    } catch {
      return yield* actionError(actionID, "The authorization grant capability is invalid.")
    }

    yield* command.controlLeaseValidated()
    const operationID = `${runID}:${snapshot.kind}`
    if (snapshot.kind === "share") {
      const published = yield* input.provider
        .publish({
          operationID,
          frozenExport: snapshot.export,
          exportDigest: snapshot.export.contentDigest,
          target: snapshot.target,
        })
        .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
      yield* Effect.try({
        try: () =>
          SessionShareProvider.verifyPublishResult(
            {
              operationID,
              frozenExport: snapshot.export,
              exportDigest: snapshot.export.contentDigest,
              target: snapshot.target,
            },
            published,
          ),
        catch: (cause) => recoveryError(actionID, `publish response verification failed: ${String(cause)}`),
      })
      const reconciled = yield* input.provider
        .lookup(operationID)
        .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
      const verified = yield* Effect.try({
        try: () =>
          SessionShareProvider.verifyPublishLookup(
            {
              operationID,
              frozenExport: snapshot.export,
              exportDigest: snapshot.export.contentDigest,
              target: snapshot.target,
            },
            reconciled,
          ),
        catch: (cause) => recoveryError(actionID, `publish lookup verification failed: ${String(cause)}`),
      })
      if (verified.status !== "settled")
        return yield* recoveryError(actionID, `publish operation is not settled: ${verified.status}`)
      const stored = yield* input.receipts
        .record({
          operationID,
          runID,
          actionID,
          requestID: snapshot.requestID,
          snapshot,
          result: verified,
        })
        .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
      yield* input.sessions
        .setShare({ sessionID: snapshot.sessionID, share: { url: stored.publication_url } })
        .pipe(
          Effect.mapError(() =>
            recoveryError(actionID, "The local Session publication pointer could not be committed."),
          ),
        )
      return
    }

    const publication = snapshot.target.publication
    if (!publication) return yield* actionError(actionID, "The sealed unshare has no original publication identity.")
    const revoked = yield* input.provider
      .revoke({
        operationID,
        publicationID: publication.id,
        originalDigest: publication.exportDigest,
        target: snapshot.target,
      })
      .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
    yield* Effect.try({
      try: () =>
        SessionShareProvider.verifyRevokeResult(
          {
            operationID,
            publicationID: publication.id,
            originalDigest: publication.exportDigest,
            target: snapshot.target,
          },
          revoked,
        ),
      catch: (cause) => recoveryError(actionID, `revoke response verification failed: ${String(cause)}`),
    })
    const reconciled = yield* input.provider
      .lookupRevoke(operationID)
      .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
    const verified = yield* Effect.try({
      try: () =>
        SessionShareProvider.verifyRevokeLookup(
          {
            operationID,
            publicationID: publication.id,
            originalDigest: publication.exportDigest,
            target: snapshot.target,
          },
          reconciled,
        ),
      catch: (cause) => recoveryError(actionID, `revoke lookup verification failed: ${String(cause)}`),
    })
    if (verified.status !== "settled")
      return yield* recoveryError(actionID, `revoke operation is not settled: ${verified.status}`)
    yield* input.receipts
      .record({
        operationID,
        runID,
        actionID,
        requestID: snapshot.requestID,
        snapshot,
        result: verified,
      })
      .pipe(Effect.mapError((error) => recoveryError(actionID, error.message)))
    yield* input.sessions
      .setShare({ sessionID: snapshot.sessionID, share: undefined })
      .pipe(
        Effect.mapError(() => recoveryError(actionID, "The local Session publication pointer could not be cleared.")),
      )
  }),
})

export * as SessionShareControlExecutor from "./session-share-executor"
