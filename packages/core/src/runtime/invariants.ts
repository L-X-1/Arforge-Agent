import { Cause, Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Package-owned runtime invariant registry.
 *
 * Invariants are deliberately not a second state machine.  They only inspect
 * an already-owned snapshot and return a bounded diagnostic.  Development and
 * test runs execute every registered check; production callers may sample
 * expensive checks explicitly.  Owners also get a small lifecycle ledger so a
 * HMR/dispose path cannot silently leave a listener, job, or service behind.
 */

export type InvariantMode = "development" | "test" | "production"
export type InvariantCost = "cheap" | "normal" | "expensive"

export type RuntimeInvariant = Readonly<{
  readonly owner: string
  readonly key: string
  readonly version: string
  readonly cost: InvariantCost
  /** Production sampling probability. Development/test always run it. */
  readonly sampleRate: number
  readonly check: (context: unknown) => Effect.Effect<void, unknown>
}>

export type InvariantResult = Readonly<{
  readonly owner: string
  readonly key: string
  readonly version: string
  readonly status: "passed" | "failed" | "skipped"
  readonly durationMs: number
  readonly reason?: string
}>

export type InvariantReport = Readonly<{
  readonly mode: InvariantMode
  readonly checked: number
  readonly skipped: number
  readonly passed: number
  readonly failed: number
  readonly results: ReadonlyArray<InvariantResult>
  readonly passedAll: boolean
}>

export type OwnerDisposeReport = Readonly<{
  readonly owner: string
  readonly removedInvariants: number
  readonly releasedResources: number
  readonly leakedResources: ReadonlyArray<string>
}>

export class RuntimeInvariantError extends Error {
  constructor(
    readonly code:
      | "INVALID_REGISTRATION"
      | "DUPLICATE"
      | "INVALID_OWNER"
      | "CHECK_FAILED"
      | "OWNER_LEAK"
      | "OWNER_NOT_FOUND",
    message: string,
  ) {
    super(message)
    this.name = "RuntimeInvariantError"
  }
}

const IDENTIFIER = /^[a-z][a-z0-9._:-]{0,95}$/
const VERSION = /^[a-z0-9][a-z0-9._:-]{0,31}$/
const MAX_REASON_BYTES = 512

const boundedIdentifier = (name: string, value: unknown, pattern: RegExp): string => {
  if (typeof value !== "string" || !pattern.test(value))
    throw new RuntimeInvariantError("INVALID_REGISTRATION", `${name} must be a bounded lowercase identifier`)
  return value
}

const safeReason = (error: unknown): string => {
  let raw: string
  if (error instanceof Error) raw = error.message
  else if (typeof error === "string") raw = error
  else {
    try {
      raw = Cause.pretty(error as Cause.Cause<unknown>)
    } catch {
      raw = "invariant check failed"
    }
  }
  const sanitized = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_REASON_BYTES) return sanitized || "invariant check failed"
  return `${Buffer.from(sanitized, "utf8").subarray(0, MAX_REASON_BYTES).toString("utf8")}…`
}

const defaultSampleRate = (cost: InvariantCost): number => (cost === "cheap" ? 1 : cost === "normal" ? 0.25 : 0.05)

const keyOf = (invariant: Pick<RuntimeInvariant, "owner" | "key" | "version">) =>
  `${invariant.owner}:${invariant.key}@${invariant.version}`

type OwnerState = {
  readonly invariants: Map<string, RuntimeInvariant>
  readonly resources: Map<string, string>
}

export type ResourceLease = Readonly<{
  readonly owner: string
  readonly label: string
  readonly release: () => void
  readonly released: () => boolean
}>

const ensureOwner = (owner: string): string => boundedIdentifier("owner", owner, IDENTIFIER)

/**
 * The registry is intentionally process-local. Durable action/session facts
 * stay in their existing owners; this registry only coordinates diagnostics
 * and lifecycle cleanup for one runtime composition.
 */
export class RuntimeInvariantRegistry {
  private readonly owners = new Map<string, OwnerState>()
  private resourceSequence = 0

  private ownerState(owner: string): OwnerState {
    const normalized = ensureOwner(owner)
    const existing = this.owners.get(normalized)
    if (existing) return existing
    const state: OwnerState = { invariants: new Map(), resources: new Map() }
    this.owners.set(normalized, state)
    return state
  }

