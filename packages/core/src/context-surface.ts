export * as ContextSurface from "./context-surface"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { NonNegativeInt, optional } from "@arforge-ai/schema/schema"
import { ContextBudget } from "./context-budget"

/** A provider-visible node with an immutable reference to the source log. */
export type SurfaceNode = Readonly<{
  readonly id: string
  readonly sourceSeq: number
  readonly role: "system" | "user" | "assistant" | "tool-call" | "tool-response" | "context"
  readonly text: string
  /** Tool call/result nodes with the same pair ID form one atomic group. */
  readonly pairID?: string
}>

export type SurfaceGroup = Readonly<{
  readonly nodes: ReadonlyArray<SurfaceNode>
  readonly sourceSeqStart: number
  readonly sourceSeqEnd: number
  readonly atomic: boolean
}>

export type SurfaceVersion = Readonly<{
  readonly version: 1
  readonly epoch: number
  readonly generation: number
  readonly sourceHeadSeq: number
  readonly nodes: ReadonlyArray<SurfaceNode>
  readonly tokenCount: number
  /** Accounting basis used for every node in this immutable projection. */
  readonly tokenizerMethod: ContextBudget.TokenCount["method"]
  /** Provider tokenizer revision, when a provider counter was supplied. */
  readonly tokenizerRevision?: string
  readonly digest: string
}>

export class ContextSurfaceError extends Error {
  override readonly name: string = "Context.ContextSurfaceError"
}

export class SurfaceConflictError extends ContextSurfaceError {
  override readonly name = "Context.SurfaceConflictError"
}

