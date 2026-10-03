import { Memory } from "./memory"
import * as MemoryCandidate from "./memory-candidate"
import * as MemoryClass from "./memory-class"
import { Schema } from "effect"

export const WriteAction = Schema.Literals(["active", "active_revision", "candidate", "reject"]).annotate({
  identifier: "MemoryWriteAction",
})
export type WriteAction = typeof WriteAction.Type

export const Trust = Schema.Literals(["trusted", "untrusted-memory", "derived"]).annotate({
  identifier: "MemoryWriteTrust",
})
export type Trust = typeof Trust.Type

export const WriteInput = Schema.Struct({
  source: Memory.Source,
  proposedClass: MemoryClass.MemoryClass,
  scope: Memory.Scope,
  sensitivity: MemoryCandidate.Sensitivity,
  explicitUserAuthority: Schema.Boolean,
  crossWorkspace: Schema.Boolean,
  credentialLike: Schema.Boolean,
  shortTermState: Schema.Boolean,
}).annotate({ identifier: "MemoryWritePolicyInput" })
export interface WriteInput extends Schema.Schema.Type<typeof WriteInput> {}

export const Decision = Schema.Struct({
  action: WriteAction,
  policyVersion: Schema.String,
  reason: Schema.String,
  trust: Trust,
  isolated: Schema.Boolean,
  requiresRevision: Schema.Boolean,
  requiresReview: Schema.Boolean,
}).annotate({ identifier: "MemoryWritePolicyDecision" })
export interface Decision extends Schema.Schema.Type<typeof Decision> {}
