import type { Memory } from "@arforge-ai/schema/memory"
import * as Retention from "@arforge-ai/schema/memory-retention"

export const defaultPolicy = (input: {
  readonly source: Memory.Source
  readonly lifecycle: Retention.Lifecycle
  readonly explicitUserAuthority: boolean
  readonly expiresAt?: Retention.RetentionPolicy["expiresAt"]
}): Retention.RetentionPolicy => {
  const userExplicit = input.explicitUserAuthority && (input.source === "user" || input.source === "user-corrected")
  if (userExplicit) {
    return {
      mode: "indefinite",
      autoForget: false,
      userExplicitNoDecay: true,
    }
  }
  if (input.lifecycle === "candidate" || input.source === "auto" || input.source === "model") {
    return {
      mode: input.expiresAt === undefined ? "decay" : "ttl_and_decay",
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      halfLifeDays: 30,
      autoForget: input.expiresAt !== undefined,
      userExplicitNoDecay: false,
    }
  }
  return {
    mode: input.expiresAt === undefined ? "indefinite" : "ttl",
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    autoForget: input.expiresAt !== undefined,
    userExplicitNoDecay: false,
  }
}

export const strengthAfterDays = (input: {
  readonly strength: number
  readonly elapsedDays: number
  readonly policy: Retention.RetentionPolicy
}): number => {
  if (input.policy.userExplicitNoDecay || input.policy.halfLifeDays === undefined || input.policy.halfLifeDays <= 0)
    return input.strength
  if (input.elapsedDays <= 0) return input.strength
  return Math.max(0, Math.min(1, input.strength * 0.5 ** (input.elapsedDays / input.policy.halfLifeDays)))
}

export type MaintenanceDeletePolicyInput = {
  readonly actor?: string
  readonly maintenanceAuthority?: boolean
  readonly explicitDestructive?: boolean
  readonly actionID?: Retention.MaintenanceDeleteRequest["actionID"]
  readonly redactionEvidenceID?: Retention.MaintenanceDeleteRequest["redactionEvidenceID"]
}

export const maintenanceDeleteDecision = (input: MaintenanceDeletePolicyInput): Retention.DeleteDecision => {
  if (input.actor !== "maintenance")
    return {
      allowed: false,
      reason: "Memory delete requires maintenance authority through ActionGateway.",
      clearsProjection: false,
      clearsRevisions: false,
      clearsRelations: false,
      updatesRetrievalIndex: false,
      recordsRedactionEvidence: false,
    }
  if (input.maintenanceAuthority !== true || input.explicitDestructive !== true || input.actionID === undefined) {
    return {
      allowed: false,
      reason: "Memory delete requires an explicit destructive ActionGateway grant.",
      clearsProjection: false,
      clearsRevisions: false,
      clearsRelations: false,
      updatesRetrievalIndex: false,
      recordsRedactionEvidence: false,
    }
  }
  if (input.redactionEvidenceID === undefined) {
    return {
      allowed: false,
      reason: "Memory delete requires redaction evidence before destructive removal.",
      clearsProjection: false,
      clearsRevisions: false,
      clearsRelations: false,
      updatesRetrievalIndex: false,
      recordsRedactionEvidence: false,
    }
  }
  return {
    allowed: true,
    reason: "Authorized destructive delete must clear projections, revisions, relations and retrieval index.",
    clearsProjection: true,
    clearsRevisions: true,
    clearsRelations: true,
    updatesRetrievalIndex: true,
    recordsRedactionEvidence: true,
  }
}
