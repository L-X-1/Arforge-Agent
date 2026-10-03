import { Schema } from "effect"

/**
 * Canonical Memory Kernel V1 classes.
 *
 * `type` remains the legacy/product-facing category (fact, workflow, etc.)
 * until the additive Memory migration. These classes are the lifecycle and
 * governance boundary and must not be inferred from arbitrary legacy strings
 * without an explicit migration decision.
 */
export const MemoryClass = Schema.Literals(["working", "episodic", "semantic", "user", "project"]).annotate({
  identifier: "MemoryClass",
})
export type MemoryClass = typeof MemoryClass.Type

export const LongTermMemoryClass = Schema.Literals(["episodic", "semantic", "user", "project"]).annotate({
  identifier: "LongTermMemoryClass",
})
export type LongTermMemoryClass = typeof LongTermMemoryClass.Type

/** Experience and Skill have independent lifecycles and are not Memory classes. */
export const NonMemoryArtifact = Schema.Literals(["experience", "skill"]).annotate({
  identifier: "NonMemoryArtifact",
})
export type NonMemoryArtifact = typeof NonMemoryArtifact.Type

export interface Definition {
  readonly durable: boolean
  readonly description: string
  readonly provenance: "run-event-observation" | "evidence" | "user-authority" | "project-authority"
}

export const Definitions: Readonly<Record<MemoryClass, Definition>> = Object.freeze({
  working: {
    durable: false,
    description: "Current Run short-term state; never stored in the long-term Memory table.",
    provenance: "run-event-observation",
  },
  episodic: {
    durable: true,
    description: "Run/Event/Observation history references without copying raw events.",
    provenance: "run-event-observation",
  },
  semantic: {
    durable: true,
    description: "Project or domain facts supported by registered evidence.",
    provenance: "evidence",
  },
  user: {
    durable: true,
    description: "Explicit user preference, identity, or constraint.",
    provenance: "user-authority",
  },
  project: {
    durable: true,
    description: "Architecture decision, convention, or stable project configuration.",
    provenance: "project-authority",
  },
})

export const isLongTerm = (value: MemoryClass): value is LongTermMemoryClass => value !== "working"

export const isMemoryClass = (value: string): value is MemoryClass =>
  value === "working" || value === "episodic" || value === "semantic" || value === "user" || value === "project"