const cleanNode = (node: SurfaceNode): SurfaceNode => {
  if (!node.id.trim()) throw new ContextSurfaceError("A surface node id is required")
  if (!Number.isSafeInteger(node.sourceSeq) || node.sourceSeq < 0)
    throw new ContextSurfaceError("A surface node sourceSeq must be a non-negative integer")
  if (node.pairID !== undefined && !node.pairID.trim()) throw new ContextSurfaceError("A pairID must not be empty")
  return Object.freeze({ ...node })
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

const digestOf = (value: Omit<SurfaceVersion, "digest">): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex")

const validateNodes = (input: ReadonlyArray<SurfaceNode>): ReadonlyArray<SurfaceNode> => {
  const nodes = input.map(cleanNode)
  const ids = new Set<string>()
  let previousSeq = -1
  for (const node of nodes) {
    if (ids.has(node.id)) throw new ContextSurfaceError(`Duplicate surface node id: ${node.id}`)
    ids.add(node.id)
    if (node.sourceSeq <= previousSeq)
      throw new ContextSurfaceError("Surface sourceSeq values must be strictly increasing")
    previousSeq = node.sourceSeq
    if ((node.role === "tool-call" || node.role === "tool-response") && node.pairID === undefined)
      throw new ContextSurfaceError("Tool call/result nodes require a pairID")
  }
  return Object.freeze(nodes)
}

/** Group adjacent tool call/result nodes without ever joining unrelated pairs. */
export const group = (nodes: ReadonlyArray<SurfaceNode>): ReadonlyArray<SurfaceGroup> => {
  const groups: Array<SurfaceNode[]> = []
  for (const node of nodes) {
    const previous = groups.at(-1)
    if (previous && node.pairID !== undefined && previous[0]?.pairID === node.pairID) previous.push(node)
    else groups.push([node])
  }
  return Object.freeze(
    groups.map((nodes) =>
      Object.freeze({
        nodes: Object.freeze([...nodes]),
        sourceSeqStart: nodes[0]!.sourceSeq,
        sourceSeqEnd: nodes.at(-1)!.sourceSeq,
        atomic:
          nodes[0]!.pairID !== undefined &&
          nodes.length === 2 &&
          nodes[0]!.role === "tool-call" &&
          nodes[1]!.role === "tool-response",
      }),
    ),
  )
}

export const make = (input: {
  readonly nodes: ReadonlyArray<SurfaceNode>
  readonly epoch?: number
  readonly generation?: number
  readonly tokenizer?: ContextBudget.Tokenizer
}): SurfaceVersion => {
  const nodes = validateNodes(input.nodes)
  const counts = nodes.map((node) => ContextBudget.count(node.text, input.tokenizer))
  const tokenCount = counts.reduce((total, count) => total + count.tokens, 0)
  const firstMethod = counts[0]?.method
  const tokenizerMethod =
    firstMethod !== undefined && counts.every((count) => count.method === firstMethod)
      ? firstMethod
      : ("estimator" as const)
  const body: Omit<SurfaceVersion, "digest"> = {
    version: 1,
    epoch: input.epoch ?? 0,
    generation: input.generation ?? 0,
    sourceHeadSeq: nodes.at(-1)?.sourceSeq ?? 0,
    nodes,
    tokenCount,
    tokenizerMethod,
    ...(input.tokenizer?.revision === undefined ? {} : { tokenizerRevision: input.tokenizer.revision }),
  }
  return Object.freeze({ ...body, digest: digestOf(body) })
}

export const verify = (surface: SurfaceVersion): SurfaceVersion => {
  const { digest, ...body } = surface
  if (digestOf(body) !== digest) throw new ContextSurfaceError("Context Surface digest mismatch")
  if (surface.version !== 1) throw new ContextSurfaceError("Unsupported Context Surface version")
  if (!Number.isSafeInteger(surface.epoch) || surface.epoch < 0)
    throw new ContextSurfaceError("Context Surface epoch must be a non-negative integer")
  if (!Number.isSafeInteger(surface.generation) || surface.generation < 0)
    throw new ContextSurfaceError("Context Surface generation must be a non-negative integer")
  if (!Number.isSafeInteger(surface.tokenCount) || surface.tokenCount < 0)
    throw new ContextSurfaceError("Context Surface tokenCount must be a non-negative integer")
  if (
    surface.tokenizerMethod !== "provider-tokenizer" &&
    surface.tokenizerMethod !== "upper-bound" &&
    surface.tokenizerMethod !== "estimator"
  )
    throw new ContextSurfaceError("Context Surface tokenizerMethod is invalid")
  if (surface.tokenizerRevision !== undefined && !surface.tokenizerRevision.trim())
    throw new ContextSurfaceError("Context Surface tokenizerRevision must not be empty")
  validateNodes(surface.nodes)
  if (surface.sourceHeadSeq !== (surface.nodes.at(-1)?.sourceSeq ?? 0))
    throw new ContextSurfaceError("Context Surface sourceHeadSeq does not match the visible tail")
  return surface
}

export type SurfaceStoreSnapshot = Readonly<{
  readonly sourceLog: ReadonlyArray<SurfaceNode>
  readonly visible: SurfaceVersion
}>

/**
 * Small CAS store for the provider-visible surface. `sourceLog` is never
 * replaced by compaction; only the visible projection pointer changes.
 */
export class SurfaceStore {
  private source: ReadonlyArray<SurfaceNode>
  private current: SurfaceVersion
  private readonly tokenizer?: ContextBudget.Tokenizer

  constructor(
    nodes: ReadonlyArray<SurfaceNode>,
    options?: { readonly epoch?: number; readonly tokenizer?: ContextBudget.Tokenizer },
  ) {
    this.source = validateNodes(nodes)
    this.tokenizer = options?.tokenizer
    this.current = make({ nodes: this.source, epoch: options?.epoch, tokenizer: this.tokenizer })
  }

  /** The tokenizer is fixed for a store so every append/compaction uses one accounting basis. */
  getTokenizer(): ContextBudget.Tokenizer | undefined {
    return this.tokenizer
  }

  snapshot(): SurfaceStoreSnapshot {
    return Object.freeze({ sourceLog: this.source, visible: this.current })
  }

  /** Append only new source events; a concurrent append invalidates a prepared compaction CAS. */
  append(nodes: ReadonlyArray<SurfaceNode>): SurfaceVersion {
    const incoming = validateNodes(nodes)
    const last = this.source.at(-1)?.sourceSeq ?? -1
    if (incoming.some((node) => node.sourceSeq <= last))
      throw new ContextSurfaceError("Appended surface sourceSeq values must advance the source log")
    const knownIDs = new Set(this.source.map((node) => node.id))
    if (incoming.some((node) => knownIDs.has(node.id)))
      throw new ContextSurfaceError("Appended surface node ids must be unique across the source log")
    this.source = Object.freeze([...this.source, ...incoming])
    this.current = make({
      nodes: [...this.current.nodes, ...incoming],
      epoch: this.current.epoch,
      generation: this.current.generation,
      tokenizer: this.tokenizer,
    })
    return this.current
  }

  compareAndCommit(expectedDigest: string, next: SurfaceVersion): SurfaceVersion {
    verify(next)
    if (this.current.digest !== expectedDigest)
      throw new SurfaceConflictError("The provider-visible surface changed while compaction was running")
    if (next.epoch !== this.current.epoch || next.generation !== this.current.generation + 1)
      throw new SurfaceConflictError("A compacted surface must advance exactly one generation in the same epoch")
    if (next.sourceHeadSeq > (this.source.at(-1)?.sourceSeq ?? 0))
      throw new SurfaceConflictError("A compacted surface references source events that are not in the source log")
    const sourceSeqs = new Set(this.source.map((node) => node.sourceSeq))
    if (next.nodes.some((node) => !sourceSeqs.has(node.sourceSeq)))
      throw new SurfaceConflictError("A compacted surface references an unknown source event")
    this.current = next
    return next
  }
}

export type CompactionTransactionPhase = "prepared" | "summarized" | "revalidated" | "committed" | "closed" | "aborted"

export type TransactionalCompactionResult = Readonly<{
  readonly status: "committed" | "noop" | "aborted"
  readonly phase: CompactionTransactionPhase
  readonly reason: "compacted" | "not-smaller" | "empty-head" | "stale-surface" | "summary-failed"
  readonly base: SurfaceVersion
  readonly candidate?: SurfaceVersion
  readonly removedSourceSeq: ReadonlyArray<number>
}>

const summaryText = (anchors: ContextBudget.CompactionAnchors, generated: string): string =>
  [
    "## Objective",
    anchors.objective,
    "## Policy",
    anchors.policy,
    "## Protected Facts",
    anchors.protectedFacts.length === 0 ? "(none)" : anchors.protectedFacts.map((fact) => `- ${fact}`).join("\n"),
    "## Derived Summary",
    generated,
  ].join("\n")

type CompactionSelection = Readonly<{
  readonly head: ReadonlyArray<SurfaceNode>
  readonly retained: ReadonlyArray<SurfaceNode>
}>

const selectCompactionGroups = (
  base: SurfaceVersion,
  recentTokenBudget: number,
  tokenizer: ContextBudget.Tokenizer | undefined,
): CompactionSelection | undefined => {
  const groups = group(base.nodes)
  let recentTokens = 0
  let split = groups.length
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const next =
      recentTokens +
      groups[index]!.nodes.reduce((sum, node) => sum + ContextBudget.count(node.text, tokenizer).tokens, 0)
    if (next > recentTokenBudget) break
    recentTokens = next
    split = index
  }
  const head = groups.slice(0, split).flatMap((item) => item.nodes)
  if (head.length === 0) return
  return Object.freeze({
    head: Object.freeze(head),
    retained: Object.freeze(groups.slice(split).flatMap((item) => item.nodes)),
  })
}