  register(input: Omit<RuntimeInvariant, "sampleRate"> & { readonly sampleRate?: number }): this {
    const owner = ensureOwner(input.owner)
    const key = boundedIdentifier("key", input.key, IDENTIFIER)
    const version = boundedIdentifier("version", input.version, VERSION)
    if (!(input.cost === "cheap" || input.cost === "normal" || input.cost === "expensive"))
      throw new RuntimeInvariantError("INVALID_REGISTRATION", "invariant cost is invalid")
    const sampleRate = input.sampleRate ?? defaultSampleRate(input.cost)
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1)
      throw new RuntimeInvariantError("INVALID_REGISTRATION", "invariant sampleRate must be between 0 and 1")
    if (typeof input.check !== "function")
      throw new RuntimeInvariantError("INVALID_REGISTRATION", "invariant check is required")

    const state = this.ownerState(owner)
    const invariant = Object.freeze({ owner, key, version, cost: input.cost, sampleRate, check: input.check })
    const id = keyOf(invariant)
    if (state.invariants.has(id)) throw new RuntimeInvariantError("DUPLICATE", `invariant already registered: ${id}`)
    state.invariants.set(id, invariant)
    return this
  }

  get(owner: string, key: string, version: string): RuntimeInvariant | undefined {
    const state = this.owners.get(ensureOwner(owner))
    if (!state) return undefined
    return state.invariants.get(keyOf({ owner, key, version }))
  }

  list(owner?: string): ReadonlyArray<RuntimeInvariant> {
    if (owner !== undefined) return Object.freeze([...(this.owners.get(ensureOwner(owner))?.invariants.values() ?? [])])
    return Object.freeze([...this.owners.values()].flatMap((state) => [...state.invariants.values()]))
  }

  ownersSnapshot(): ReadonlyArray<Readonly<{ owner: string; invariants: number; resources: number }>> {
    return Object.freeze(
      [...this.owners.entries()].map(([owner, state]) => ({
        owner,
        invariants: state.invariants.size,
        resources: state.resources.size,
      })),
    )
  }

  /** Track a listener/job/service owned by an invariant owner. */
  track(owner: string, label: string): ResourceLease {
    const normalizedOwner = ensureOwner(owner)
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 160)
      throw new RuntimeInvariantError("INVALID_REGISTRATION", "resource label is missing or too long")
    const state = this.ownerState(normalizedOwner)
    const token = `${normalizedOwner}#${++this.resourceSequence}`
    state.resources.set(token, label)
    let isReleased = false
    return Object.freeze({
      owner: normalizedOwner,
      label,
      release: () => {
        if (isReleased) return
        isReleased = true
        state.resources.delete(token)
      },
      released: () => isReleased,
    })
  }

  /**
   * Dispose an owner only after all tracked resources have released.  A
   * failed disposal leaves the owner registered so the next diagnostic can
   * still identify the leak instead of erasing evidence.
   */
  disposeOwner(owner: string): OwnerDisposeReport {
    const normalizedOwner = ensureOwner(owner)
    const state = this.owners.get(normalizedOwner)
    if (!state)
      throw new RuntimeInvariantError("OWNER_NOT_FOUND", `invariant owner is not registered: ${normalizedOwner}`)
    const leakedResources = [...state.resources.values()]
    if (leakedResources.length > 0)
      throw new RuntimeInvariantError(
        "OWNER_LEAK",
        `owner ${normalizedOwner} still owns ${leakedResources.length} resource(s): ${leakedResources.join(", ")}`,
      )
    const removedInvariants = state.invariants.size
    this.owners.delete(normalizedOwner)
    return { owner: normalizedOwner, removedInvariants, releasedResources: 0, leakedResources: [] }
  }

  /**
   * Run all selected checks in registration order.  A check failure is
   * captured as bounded evidence so sibling invariants still run.
   */
  run(
    context: unknown,
    options: {
      readonly mode?: InvariantMode
      readonly owner?: string
      /** Select one phase/check inside an owner without running unrelated contexts. */
      readonly key?: string
      readonly random?: () => number
    } = {},
  ): Effect.Effect<InvariantReport> {
    const mode = options.mode ?? "test"
    const random = options.random ?? Math.random
    const selectedKey = options.key === undefined ? undefined : boundedIdentifier("key", options.key, IDENTIFIER)
    const selected = this.list(options.owner).filter(
      (invariant) => selectedKey === undefined || invariant.key === selectedKey,
    )
    return Effect.gen(function* () {
      const results: InvariantResult[] = []
      for (const invariant of selected) {
        const runCheck = mode === "production" && random() >= invariant.sampleRate
        if (runCheck) {
          results.push({
            owner: invariant.owner,
            key: invariant.key,
            version: invariant.version,
            status: "skipped",
            durationMs: 0,
          })
          continue
        }
        const startedAt = Date.now()
        const result = yield* Effect.suspend(() => {
          try {
            return invariant.check(context).pipe(Effect.exit)
          } catch (error) {
            return Effect.exit(Effect.fail(error))
          }
        })
        const durationMs = Math.max(0, Date.now() - startedAt)
        if (result._tag === "Success") {
          results.push({
            owner: invariant.owner,
            key: invariant.key,
            version: invariant.version,
            status: "passed",
            durationMs,
          })
        } else {
          results.push({
            owner: invariant.owner,
            key: invariant.key,
            version: invariant.version,
            status: "failed",
            durationMs,
            reason: safeReason(result.cause),
          })
        }
      }
      const checked = results.filter((result) => result.status !== "skipped").length
      const skipped = results.length - checked
      const passed = results.filter((result) => result.status === "passed").length
      const failed = results.length - skipped - passed
      return {
        mode,
        checked,
        skipped,
        passed,
        failed,
        results: Object.freeze(results),
        passedAll: failed === 0,
      } satisfies InvariantReport
    })
  }

  /** Fail the Effect when one or more invariant checks fail. */
  assert(
    context: unknown,
    options: Parameters<RuntimeInvariantRegistry["run"]>[1] = {},
  ): Effect.Effect<InvariantReport, RuntimeInvariantError> {
    return this.run(context, options).pipe(
      Effect.flatMap((report) =>
        report.passedAll
          ? Effect.succeed(report)
          : Effect.fail(new RuntimeInvariantError("CHECK_FAILED", `${report.failed} runtime invariant(s) failed`)),
      ),
    )
  }
}

