import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import type { OperationsApi } from "../../../src/utils/server"
const digest = "a".repeat(64), created = new Date(1700000000000).toISOString()
const [state, setState] = createStore({ directory: "C:/Isolated/Lifecycle/A", ready: true })
export { state }
const calls: { name: string; input: unknown; outcome: string }[] = [], failures = new Set<string>()
const query = new URLSearchParams(location.search)
let auditValid = query.get("scenario") !== "audit-invalid"
const memories = [1, 2].map(id => ({ id: "mem_" + id, content: id === 1 ? "The local build command is compile." : "The local build command is verify.",
  type: "fact", scope: "project", source: "user", tags: ["formal"], version: 7, importance: .7, strength: 1, reviewLevel: 0, time: { created: 100, updated: id * 100 } }))
const history: Array<Record<string, any>> = []
const conflict = { id: "mcf_1", status: "pending", conflictKey: "build-command", basis: "explicit-tag", leftMemoryID: "mem_1", rightMemoryID: "mem_2", chosenMemoryID: "", reason: "", revision: 1 }
const call = async <T,>(name: string, input: unknown, action: () => T): Promise<T> => {
  const hit={ name, input: structuredClone(input), outcome: "pending" };calls.push(hit)
  if (failures.delete(name)) { hit.outcome="injected-rejection";throw new Error("409 Isolated lifecycle rejection: " + name) }
  try { const result=structuredClone(action());hit.outcome="success";return result }
  catch(error) { hit.outcome="guard-rejection";throw error }
}
function candidate(status: "proposed" | "evaluated" | "approved" | "canary", id: number) {
  return Schema.decodeUnknownSync(AgentCapability.EvolutionCandidate)({ schema_version: 1, candidate_type: "strategy_rule", title: "Fixture strategy " + status,
    target: "learning.preference", instruction: "Verify the current implementation before reporting completion.", rationale: "Isolated explicit evidence.",
    evidence_refs: ["evd_fixture"], source_experience_ids: [], source_evidence_ids: ["evd_fixture"], source_evaluation_ids: [],
    source_provenance_digest: digest, source_provenance_artifact: null, capability_boundary: { permission_requests: [], secret_refs: [], network_egress: [] },
    evaluation_budget: { max_attempts: 2, max_duration_ms: 30000, max_cost_micros: 0 }, baseline_digest: digest,
    rollback_artifact: { artifact_id: "art_fixture", digest, plan_digest: digest, operation: "deactivate_strategy_overlay" },
    created_by: "human:fixture", created_at: created, constitution_version: "fixture-v1", evolution_level: "L2", candidate_id: "candidate_" + id, artifact_digest: digest,
    state: { schema_version: 1, candidate_id: "candidate_" + id, artifact_digest: digest, status, revision: 1, updated_at: created,
      evaluation_id: "", approval: null, deployment: null, rollback: null, promotion_gate: null, evolution_level: "L2" },
    ...(status === "evaluated" ? { evaluation: evaluation("candidate_" + id, true) } : {}),
  })
}
function evaluation(id: string, passed: boolean) { return { schema_version: 1, candidate_id: id, candidate_digest: digest, created_at: created,
  isolation: "temporary_directory", workspace_retained: false, gate_passed: passed,
  budget: { max_attempts: 2, attempts_used: 1, max_duration_ms: 30000, duration_ms_used: 100, max_cost_micros: 0, cost_micros_used: 0, passed: true },
  cases: [{ case_id: "case_fixture", category: "verification", passed, score: passed ? 1 : 0, baseline_score: 0, detail: passed ? "Evidence verified" : "Required evidence did not pass", required: true }], evaluation_id: "eva_fixture", report_digest: digest } }