const makeCompactionCandidate = (input: {
  readonly base: SurfaceVersion
  readonly head: ReadonlyArray<SurfaceNode>
  readonly retained: ReadonlyArray<SurfaceNode>
  readonly anchors: ContextBudget.CompactionAnchors
  readonly generated: string
  readonly tokenizer: ContextBudget.Tokenizer | undefined
  readonly renderSummary?: (generated: string) => string
}): SurfaceVersion => {
  const summaryNode: SurfaceNode = {
    id: `compaction:${input.base.epoch}:${input.base.generation + 1}:${input.base.nodes[0]!.sourceSeq}-${input.head.at(-1)!.sourceSeq}`,
    sourceSeq: input.head.at(-1)!.sourceSeq,
    role: "context",
    text: input.renderSummary?.(input.generated) ?? summaryText(input.anchors, input.generated),
  }
  return make({
    nodes: [summaryNode, ...input.retained],
    epoch: input.base.epoch,
    generation: input.base.generation + 1,
    tokenizer: input.tokenizer,
  })
}

/**
 * Prepare and commit one compaction through a versioned surface CAS. The
 * source log remains untouched, tool pairs are atomic, and a concurrent append
 * aborts before commit. `summarize` is intentionally model-agnostic so a
 * provider-backed summarizer can be supplied by the caller without becoming a
 * second context owner.
 */