export const createRuntimeInvariantRegistry = (): RuntimeInvariantRegistry => new RuntimeInvariantRegistry()

/** Global composition-root service; business owners register into this one instance. */
export class Service extends Context.Service<Service, RuntimeInvariantRegistry>()(
  "@arforge/v2/RuntimeInvariantRegistry",
) {}

export const layer = Layer.sync(Service, () => new RuntimeInvariantRegistry())
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/** EventV2 sequence must be contiguous from the supplied starting sequence. */
export const assertContiguousSequence = (
  events: ReadonlyArray<Readonly<{ readonly seq: number }>>,
  start = 1,
): void => {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("sequence start must be a non-negative integer")
  events.forEach((event, index) => {
    if (!Number.isSafeInteger(event.seq) || event.seq !== start + index)
      throw new Error(`event sequence is not contiguous at index ${index}`)
  })
}

/** A lifecycle entry is closed only when it has a terminal status. */
export const assertLifecycleClosed = (
  entries: ReadonlyArray<Readonly<{ readonly id: string; readonly status: string }>>,
  terminalStatuses: ReadonlySet<string>,
): void => {
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error("lifecycle entry id is missing")
    if (!terminalStatuses.has(entry.status)) throw new Error(`lifecycle entry is not terminal: ${entry.id}`)
  }
}

/** Provider requests must be reconstructed to the exact durable digest. */
export const assertExactRequestDigest = (expected: string, actual: string): void => {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual) || expected !== actual)
    throw new Error("provider request digest mismatch")
}

/** A stale runner/fiber may observe state but cannot commit it. */
export const assertFreshEpoch = (expectedEpoch: number, currentEpoch: number, committed: boolean): void => {
  if (!Number.isSafeInteger(expectedEpoch) || !Number.isSafeInteger(currentEpoch))
    throw new Error("execution epoch must be an integer")
  if (committed && expectedEpoch !== currentEpoch) throw new Error("stale execution epoch cannot commit")
}

