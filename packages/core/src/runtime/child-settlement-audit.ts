/**
 * Read-only settlement audit seam.
 *
 * This module composes the existing DurableRun and ExperienceStore owners for
 * recovery inspection.  It performs no writes, owns no state machine, and
 * never returns a permission to execute a provider.  A caller can use the
 * report to schedule the existing idempotent owner writes or route a conflict
 * to human review.
 */

import { Context, Effect, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { makeLocationNode } from "../effect/app-node"
import { ExperienceStoreV1, type TrustedExperienceIdentity } from "../experience-store"
import { DurableRun } from "./durable-run"
import * as ChildSettlement from "./child-settlement"

export type SettlementAuditStatus = "complete" | "repairable" | "manual-review" | "missing-intent"

export interface SettlementAuditInput {
  readonly identity: TrustedExperienceIdentity
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
}

export interface SettlementAuditReport {
  readonly parentRunID: SettlementAuditInput["parentRunID"]
  readonly childRunID: SettlementAuditInput["childRunID"]
  readonly status: SettlementAuditStatus
  readonly deterministic: true
  readonly providerExecutionAllowed: false
  readonly intentID?: string
  readonly facts?: ChildSettlement.SettlementFacts
  readonly decision?: ChildSettlement.SettlementRecoveryDecision
  readonly evidenceResolution?: import("../evidence").ReferenceResolution
  readonly reason: string
}

export interface Interface {
  readonly inspect: (input: SettlementAuditInput) => Effect.Effect<SettlementAuditReport, Error>
}

export class SettlementAuditError extends Error {
  readonly _tag = "Runtime.ChildSettlementAuditError"

  constructor(readonly reason: string) {
    super(reason)
    this.name = this._tag
  }
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ChildSettlementAudit") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runs = yield* DurableRun.Service
    const experience = yield* ExperienceStoreV1.Service

    const inspect: Interface["inspect"] = Effect.fn("ChildSettlementAudit.inspect")(function* (input) {
      const intent = yield* runs.readChildSettlementIntent({
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
      })
      if (intent === undefined)
        return Object.freeze({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          status: "missing-intent" as const,
          deterministic: true as const,
          providerExecutionAllowed: false as const,
          reason: "No durable settlement intent exists; automatic recovery is forbidden.",
        })

      const durable = yield* runs.readChildSettlementFacts({
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
      })
      // When admission evidence exists, resolve every result EvidenceID so a
      // missing supporting reference cannot be mistaken for a complete row.
      // Legacy children intentionally resolve an empty set and keep Evidence
      // outside their compatibility settlement gate.
      const evidenceIDs = intent.admissionEvidence === undefined ? [] : intent.evidenceRefs
      const resolvedExit = yield* experience.resolveEvidenceFacts(input.identity, evidenceIDs).pipe(Effect.exit)
      if (resolvedExit._tag === "Failure")
        return Object.freeze({
          parentRunID: input.parentRunID,
          childRunID: input.childRunID,
          status: "manual-review" as const,
          deterministic: true as const,
          providerExecutionAllowed: false as const,
          intentID: intent.intentID,
          reason: "Evidence resolver failed closed; manual review is required.",
        })

      let facts: ChildSettlement.SettlementFacts
      try {
        facts = ChildSettlement.mergeEvidenceFacts(intent, durable, resolvedExit.value)
      } catch (cause) {
        throw new SettlementAuditError(`Settlement facts could not be merged: ${String(cause)}`)
      }
      const decision = ChildSettlement.reconcile(intent, facts)
      const status: SettlementAuditStatus = decision.complete
        ? "complete"
        : decision.conflicts.length > 0
          ? "manual-review"
          : "repairable"
      return Object.freeze({
        parentRunID: input.parentRunID,
        childRunID: input.childRunID,
        status,
        deterministic: true as const,
        providerExecutionAllowed: false as const,
        intentID: intent.intentID,
        facts,
        decision,
        evidenceResolution: resolvedExit.value.resolution,
        reason: decision.reason,
      })
    })

    return { inspect }
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [DurableRun.globalNode, ExperienceStoreV1.node],
})
