/** Shared immutable child identity and result digest primitives. */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { canonicalHash } from "../util/canonical-hash"

export type ChildResultInput = Omit<AgentRuntime.ChildRunResult, "resultDigest" | "recordedAt">

export const childRunIDFor = (parentRunID: AgentRuntime.RunID, idempotencyKey: string) => {
  const digest = canonicalHash({ version: 1, parentRunID, idempotencyKey })
  return digest === undefined ? undefined : AgentRuntime.RunID.make(`run_child_${digest}`)
}

export const childResultDigest = (result: ChildResultInput) =>
  canonicalHash({
    version: 1,
    status: result.status,
    summary: result.summary,
    artifactRefs: [...result.artifactRefs],
    evidenceRefs: [...result.evidenceRefs],
    usage: result.usage,
  })