export const compactTransactional = (input: {
  readonly store: SurfaceStore
  readonly recentTokenBudget: number
  readonly anchors: ContextBudget.CompactionAnchors
  readonly summarize: (input: { readonly nodes: ReadonlyArray<SurfaceNode> }) => string | undefined
}): TransactionalCompactionResult => {
  if (!Number.isSafeInteger(input.recentTokenBudget) || input.recentTokenBudget < 0)
    throw new ContextSurfaceError("recentTokenBudget must be a non-negative integer")
  const base = input.store.snapshot().visible
  const tokenizer = input.store.getTokenizer()
  const selection = selectCompactionGroups(base, input.recentTokenBudget, tokenizer)
  if (!selection)
    return Object.freeze({ status: "noop", phase: "closed", reason: "empty-head", base, removedSourceSeq: [] })
  const { head, retained } = selection
  let generated: string | undefined
  try {
    generated = input.summarize({ nodes: Object.freeze([...head]) })?.trim()
  } catch {
    return Object.freeze({ status: "aborted", phase: "aborted", reason: "summary-failed", base, removedSourceSeq: [] })
  }
  if (!generated)
    return Object.freeze({ status: "aborted", phase: "aborted", reason: "summary-failed", base, removedSourceSeq: [] })
  const candidate = makeCompactionCandidate({ base, head, retained, anchors: input.anchors, generated, tokenizer })
  if (candidate.tokenCount >= base.tokenCount)
    return Object.freeze({
      status: "noop",
      phase: "closed",
      reason: "not-smaller",
      base,
      candidate,
      removedSourceSeq: [],
    })
  try {
    const latest = input.store.snapshot().visible
    if (latest.digest !== base.digest)
      return Object.freeze({
        status: "aborted",
        phase: "aborted",
        reason: "stale-surface",
        base,
        candidate,
        removedSourceSeq: [],
      })
    input.store.compareAndCommit(base.digest, candidate)
  } catch (error) {
    if (error instanceof SurfaceConflictError)
      return Object.freeze({
        status: "aborted",
        phase: "aborted",
        reason: "stale-surface",
        base,
        candidate,
        removedSourceSeq: [],
      })
    throw error
  }
  return Object.freeze({
    status: "committed",
    phase: "closed",
    reason: "compacted",
    base,
    candidate,
    removedSourceSeq: Object.freeze(head.map((node) => node.sourceSeq)),
  })
}

export type AsyncCompactionPhase =
  | "prepared"
  | "summarizing"
  | "summarized"
  | "revalidated"
  | "committed"
  | "closed"
  | "aborted"

export type AsyncCompactionReason =
  | "compacted"
  | "not-smaller"
  | "empty-head"
  | "stale-surface"
  | "summary-failed"
  | "cancelled"

export type CompactionProviderRequest = Readonly<{
  readonly operationID: string
  readonly base: SurfaceVersion
  readonly nodes: ReadonlyArray<SurfaceNode>
  readonly anchors: ContextBudget.CompactionAnchors
  readonly recentTokenBudget: number
  readonly tokenizerMethod: ContextBudget.TokenCount["method"]
  readonly tokenizerRevision?: string
  readonly signal: AbortSignal
}>

/** Provider-neutral seam for an asynchronous summary implementation. */
export type CompactionProvider = Readonly<{
  readonly revision: string
  readonly summarize: (input: CompactionProviderRequest) => Promise<string | undefined>
}>

