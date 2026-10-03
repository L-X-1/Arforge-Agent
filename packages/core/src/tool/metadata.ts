/**
 * Execution metadata is deliberately separate from the model-facing tool
 * schema.  It describes how the canonical Tool Pipeline may run a tool; it
 * never changes what the model is allowed to request.
 */

export type ToolConcurrency = "exclusive" | "safe" | "keyed"
export type ToolSideEffect = "none" | "read" | "write" | "external"
export type ToolIdempotency = "idempotent" | "conditional" | "non_idempotent"
/**
 * `derived` is the safe default: the pipeline derives cancellation/timeout
 * from the parent signal and the catalog deadline. `inherited` delegates to
 * the parent without adding a tool deadline; `detached` is reserved for a
 * future durable background executor and is rejected by the current runner.
 */
export type ToolTimeoutMode = "derived" | "inherited" | "detached"
export type ToolOutputPolicy = "model" | "artifact" | "both"

export type ResourceKeyResolver<Input, Context> = (input: Input, context: Context) => string | undefined

export type ToolExecutionMetadataConfig<Input = unknown, Context = unknown> = {
  readonly concurrency?: ToolConcurrency
  readonly resourceKey?: string | ResourceKeyResolver<Input, Context>
  readonly sideEffect?: ToolSideEffect
  readonly idempotency?: ToolIdempotency
  readonly timeoutMode?: ToolTimeoutMode
  readonly outputPolicy?: ToolOutputPolicy
}

export type ResolvedToolExecutionMetadata = {
  readonly concurrency: ToolConcurrency
  readonly resourceKey?: string
  readonly sideEffect: ToolSideEffect
  readonly idempotency: ToolIdempotency
  readonly timeoutMode: ToolTimeoutMode
  readonly outputPolicy: ToolOutputPolicy
}

export class ToolMetadataError extends Error {
  override readonly name = "Tool.ToolMetadataError"
}

export const DEFAULT_TOOL_EXECUTION_METADATA: Omit<ResolvedToolExecutionMetadata, "resourceKey" | "idempotency"> =
  Object.freeze({
    // A tool is never parallel until it declares and passes a keyed/safe
    // classification. This protects old and third-party tools by default.
    concurrency: "exclusive" as const,
    sideEffect: "write" as const,
    timeoutMode: "derived" as const,
    // Preserve the current bounded output behaviour until ArtifactRef is the
    // model-visible contract: small output is returned to the model and
    // oversized output is also retained by ToolOutputStore.
    outputPolicy: "both" as const,
  })

const concurrencyValues: ReadonlyArray<ToolConcurrency> = ["exclusive", "safe", "keyed"]
const sideEffectValues: ReadonlyArray<ToolSideEffect> = ["none", "read", "write", "external"]
const idempotencyValues: ReadonlyArray<ToolIdempotency> = ["idempotent", "conditional", "non_idempotent"]
const timeoutModeValues: ReadonlyArray<ToolTimeoutMode> = ["derived", "inherited", "detached"]
const outputPolicyValues: ReadonlyArray<ToolOutputPolicy> = ["model", "artifact", "both"]

const assertValue = <T extends string>(field: string, value: T | undefined, values: ReadonlyArray<T>) => {
  if (value !== undefined && !values.includes(value))
    throw new ToolMetadataError(`Invalid ${field} metadata value: ${String(value)}`)
}

/** Resource keys participate in scheduling and therefore must be stable, bounded and printable. */
export const validateResourceKey = (value: string): string => {
  const key = value.trim()
  if (key.length === 0) throw new ToolMetadataError("A resourceKey must not be empty")
  if (key.length > 512) throw new ToolMetadataError("A resourceKey must be at most 512 characters")
  if ([...key].some((character) => character < " " || character === "\u007f"))
    throw new ToolMetadataError("A resourceKey must not contain control characters")
  return key
}

