import * as MemoryPolicy from "@arforge-ai/schema/memory-policy"

export const POLICY_VERSION = "memory-write-policy-v1"

const reject = (reason: string): MemoryPolicy.Decision => ({
  action: "reject",
  policyVersion: POLICY_VERSION,
  reason,
  trust: "derived",
  isolated: true,
  requiresRevision: false,
  requiresReview: false,
})

/**
 * Deterministic write policy for Step 5.4. It is deliberately pure so the
 * same decision can be replayed by a durable writer once Step 5.5 supplies
 * actor, revision and evidence references.
 */
export const evaluateWrite = (input: MemoryPolicy.WriteInput): MemoryPolicy.Decision => {
  if (input.proposedClass === "working") return reject("Working state must remain in the current Run.")
  if (input.credentialLike) return reject("Credentials and credential-like content are never Memory.")
  if (input.shortTermState) return reject("Short-term task state is not durable Memory.")
  if (input.sensitivity === "secret") return reject("Secret-sensitive content is not eligible for Memory.")
  if ((input.scope === "global" || input.crossWorkspace) && !input.explicitUserAuthority) {
    return reject("Global or cross-workspace Memory requires explicit user authority.")
  }

  switch (input.source) {
    case "user":
      return input.explicitUserAuthority
        ? {
            action: "active",
            policyVersion: POLICY_VERSION,
            reason: "Explicit user-authored Memory may enter active state after audit.",
            trust: "trusted",
            isolated: false,
            requiresRevision: true,
            requiresReview: false,
          }
        : reject("The user source label cannot replace explicit user authority.")
    case "user-corrected":
      return input.explicitUserAuthority
        ? {
            action: "active_revision",
            policyVersion: POLICY_VERSION,
            reason: "User correction must create a new revision and supersede the prior record.",
            trust: "trusted",
            isolated: false,
            requiresRevision: true,
            requiresReview: false,
          }
        : reject("A user-corrected Memory requires explicit user authority.")
    case "imported":
      return {
        action: "candidate",
        policyVersion: POLICY_VERSION,
        reason: "Imported Memory stays source-isolated and requires review by default.",
        trust: "untrusted-memory",
        isolated: true,
        requiresRevision: true,
        requiresReview: true,
      }
    case "auto":
    case "model":
      return {
        action: "candidate",
        policyVersion: POLICY_VERSION,
        reason: "Model or automatic Memory must remain a candidate until policy/manual activation.",
        trust: "derived",
        isolated: true,
        requiresRevision: true,
        requiresReview: true,
      }
    case "quarantined":
    case "quarantined:auto":
      case "quarantined:model":
        return reject("Quarantined records cannot be used as a new Memory write source.")
    }
  return reject("Unsupported Memory source.")
}