export type AsyncCompactionCheckpoint = Readonly<{
  readonly version: 1
  readonly operationID: string
  readonly sequence: number
  readonly phase: AsyncCompactionPhase
  readonly epoch: number
  readonly generation: number
  readonly sourceHeadSeq: number
  readonly surfaceDigest: string
  readonly providerRevision: string
  readonly candidateDigest?: string
  readonly reason?: AsyncCompactionReason
}>

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** Runtime codec for the JSON-safe evidence persisted by a compaction owner. */
export const AsyncCompactionCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  operationID: Schema.NonEmptyString,
  sequence: NonNegativeInt,
  phase: Schema.Literals(["prepared", "summarizing", "summarized", "revalidated", "committed", "closed", "aborted"]),
  epoch: NonNegativeInt,
  generation: NonNegativeInt,
  sourceHeadSeq: NonNegativeInt,
  surfaceDigest: Digest,
  providerRevision: Schema.NonEmptyString,
  candidateDigest: Digest.pipe(optional),
  reason: Schema.Literals([
    "compacted",
    "not-smaller",
    "empty-head",
    "stale-surface",
    "summary-failed",
    "cancelled",
  ]).pipe(optional),
}).annotate({ identifier: "ContextSurface.AsyncCompactionCheckpoint" })

/** Decode persisted checkpoint JSON strictly before applying chain invariants. */
export const decodeAsyncCompactionCheckpoint = Schema.decodeUnknownSync(AsyncCompactionCheckpointSchema, {
  onExcessProperty: "error",
}) as (value: unknown) => AsyncCompactionCheckpoint

export type AsyncCompactionResult = Readonly<{
  readonly status: "committed" | "noop" | "aborted"
  readonly phase: AsyncCompactionPhase
  readonly reason: AsyncCompactionReason
  readonly operationID: string
  readonly checkpoints: ReadonlyArray<AsyncCompactionCheckpoint>
  readonly base: SurfaceVersion
  readonly candidate?: SurfaceVersion
  readonly removedSourceSeq: ReadonlyArray<number>
}>

export type AsyncCompactionRecoveryStatus =
  | "not_started"
  | "in_flight"
  | "completed_unsettled"
  | "committed"
  | "noop"
  | "aborted"

export const asyncCompactionOperationID = (base: SurfaceVersion, providerRevision: string): string =>
  `surface-compaction:v1:${base.epoch}:${base.generation}:${base.digest}:${providerRevision}`

const allowedAsyncCompactionTransitions: Readonly<Record<AsyncCompactionPhase, ReadonlyArray<AsyncCompactionPhase>>> = {
  prepared: ["summarizing", "closed", "aborted"],
  summarizing: ["summarized", "aborted"],
  summarized: ["revalidated", "closed", "aborted"],
  revalidated: ["committed", "aborted"],
  committed: ["closed"],
  closed: [],
  aborted: [],
}

const verifyAsyncCompactionCheckpointChain = (
  checkpoints: ReadonlyArray<AsyncCompactionCheckpoint>,
  requireTerminal: boolean,
): ReadonlyArray<AsyncCompactionCheckpoint> => {
  if (checkpoints.length === 0) throw new ContextSurfaceError("Compaction checkpoint chain must not be empty")
  const first = checkpoints[0]!
  if (first.phase !== "prepared") throw new ContextSurfaceError("Compaction checkpoint chain must start at prepared")
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (checkpoint.version !== 1) throw new ContextSurfaceError("Unsupported compaction checkpoint version")
    if (checkpoint.sequence !== index + 1)
      throw new ContextSurfaceError("Compaction checkpoint sequence is not contiguous")
    if (
      checkpoint.operationID !== first.operationID ||
      checkpoint.epoch !== first.epoch ||
      checkpoint.generation !== first.generation ||
      checkpoint.sourceHeadSeq !== first.sourceHeadSeq ||
      checkpoint.surfaceDigest !== first.surfaceDigest ||
      checkpoint.providerRevision !== first.providerRevision
    )
      throw new ContextSurfaceError("Compaction checkpoint identity drifted")
    const next = checkpoints[index + 1]
    if (next !== undefined && !allowedAsyncCompactionTransitions[checkpoint.phase].includes(next.phase))
      throw new ContextSurfaceError("Illegal compaction checkpoint transition")
  }
  const last = checkpoints.at(-1)!
  if (requireTerminal && last.phase !== "closed" && last.phase !== "aborted")
    throw new ContextSurfaceError("Compaction checkpoint chain is not terminal")
  return checkpoints
}