let candidates: any[] = (["proposed", "evaluated", "approved", "canary"] as const).map(candidate)
const envelope = (data: unknown) => ({ location: { directory: state.directory, project: { id: "global", directory: "C:/" } }, data })
const conflictPage = () => ({ items: [{ conflict: { ...conflict }, left: memories[0], right: memories[1] }], count: 1, scanned: 2, detected: 1, newCandidates: 0 })
const memoryMethods = {
  list: (input: { query?: string }) => call("memory.list", input, () => ({ items: memories.filter(m => !input.query || m.content.includes(input.query)), total: memories.length })),
  facets: (input: unknown) => call("memory.facets", input, () => ({ types: [{ value: "fact", count: 2 }], tags: [{ value: "formal", count: 2 }] })),
  recallQuality: (input: unknown) => call("memory.quality", input, () => ({ sampleSize: 0, top1Rate: 0, meanReciprocalRank: 0, caveat: "No real model recall has run in this fixture." })),
  status: (input: unknown) => call("memory.status", input, () => ({ total: memories.length, important: 2, quarantined: 0, pendingConflicts: conflict.status === "pending" ? 1 : 0, recent: memories })),
  semantic: (input: unknown) => call("memory.semantic", input, () => ({ algorithm: "hybrid_bm25_hashing_vector", localOnly: true, embeddingEgress: "none", items: [], count: 0 })),
  conflictList: (input: unknown) => call("memory.conflicts", input, conflictPage), conflictScan: (input: unknown) => call("memory.scan", input, conflictPage),
  create: (input: any) => call("memory.create", input, () => { const m = { ...memories[0], ...input, id: "mem_created", time: { created: 300, updated: 300 } }; memories.push(m); return m }),
  update: (input: any) => call("memory.update", input, () => { const m = memories.find(m => m.id === input.memoryID)!; if (input.expectedVersion !== undefined && input.expectedVersion !== m.version) throw new Error("409 Memory revision conflict"); Object.assign(m, input, { version: m.version + 1 }); return m }),
  get: (input: any) => call("memory.get", input, () => memories.find(m => m.id === input.memoryID)),
  correct: (input: any) => call("memory.correct", input, () => { const m = memories.find(m => m.id === input.memoryID)!; if (input.expectedUpdatedAt !== m.time.updated) throw new Error("409 Correction source changed");
    const previous = structuredClone(m); Object.assign(m, { content: input.content, source: "user-corrected", time: { ...m.time, updated: 300 } });
    history.push({ id: "correction_1", memoryID: m.id, successorMemoryID: m.id, reason: input.reason, status: "active", previous }); return m }),
  correctionHistory: (input: unknown) => call("memory.history", input, () => ({ items: history, count: history.length })),
  undoCorrection: (input: any) => call("memory.undo", input, () => { const h = history.find(h => h.id === input.correctionID)!; const m = memories.find(m => m.id === h.successorMemoryID)!;
    if (input.expectedSuccessorUpdatedAt !== m.time.updated) throw new Error("409 Successor changed"); Object.assign(m, h.previous); h.status = "undone"; return h }),
  resolveConflict: (input: any) => call("memory.resolve", input, () => { if (input.expectedLeftUpdatedAt !== memories[0].time.updated || input.expectedRightUpdatedAt !== memories[1].time.updated) throw new Error("409 Conflict side changed");
    Object.assign(conflict, { status: "resolved", chosenMemoryID: input.chosenMemoryID, reason: input.reason }); return conflict }),
  dismissConflict: (input: any) => call("memory.dismiss", input, () => { Object.assign(conflict, { status: "dismissed", reason: input.reason }); return conflict }),
  undoConflict: (input: unknown) => call("memory.undoConflict", input, () => { conflict.status = "undone"; return conflict }),
  governancePreview: (input: unknown) => call("memory.preview", input, () => ({ candidateCount: 0, scanned: memories.length, candidates: [] })),
}
export const api = {
  memories: memoryMethods,
  learning: { status: (input: unknown) => call("learning.status", input, () => ({ totalTurns: 0, successRate: 0, patternCount: 0, recent: [], impact: { caveat: "No real learning execution." } })) },
  feedback: { list: (input: unknown) => call("feedback.list", input, () => ({ items: [], count: 0 })), summary: (input: unknown) => call("feedback.summary", input, () => ({ total: 0, averageRating: null })) },
  agentCapabilities: {
    evolutionCreate: (input: any) => call("evolution.create", input, () => { const c=candidate("proposed", 9);Object.assign(c,{title:input.title,target:input.target,instruction:input.instruction,rationale:input.rationale,evidence_refs:input.evidenceRefs});candidates.push(c);return envelope(c) }),
    evolutionStatus: (input: unknown) => call("evolution.status", input, () => envelope({ total: candidates.length, active: 2, counts: {}, constitution: { version: "fixture-v1" },
      audit: { valid: auditValid, events: 0, issue: auditValid ? "" : "Fixture audit segment missing" }, policy: { min_auto_proposal_frequency: 2, min_auto_proposal_confidence: .8 } })),
    evolutionCandidates: (input: unknown) => call("evolution.candidates", input, () => envelope({ items: candidates, count: candidates.length })),
    evolutionOpportunities: (input: unknown) => call("evolution.opportunities", input, () => envelope({ items: [], count: 0 })),
    evolutionExposures: (input: unknown) => call("evolution.exposures", input, () => envelope({ items: [], count: 0, total: 0, counts: { pending: 0, recorded: 0 }, truncated: false })),
    evolutionAuditEvents: (input: unknown) => call("evolution.audit", input, () => envelope({ items: [], count: 0, total: 0, valid: auditValid, truncated: false })),
    evolutionExposureArchives: (input: unknown) => call("evolution.archives", input, () => envelope({ items: [], count: 0 })),
    evolutionTransition: (input: any) => call("evolution.transition", input, () => { const c = candidates.find(c => c.candidate_id === input.candidateID); if (!auditValid || input.expectedRevision !== c.state.revision) throw new Error("409 Evolution audit/revision conflict");
      c.state = { ...c.state, revision: c.state.revision + 1, status: ({ evaluate: "evaluated", approve: "approved", startCanary: "canary", promote: "promoted", rollback: "rolled_back", reject: "rejected" } as Record<string,string>)[input.action] };
      if (input.action === "evaluate") c.evaluation = evaluation(c.candidate_id, false); return envelope(c) }),
    evolutionCanaryReport: (input: unknown) => call("evolution.canary", input, () => envelope({ gate_passed: false, checks: { minimum_observations: false }, candidate_observations: 0, candidate_success_rate: 0, control_observations: 0, control_success_rate: 0, success_rate_delta: 0 })),
    evolutionContextPreview: (input: unknown) => call("evolution.preview", input, () => envelope({ overlays: [], executed: false })),
  },
} as unknown as OperationsApi
export const fixture = { calls, fail: (name: string) => failures.add(name), snapshot: () => ({ calls, memories, conflict, history, candidates, directory: state.directory, unusedFaults: [...failures] }),
  scope: () => setState("directory", "C:/Isolated/Lifecycle/B"), audit: (valid: boolean) => { auditValid = valid } }
