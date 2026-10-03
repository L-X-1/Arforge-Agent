import type * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"
import type * as MemoryClass from "@arforge-ai/schema/memory-class"
import type { Memory } from "@arforge-ai/schema/memory"

type SerializedTime = number | string

export type MemoryCandidateReviewDto = {
  readonly candidateID: string
  readonly proposedClass: MemoryClass.MemoryClass
  readonly content?: string
  readonly contentRedacted: boolean
  readonly sourceEvidenceIDs: ReadonlyArray<string>
  readonly scope: Memory.Scope
  readonly sensitivity: MemoryCandidate.Sensitivity
  readonly confidence: number
  readonly dedup: {
    readonly status: MemoryCandidate.DedupStatus
    readonly comparedMemoryIDs: ReadonlyArray<string>
    readonly similarity?: number
  }
  readonly retention: {
    readonly mode: MemoryCandidate.RetentionMode
    readonly expiresAt?: SerializedTime
    readonly reason: string
  }
  readonly proposer: {
    readonly kind: "user" | "agent" | "system"
    readonly principalRef?: string
    readonly runID?: string
  }
  readonly policy: {
    readonly status: "pending" | "allow" | "deny" | "review"
    readonly policyVersion: string
    readonly reason: string
  }
  readonly status: MemoryCandidate.Status
  readonly reason: string
  readonly time: {
    readonly created: SerializedTime
    readonly updated: SerializedTime
    readonly expires?: SerializedTime
  }
  readonly approvalAllowed: boolean
  readonly activationAllowed: boolean
  readonly blockedReasons: ReadonlyArray<MemoryCandidate.ReviewBlockCode>
  readonly audit: ReadonlyArray<{
    readonly auditID: string
    readonly operation: MemoryCandidate.ReviewOperation
    readonly actorKind: "user" | "agent" | "system" | "maintenance" | "recovery"
    readonly reason: string
    readonly policyVersion: string
    readonly statusFrom?: MemoryCandidate.Status
    readonly statusTo: MemoryCandidate.Status
    readonly createdAt: SerializedTime
  }>
}

type LocationInput = { readonly directory: string; readonly workspace?: string }
type DecisionInput = LocationInput & {
  readonly candidateID: string
  readonly expectedUpdatedAt: number
  readonly reason: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isMemoryCandidateReviewDto = (value: unknown): value is MemoryCandidateReviewDto => {
  if (!isRecord(value) || !isRecord(value.time) || !isRecord(value.policy) || !isRecord(value.dedup)) return false
  return (
    typeof value.candidateID === "string" &&
    typeof value.contentRedacted === "boolean" &&
    typeof value.status === "string" &&
    typeof value.sensitivity === "string" &&
    typeof value.policy.status === "string" &&
    typeof value.dedup.status === "string" &&
    (typeof value.time.updated === "number" || typeof value.time.updated === "string") &&
    typeof value.approvalAllowed === "boolean" &&
    typeof value.activationAllowed === "boolean" &&
    Array.isArray(value.sourceEvidenceIDs) &&
    Array.isArray(value.blockedReasons) &&
    Array.isArray(value.audit)
  )
}

const errorMessage = (body: unknown, status: number) => {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message
  const nested = body && typeof body === "object" && "data" in body ? body.data : undefined
  if (nested && typeof nested === "object" && "message" in nested && typeof nested.message === "string")
    return nested.message
  return `Memory Candidate request failed (${status})`
}

export const serializedTimeMillis = (value: SerializedTime) => {
  if (typeof value === "number") return value
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) throw new Error("Memory Candidate returned an invalid update time.")
  return parsed
}

export const createMemoryCandidateReviewApi = (input: {
  readonly baseUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
}) => {
  const request = async (
    operation: "review" | "approve" | "reject" | "activate",
    value: LocationInput & {
      readonly candidateID: string
      readonly expectedUpdatedAt?: number
      readonly reason?: string
    },
  ) => {
    const suffix = operation === "review" ? "" : `/${operation}`
    const url = new URL(`/api/memory/candidates/${encodeURIComponent(value.candidateID)}${suffix}`, input.baseUrl)
    url.searchParams.set("location[directory]", value.directory)
    if (value.workspace) url.searchParams.set("location[workspace]", value.workspace)
    const response = await input.fetch(url, {
      method: operation === "review" ? "GET" : "POST",
      headers: operation === "review" ? { ...input.headers } : { "Content-Type": "application/json", ...input.headers },
      ...(operation === "review"
        ? {}
        : { body: JSON.stringify({ expectedUpdatedAt: value.expectedUpdatedAt, reason: value.reason }) }),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(errorMessage(body, response.status), { cause: { status: response.status } })
    if (!isRecord(body) || !isMemoryCandidateReviewDto(body.data))
      throw new Error("Memory Candidate response is invalid.")
    return body.data
  }

  return {
    review: (value: LocationInput & { readonly candidateID: string }) => request("review", value),
    approve: (value: DecisionInput) => request("approve", value),
    reject: (value: DecisionInput) => request("reject", value),
    activate: (value: DecisionInput) => request("activate", value),
  }
}