/** Verifies a complete append-only semantic checkpoint chain. */
export const verifyAsyncCompactionCheckpoints = (
  checkpoints: ReadonlyArray<AsyncCompactionCheckpoint>,
): ReadonlyArray<AsyncCompactionCheckpoint> => verifyAsyncCompactionCheckpointChain(checkpoints, true)

/** Verifies a durable prefix observed after process loss without requiring a terminal phase. */
export const verifyAsyncCompactionCheckpointPrefix = (
  checkpoints: ReadonlyArray<AsyncCompactionCheckpoint>,
): ReadonlyArray<AsyncCompactionCheckpoint> => verifyAsyncCompactionCheckpointChain(checkpoints, false)

/** Classifies a checkpoint prefix after cancellation or process loss without authorizing a retry. */
export const classifyAsyncCompaction = (
  checkpoints: ReadonlyArray<AsyncCompactionCheckpoint>,
): AsyncCompactionRecoveryStatus => {
  if (checkpoints.length === 0) return "not_started"
  const last = checkpoints.at(-1)!
  if (last.phase === "aborted") return "aborted"
  if (last.phase === "closed")
    return checkpoints.some((checkpoint) => checkpoint.phase === "committed") ? "committed" : "noop"
  if (checkpoints.some((checkpoint) => checkpoint.phase === "committed")) return "completed_unsettled"
  return "in_flight"
}

/**
 * Runs the summary provider asynchronously while retaining a deterministic,
 * serializable checkpoint chain. Cancellation is checked before and after the
 * provider call; a provider that ignores AbortSignal still cannot commit. The
 * returned checkpoints are intentionally caller-persisted evidence, so a
 * restart can classify an unfinished operation without granting an automatic
 * retry.
 */