/** Policy transitions may only become more restrictive. */
export const assertPolicyMonotonic = (previous: string, next: string, order: ReadonlyArray<string>): void => {
  const before = order.indexOf(previous)
  const after = order.indexOf(next)
  if (before < 0 || after < 0 || after < before) throw new Error("tool policy transition is not monotonic")
}

/** Child authority must be a subset of the parent's granted authority. */
export const assertDelegatedAuthoritySubset = (parent: ReadonlySet<string>, child: ReadonlySet<string>): void => {
  for (const capability of child) {
    if (!parent.has(capability)) throw new Error(`delegated authority is not a parent subset: ${capability}`)
  }
}

/** Tool call/result pairs must be complete and unique before compaction. */
export const assertToolPairsClosed = (
  parts: ReadonlyArray<Readonly<{ readonly type: "call" | "result"; readonly callID: string }>>,
): void => {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const part of parts) {
    if (!part.callID) throw new Error("tool pair callID is missing")
    if (part.type === "call") {
      if (calls.has(part.callID)) throw new Error(`duplicate tool call: ${part.callID}`)
      calls.add(part.callID)
    } else {
      if (!calls.has(part.callID) || results.has(part.callID))
        throw new Error(`invalid tool result pair: ${part.callID}`)
      results.add(part.callID)
    }
  }
  if (calls.size !== results.size) throw new Error("tool call/result pairs are not closed")
}

/** A settled Action must expose the same terminal observation to the model. */
export const assertActionResultConsistent = (
  input: Readonly<{
    readonly actionStatus: string
    readonly observationStatus?: string
    readonly modelResultStatus?: string
  }>,
): void => {
  if (input.actionStatus === "settled" && input.observationStatus === undefined)
    throw new Error("settled Action is missing its durable observation")
  if (
    input.actionStatus === "settled" &&
    input.modelResultStatus !== undefined &&
    input.observationStatus !== input.modelResultStatus
  )
    throw new Error("model-visible tool result disagrees with durable observation")
  if (input.actionStatus === "executing" && input.modelResultStatus !== undefined)
    throw new Error("executing Action cannot expose a final model result")
}

/**
 * Recovery decisions must remain a payload-free, ordered owner plan.  This
 * check is intentionally independent of DurableRun/ExperienceStore so it can
 * validate a persisted outbox receipt before any owner write is attempted.
 */
export const assertSettlementRecoveryInvariant = (
  input: Readonly<{
    readonly deterministic: boolean
    readonly providerExecutionAllowed: boolean
    readonly next: ReadonlyArray<string>
    readonly missing: ReadonlyArray<string>
    readonly conflicts: ReadonlyArray<string>
    readonly complete: boolean
  }>,
): void => {
  if (input.deterministic !== true) throw new Error("settlement recovery must be deterministic")
  if (input.providerExecutionAllowed !== false) throw new Error("settlement recovery cannot authorize provider execution")
  const order = ["admission-evidence", "child-result", "parent-budget"] as const
  const rank = new Map(order.map((value, index) => [value, index]))
  const validateWrites = (name: string, writes: ReadonlyArray<string>) => {
    if (new Set(writes).size !== writes.length) throw new Error(`${name} contains duplicate owner writes`)
    for (const write of writes) if (!rank.has(write as (typeof order)[number])) throw new Error(`${name} contains an unknown owner write`)
    for (let index = 1; index < writes.length; index++) {
      if (rank.get(writes[index - 1] as (typeof order)[number])! > rank.get(writes[index] as (typeof order)[number])!)
        throw new Error(`${name} is not in Evidence → result → budget order`)
    }
  }
  validateWrites("next", input.next)
  validateWrites("missing", input.missing)
  if (input.conflicts.some((reason) => typeof reason !== "string" || reason.trim().length === 0))
    throw new Error("settlement recovery conflicts must have bounded reasons")
  if (input.conflicts.length > 0 && input.next.length > 0)
    throw new Error("settlement recovery cannot schedule owner writes while a conflict exists")
  if (input.conflicts.length === 0 && input.next.join("\u0000") !== input.missing.join("\u0000"))
    throw new Error("settlement recovery next writes must equal the missing owners when conflict-free")
  if (input.complete !== (input.conflicts.length === 0 && input.missing.length === 0))
    throw new Error("settlement recovery complete state disagrees with its owner facts")
  if (input.complete && input.next.length > 0) throw new Error("complete settlement recovery cannot schedule owner writes")
}