export function validateToolExecutionMetadata<Input, Context>(
  metadata: ToolExecutionMetadataConfig<Input, Context> | undefined,
): void {
  if (!metadata) return
  assertValue("concurrency", metadata.concurrency, concurrencyValues)
  assertValue("sideEffect", metadata.sideEffect, sideEffectValues)
  assertValue("idempotency", metadata.idempotency, idempotencyValues)
  assertValue("timeoutMode", metadata.timeoutMode, timeoutModeValues)
  assertValue("outputPolicy", metadata.outputPolicy, outputPolicyValues)
  if (metadata.concurrency === "keyed" && metadata.resourceKey === undefined)
    throw new ToolMetadataError("keyed concurrency requires a static or dynamic resourceKey")
  if (typeof metadata.resourceKey === "string") {
    const normalized = validateResourceKey(metadata.resourceKey)
    if (normalized !== metadata.resourceKey)
      throw new ToolMetadataError("A static resourceKey must already be trimmed and canonical")
  }
}

const sideEffectFor = (semantics?: {
  readonly riskTier: "L0" | "L1" | "L2" | "L3" | "L4"
  readonly networkScope: ReadonlyArray<string>
  readonly secretScope: ReadonlyArray<string>
  readonly externalServices: ReadonlyArray<string>
}) => {
  if (!semantics) return DEFAULT_TOOL_EXECUTION_METADATA.sideEffect
  if (semantics.networkScope.length > 0 || semantics.secretScope.length > 0 || semantics.externalServices.length > 0)
    return "external" as const
  if (semantics.riskTier === "L0") return "read" as const
  return "write" as const
}

/**
 * Resolve the runtime metadata after input decoding. A dynamic resource key
 * is evaluated exactly once, before ActionGateway receives the intent. Any
 * malformed value or resolver exception fails closed at preflight.
 */
export function resolveToolExecutionMetadata<Input, Context>(
  metadata: ToolExecutionMetadataConfig<Input, Context> | undefined,
  input: Input,
  context: Context,
  semantics?: {
    readonly riskTier: "L0" | "L1" | "L2" | "L3" | "L4"
    readonly idempotency: ToolIdempotency
    readonly networkScope: ReadonlyArray<string>
    readonly secretScope: ReadonlyArray<string>
    readonly externalServices: ReadonlyArray<string>
  },
): ResolvedToolExecutionMetadata {
  validateToolExecutionMetadata(metadata)
  let resourceKey: string | undefined
  try {
    const candidate = typeof metadata?.resourceKey === "function" ? metadata.resourceKey(input, context) : metadata?.resourceKey
    if (candidate !== undefined) resourceKey = validateResourceKey(candidate)
  } catch (error) {
    if (error instanceof ToolMetadataError) throw error
    throw new ToolMetadataError(`The resourceKey resolver failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const concurrency = metadata?.concurrency ?? DEFAULT_TOOL_EXECUTION_METADATA.concurrency
  if (concurrency === "keyed" && resourceKey === undefined)
    throw new ToolMetadataError("keyed concurrency requires the resourceKey resolver to return a key")
  if (metadata?.idempotency !== undefined && semantics && metadata.idempotency !== semantics.idempotency)
    throw new ToolMetadataError(
      `idempotency metadata (${metadata.idempotency}) does not match effect semantics (${semantics.idempotency})`,
    )
  return Object.freeze({
    concurrency,
    ...(resourceKey ? { resourceKey } : {}),
    sideEffect: metadata?.sideEffect ?? sideEffectFor(semantics),
    idempotency: metadata?.idempotency ?? semantics?.idempotency ?? "non_idempotent",
    timeoutMode: metadata?.timeoutMode ?? DEFAULT_TOOL_EXECUTION_METADATA.timeoutMode,
    outputPolicy: metadata?.outputPolicy ?? DEFAULT_TOOL_EXECUTION_METADATA.outputPolicy,
  })
}
