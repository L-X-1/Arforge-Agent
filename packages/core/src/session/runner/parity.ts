import type { LLMEvent as LLMEventType } from "@arforge-ai/llm"
import type {
  Assistant as LegacyAssistant,
  Part as LegacyPart,
  WithParts as LegacyWithParts,
} from "@arforge-ai/schema/session-v1"
import type { Assistant as CoreAssistant, Message as CoreMessage } from "@arforge-ai/schema/session-message"
import { canonicalHash } from "../../util/canonical-hash"

/** The result categories compared when evaluating the two session adapters. */
export type TerminalStatus = "completed" | "paused" | "failed"

/** Provider finish values reduced to the small vocabulary shared by both roots. */
export type FinishClass = "stop" | "tool-calls" | "error" | "content-filter" | "unknown"

export type ToolStatus = "pending" | "completed" | "failed" | "provider"

export type SemanticTool = Readonly<{
  readonly name: string
  readonly status: ToolStatus
}>

export type SemanticStep = Readonly<{
  readonly finish: FinishClass
  readonly hasText: boolean
  readonly hasReasoning: boolean
  readonly structured: boolean
  readonly failed: boolean
  readonly tools: ReadonlyArray<SemanticTool>
}>

export type CheckpointSummary = Readonly<{
  readonly phase: "continuation" | "idle" | "mature-session-loop"
  readonly nextStep?: number
  readonly needsContinuation: boolean
}>

export type ActionStatusCounts = Readonly<{
  readonly proposed: number
  readonly authorized: number
  readonly executing: number
  readonly observed: number
  readonly settled: number
  readonly failed: number
  readonly outcomeUnknown: number
}>

export interface SemanticExecutionTrace {
  readonly schemaVersion: 1
  /** Identifies the producer for evidence; it is deliberately ignored by compare(). */
  readonly adapter: "formal-runner" | "mature-prompt" | "provider-replay"
  readonly terminalStatus: TerminalStatus
  readonly steps: ReadonlyArray<SemanticStep>
  readonly requestCount: number
  readonly transportRetryCount: number
  readonly compactionCount: number
  readonly actionStatusCounts: ActionStatusCounts
  readonly checkpoint?: CheckpointSummary
  /** Digest of the metadata-only semantic projection; no prompt/tool payload is included. */
  readonly traceDigest: string
}

export type TraceMetadata = Readonly<{
  readonly terminalStatus: TerminalStatus
  readonly adapter: SemanticExecutionTrace["adapter"]
  readonly requestCount?: number
  readonly transportRetryCount?: number
  readonly compactionCount?: number
  readonly actionStatusCounts?: Partial<ActionStatusCounts>
  readonly checkpoint?: CheckpointSummary
}>

export type ParityComparison = Readonly<{
  readonly equivalent: boolean
  readonly differences: ReadonlyArray<string>
  readonly baselineDigest: string
  readonly candidateDigest: string
}>

const emptyActionStatusCounts = (): ActionStatusCounts => ({
  proposed: 0,
  authorized: 0,
  executing: 0,
  observed: 0,
  settled: 0,
  failed: 0,
  outcomeUnknown: 0,
})

const nonNegativeInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`)
  return value
}

const finishClass = (value: string | undefined, hasTools: boolean, failed: boolean): FinishClass => {
  if (failed) return "error"
  switch (value) {
    case "stop":
      return "stop"
    case "tool-calls":
    case "tool_calls":
      return "tool-calls"
    case "content-filter":
    case "content_filter":
      return "content-filter"
    case "error":
      return "error"
    case undefined:
      return hasTools ? "tool-calls" : "unknown"
    default:
      return "unknown"
  }
}

const toolStatus = (status: string, providerExecuted: boolean): ToolStatus => {
  if (providerExecuted) return "provider"
  if (status === "completed") return "completed"
  if (status === "error") return "failed"
  return "pending"
}

const normalizeTool = (name: string, status: ToolStatus): SemanticTool => {
  if (!name || name.length > 256) throw new Error("tool name must be a bounded non-empty string")
  return { name, status }
}

const normalizeStep = (step: SemanticStep): SemanticStep => ({
  finish: step.finish,
  hasText: step.hasText,
  hasReasoning: step.hasReasoning,
  structured: step.structured,
  failed: step.failed,
  tools: step.tools.map((tool) => normalizeTool(tool.name, tool.status)),
})

const traceCore = (trace: Omit<SemanticExecutionTrace, "traceDigest">) => {
  const digest = canonicalHash({
    schemaVersion: trace.schemaVersion,
    terminalStatus: trace.terminalStatus,
    steps: trace.steps,
    requestCount: trace.requestCount,
    transportRetryCount: trace.transportRetryCount,
    compactionCount: trace.compactionCount,
    actionStatusCounts: trace.actionStatusCounts,
    checkpoint: trace.checkpoint,
  })
  if (!digest) throw new Error("semantic execution trace is not canonicalizable")
  return Object.freeze({ ...trace, traceDigest: digest })
}

/** Build a validated metadata-only trace shared by both execution roots. */
export const make = (
  input: TraceMetadata & { readonly steps: ReadonlyArray<SemanticStep> },
): SemanticExecutionTrace => {
  const steps = input.steps.map(normalizeStep)
  const requestCount = nonNegativeInteger(input.requestCount ?? 0, "requestCount")
  const transportRetryCount = nonNegativeInteger(input.transportRetryCount ?? 0, "transportRetryCount")
  const compactionCount = nonNegativeInteger(input.compactionCount ?? 0, "compactionCount")
  const actionStatusCounts = {
    ...emptyActionStatusCounts(),
    ...(input.actionStatusCounts ?? {}),
  }
  for (const [key, value] of Object.entries(actionStatusCounts)) nonNegativeInteger(value, `actionStatusCounts.${key}`)
  if (input.checkpoint) {
    if (!Number.isSafeInteger(input.checkpoint.nextStep) && input.checkpoint.nextStep !== undefined)
      throw new Error("checkpoint nextStep must be a positive safe integer")
    if (input.checkpoint.nextStep !== undefined && input.checkpoint.nextStep < 1)
      throw new Error("checkpoint nextStep must be a positive safe integer")
  }
  return traceCore({
    schemaVersion: 1,
    adapter: input.adapter,
    terminalStatus: input.terminalStatus,
    steps,
    requestCount,
    transportRetryCount,
    compactionCount,
    actionStatusCounts,
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
  })
}

const coreStep = (assistant: CoreAssistant): SemanticStep => {
  const tools = assistant.content
    .filter((part) => part.type === "tool")
    .map((part) => normalizeTool(part.name, toolStatus(part.state.status, part.provider?.executed === true)))
  const failed =
    assistant.error !== undefined || assistant.finish === "error" || tools.some((tool) => tool.status === "failed")
  return {
    finish: finishClass(assistant.finish, tools.length > 0, failed),
    hasText: assistant.content.some((part) => part.type === "text" && part.text.length > 0),
    hasReasoning: assistant.content.some((part) => part.type === "reasoning" && part.text.length > 0),
    structured: assistant.structured !== undefined,
    failed,
    tools,
  }
}

const legacyStep = (assistant: LegacyAssistant, parts: ReadonlyArray<LegacyPart>): SemanticStep => {
  const tools = parts
    .filter((part): part is Extract<LegacyPart, { type: "tool" }> => part.type === "tool")
    .map((part) => normalizeTool(part.tool, toolStatus(part.state.status, part.metadata?.providerExecuted === true)))
  const failed =
    assistant.error !== undefined || assistant.finish === "error" || tools.some((tool) => tool.status === "failed")
  return {
    finish: finishClass(assistant.finish, tools.length > 0, failed),
    hasText: parts.some((part) => part.type === "text" && part.text.length > 0),
    hasReasoning: parts.some((part) => part.type === "reasoning" && part.text.length > 0),
    structured: assistant.structured !== undefined,
    failed,
    tools,
  }
}

/** Project V2 projected messages into the same semantic shape used by mature Prompt. */
export const fromCoreMessages = (
  messages: ReadonlyArray<CoreMessage>,
  metadata: Omit<TraceMetadata, "adapter"> & { readonly adapter?: "formal-runner" },
): SemanticExecutionTrace =>
  make({
    ...metadata,
    adapter: metadata.adapter ?? "formal-runner",
    steps: messages.filter((message): message is CoreAssistant => message.type === "assistant").map(coreStep),
  })

/** Project mature V1 messages into the shared semantic shape without retaining content. */
export const fromMatureMessages = (
  messages: ReadonlyArray<LegacyWithParts>,
  metadata: Omit<TraceMetadata, "adapter"> & { readonly adapter?: "mature-prompt" },
): SemanticExecutionTrace =>
  make({
    ...metadata,
    adapter: metadata.adapter ?? "mature-prompt",
    steps: messages
      .filter(
        (message): message is LegacyWithParts & { info: LegacyAssistant } =>
          message.info.role === "assistant" && message.info.summary !== true,
      )
      .map((message) => legacyStep(message.info, message.parts)),
  })

type MutableTool = { readonly name: string; status: ToolStatus }
type MutableStep = {
  readonly index: number
  hasText: boolean
  hasReasoning: boolean
  structured: boolean
  failed: boolean
  finish?: string
  readonly tools: Map<string, MutableTool>
}

/**
 * Project provider-neutral recorded events into the same metadata-only step
 * shape. The event source may be the replay baseline or either execution
 * owner; the adapter label is evidence metadata and is intentionally excluded
 * from the semantic trace digest.
 */
export const fromProviderEvents = (
  events: ReadonlyArray<LLMEventType>,
  metadata: Omit<TraceMetadata, "adapter"> & { readonly adapter?: SemanticExecutionTrace["adapter"] },
): SemanticExecutionTrace => {
  const steps = new Map<number, MutableStep>()
  let current = 0
  const getStep = (index: number) => {
    const existing = steps.get(index)
    if (existing) return existing
    const created: MutableStep = {
      index,
      hasText: false,
      hasReasoning: false,
      structured: false,
      failed: false,
      tools: new Map(),
    }
    steps.set(index, created)
    return created
  }
  const getCurrent = () => getStep(current)
  for (const event of events) {
    switch (event.type) {
      case "step-start":
        current = event.index
        getCurrent()
        break
      case "text-delta":
        getCurrent().hasText = true
        break
      case "reasoning-delta":
        getCurrent().hasReasoning = true
        break
      case "tool-input-start":
      case "tool-input-delta":
      case "tool-input-end":
        getCurrent().tools.set(String(event.id), { name: event.name, status: "pending" })
        break
      case "tool-call":
        getCurrent().tools.set(String(event.id), {
          name: event.name,
          status: event.providerExecuted === true ? "provider" : "pending",
        })
        if (event.name === "StructuredOutput") getCurrent().structured = false
        break
      case "tool-result":
        {
          const failedResult = event.result.type === "error"
          const status = failedResult ? "failed" : event.providerExecuted === true ? "provider" : "completed"
          getCurrent().tools.set(String(event.id), {
            name: event.name,
            status,
          })
          if (event.name === "StructuredOutput") getCurrent().structured = !failedResult
          if (failedResult) getCurrent().failed = true
        }
        break
      case "tool-error":
        getCurrent().tools.set(String(event.id), { name: event.name, status: "failed" })
        if (event.name === "StructuredOutput") getCurrent().structured = false
        getCurrent().failed = true
        break
      case "provider-error":
        getCurrent().failed = true
        getCurrent().finish = "error"
        break
      case "step-finish":
        current = event.index
        getCurrent().finish = String(event.reason)
        break
      case "finish":
        getCurrent().finish = String(event.reason)
        break
      default:
        break
    }
  }
  const projected = [...steps.values()]
    .sort((left, right) => left.index - right.index)
    .map((step) => {
      const tools = [...step.tools.values()].map((tool) => normalizeTool(tool.name, tool.status))
      // Providers report a successful tool submission as `tool-calls`, while
      // both execution roots deliberately project one schema-valid,
      // standalone StructuredOutput call as the user's terminal `stop`.
      // Normalize that protocol detail here so the parity trace compares the
      // semantic outcome, without treating ordinary tools as terminal.
      const structuredFinal =
        step.structured &&
        !step.failed &&
        tools.length === 1 &&
        tools[0]?.name === "StructuredOutput" &&
        tools[0].status === "completed"
      return {
        finish: structuredFinal ? ("stop" as const) : finishClass(step.finish, tools.length > 0, step.failed),
        hasText: step.hasText,
        hasReasoning: step.hasReasoning,
        structured: step.structured,
        failed: step.failed,
        tools,
      }
    })
  return make({
    ...metadata,
    adapter: metadata.adapter ?? "provider-replay",
    steps: projected,
  })
}

const comparable = (trace: SemanticExecutionTrace) => ({
  terminalStatus: trace.terminalStatus,
  steps: trace.steps,
  requestCount: trace.requestCount,
  transportRetryCount: trace.transportRetryCount,
  compactionCount: trace.compactionCount,
  actionStatusCounts: trace.actionStatusCounts,
  checkpoint: trace.checkpoint,
})

/** Compare semantic behavior while intentionally ignoring adapter-specific IDs and content. */
export const compare = (baseline: SemanticExecutionTrace, candidate: SemanticExecutionTrace): ParityComparison => {
  const differences: string[] = []
  const left = comparable(baseline)
  const right = comparable(candidate)
  const compareField = (field: string, a: unknown, b: unknown) => {
    if (canonicalHash(a) !== canonicalHash(b)) differences.push(field)
  }
  compareField("terminalStatus", left.terminalStatus, right.terminalStatus)
  compareField("steps", left.steps, right.steps)
  compareField("requestCount", left.requestCount, right.requestCount)
  compareField("transportRetryCount", left.transportRetryCount, right.transportRetryCount)
  compareField("compactionCount", left.compactionCount, right.compactionCount)
  compareField("actionStatusCounts", left.actionStatusCounts, right.actionStatusCounts)
  compareField("checkpoint", left.checkpoint, right.checkpoint)
  return {
    equivalent: differences.length === 0,
    differences,
    baselineDigest: baseline.traceDigest,
    candidateDigest: candidate.traceDigest,
  }
}

/** A stable digest for a trace when embedding parity evidence in a test/report. */
export const digest = (trace: SemanticExecutionTrace): string => trace.traceDigest