export const compactTransactionalAsync = async (input: {
  readonly store: SurfaceStore
  readonly recentTokenBudget: number
  readonly anchors: ContextBudget.CompactionAnchors
  readonly provider: CompactionProvider
  /** Optional renderer for a provider whose output already contains anchors. */
  readonly renderSummary?: (generated: string) => string
  readonly signal?: AbortSignal
  /** Persist each checkpoint before the next side-effecting phase begins. */
  readonly onCheckpoint?: (checkpoint: AsyncCompactionCheckpoint) => void | Promise<void>
}): Promise<AsyncCompactionResult> => {
  if (!Number.isSafeInteger(input.recentTokenBudget) || input.recentTokenBudget < 0)
    throw new ContextSurfaceError("recentTokenBudget must be a non-negative integer")
  if (!input.provider.revision.trim()) throw new ContextSurfaceError("compaction provider revision is required")

  const base = input.store.snapshot().visible
  const tokenizer = input.store.getTokenizer()
  const providerRevision = input.provider.revision.trim()
  const operationID = asyncCompactionOperationID(base, providerRevision)
  const checkpoints: AsyncCompactionCheckpoint[] = []
  const signal = input.signal ?? new AbortController().signal
  const record = async (phase: AsyncCompactionPhase, reason?: AsyncCompactionReason, candidate?: SurfaceVersion) => {
    const checkpoint: AsyncCompactionCheckpoint = Object.freeze({
      version: 1,
      operationID,
      sequence: checkpoints.length + 1,
      phase,
      epoch: base.epoch,
      generation: base.generation,
      sourceHeadSeq: base.sourceHeadSeq,
      surfaceDigest: base.digest,
      providerRevision,
      ...(candidate === undefined ? {} : { candidateDigest: candidate.digest }),
      ...(reason === undefined ? {} : { reason }),
    })
    checkpoints.push(checkpoint)
    await input.onCheckpoint?.(checkpoint)
  }
  const result = (
    status: AsyncCompactionResult["status"],
    phase: AsyncCompactionPhase,
    reason: AsyncCompactionReason,
    candidate?: SurfaceVersion,
    removedSourceSeq: ReadonlyArray<number> = [],
  ): AsyncCompactionResult => {
    verifyAsyncCompactionCheckpoints(checkpoints)
    return Object.freeze({
      status,
      phase,
      reason,
      operationID,
      checkpoints: Object.freeze([...checkpoints]),
      base,
      ...(candidate === undefined ? {} : { candidate }),
      removedSourceSeq: Object.freeze([...removedSourceSeq]),
    })
  }

  await record("prepared")
  if (signal.aborted) {
    await record("aborted", "cancelled")
    return result("aborted", "aborted", "cancelled")
  }

  const selection = selectCompactionGroups(base, input.recentTokenBudget, tokenizer)
  if (!selection) {
    await record("closed", "empty-head")
    return result("noop", "closed", "empty-head")
  }

  await record("summarizing")
  let generated: string | undefined
  try {
    generated = (
      await input.provider.summarize({
        operationID,
        base,
        nodes: Object.freeze([...selection.head]),
        anchors: Object.freeze({ ...input.anchors, protectedFacts: Object.freeze([...input.anchors.protectedFacts]) }),
        recentTokenBudget: input.recentTokenBudget,
        tokenizerMethod: base.tokenizerMethod,
        ...(base.tokenizerRevision === undefined ? {} : { tokenizerRevision: base.tokenizerRevision }),
        signal,
      })
    )?.trim()
  } catch {
    await record("aborted", signal.aborted ? "cancelled" : "summary-failed")
    return result("aborted", "aborted", signal.aborted ? "cancelled" : "summary-failed")
  }
  if (signal.aborted) {
    await record("aborted", "cancelled")
    return result("aborted", "aborted", "cancelled")
  }
  if (!generated) {
    await record("aborted", "summary-failed")
    return result("aborted", "aborted", "summary-failed")
  }

  const candidate = makeCompactionCandidate({
    base,
    head: selection.head,
    retained: selection.retained,
    anchors: input.anchors,
    generated,
    tokenizer,
    renderSummary: input.renderSummary,
  })
  await record("summarized", undefined, candidate)
  if (candidate.tokenCount >= base.tokenCount) {
    await record("closed", "not-smaller", candidate)
    return result("noop", "closed", "not-smaller", candidate)
  }
  if (signal.aborted) {
    await record("aborted", "cancelled", candidate)
    return result("aborted", "aborted", "cancelled", candidate)
  }

  if (input.store.snapshot().visible.digest !== base.digest) {
    await record("aborted", "stale-surface", candidate)
    return result("aborted", "aborted", "stale-surface", candidate)
  }
  await record("revalidated", undefined, candidate)
  try {
    input.store.compareAndCommit(base.digest, candidate)
  } catch (error) {
    if (error instanceof SurfaceConflictError) {
      await record("aborted", "stale-surface", candidate)
      return result("aborted", "aborted", "stale-surface", candidate)
    }
    throw error
  }
  await record("committed", "compacted", candidate)
  await record("closed", "compacted", candidate)
  const completed = result(
    "committed",
    "closed",
    "compacted",
    candidate,
    selection.head.map((node) => node.sourceSeq),
  )
  return completed
}

export type TransactionalPruneResult = Readonly<{
  readonly status: "pruned" | "noop" | "aborted"
  readonly phase: "closed" | "aborted"
  readonly reason:
    | "pruned"
    | "within-budget"
    | "no-prunable"
    | "protected-over-budget"
    | "replacement-not-smaller"
    | "stale-surface"
  readonly base: SurfaceVersion
  readonly candidate?: SurfaceVersion
  readonly prunedSourceSeq: ReadonlyArray<number>
}>

const DEFAULT_PRUNE_MARKER = "[omitted; source retained in the durable log]"

/**
 * Deterministically shortens the visible surface without asking a model to
 * decide what to forget. The oldest middle groups are replaced by a bounded
 * marker; the head and tail are protected, and a tool call/result group is
 * replaced as one unit. The operation uses the same visible CAS as summary
 * compaction, so a concurrent append can only abort it.
 */
export const pruneTransactional = (input: {
  readonly store: SurfaceStore
  readonly maxTokens: number
  readonly preserveHeadGroups?: number
  readonly preserveTailGroups?: number
  readonly marker?: string
}): TransactionalPruneResult => {
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 0)
    throw new ContextSurfaceError("maxTokens must be a non-negative integer")
  const headCount = input.preserveHeadGroups ?? 1
  const tailCount = input.preserveTailGroups ?? 1
  if (!Number.isSafeInteger(headCount) || headCount < 0)
    throw new ContextSurfaceError("preserveHeadGroups must be a non-negative integer")
  if (!Number.isSafeInteger(tailCount) || tailCount < 0)
    throw new ContextSurfaceError("preserveTailGroups must be a non-negative integer")
  const marker = (input.marker ?? DEFAULT_PRUNE_MARKER).trim()
  if (!marker) throw new ContextSurfaceError("prune marker must not be empty")

  const base = input.store.snapshot().visible
  if (base.tokenCount <= input.maxTokens)
    return Object.freeze({
      status: "noop",
      phase: "closed",
      reason: "within-budget",
      base,
      prunedSourceSeq: [],
    })

  const groups = group(base.nodes)
  const firstPrunable = Math.min(groups.length, headCount)
  const lastPrunable = Math.max(firstPrunable, groups.length - tailCount)
  if (firstPrunable >= lastPrunable)
    return Object.freeze({
      status: "noop",
      phase: "closed",
      reason: "no-prunable",
      base,
      prunedSourceSeq: [],
    })

  const tokenizer = input.store.getTokenizer()
  const candidateNodes = [...base.nodes]
  const indices = new Map(base.nodes.map((node, index) => [node.id, index]))
  let candidateTokens = base.tokenCount
  const prunedSourceSeq: number[] = []
  for (const currentGroup of groups.slice(firstPrunable, lastPrunable)) {
    const originalTokens = currentGroup.nodes.reduce(
      (total, node) => total + ContextBudget.count(node.text, tokenizer).tokens,
      0,
    )
    const replacementNodes = currentGroup.nodes.map((node) => ({ ...node, text: marker }))
    const replacementTokens = replacementNodes.reduce(
      (total, node) => total + ContextBudget.count(node.text, tokenizer).tokens,
      0,
    )
    if (replacementTokens >= originalTokens) continue
    for (const replacement of replacementNodes) {
      const index = indices.get(replacement.id)
      if (index === undefined) throw new ContextSurfaceError("Prune candidate lost a source node")
      candidateNodes[index] = replacement
      prunedSourceSeq.push(replacement.sourceSeq)
    }
    candidateTokens -= originalTokens - replacementTokens
    if (candidateTokens <= input.maxTokens) break
  }

  if (prunedSourceSeq.length === 0)
    return Object.freeze({
      status: "noop",
      phase: "closed",
      reason: firstPrunable >= lastPrunable ? "no-prunable" : "replacement-not-smaller",
      base,
      prunedSourceSeq: [],
    })

  const candidate = make({
    nodes: candidateNodes,
    epoch: base.epoch,
    generation: base.generation + 1,
    tokenizer,
  })
  try {
    if (input.store.snapshot().visible.digest !== base.digest)
      return Object.freeze({
        status: "aborted",
        phase: "aborted",
        reason: "stale-surface",
        base,
        candidate,
        prunedSourceSeq: [],
      })
    input.store.compareAndCommit(base.digest, candidate)
  } catch (error) {
    if (error instanceof SurfaceConflictError)
      return Object.freeze({
        status: "aborted",
        phase: "aborted",
        reason: "stale-surface",
        base,
        candidate,
        prunedSourceSeq: [],
      })
    throw error
  }
  return Object.freeze({
    status: "pruned",
    phase: "closed",
    reason: "pruned",
    base,
    candidate,
    prunedSourceSeq: Object.freeze(prunedSourceSeq),
  })
}
