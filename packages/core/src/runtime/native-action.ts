/** Core contract for native actions crossing a Desktop main-process boundary. */

import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

export const NATIVE_ACTION_RECEIPT_CHANNEL = "native-action-receipt"

export const NativeActionKind = {
  filesystem: "filesystem",
  process: "process",
  window: "window",
  clipboard: "clipboard",
  notification: "notification",
} as const

export type NativeActionKind = (typeof NativeActionKind)[keyof typeof NativeActionKind]

export type NativeActionState = "proposed" | "executing" | "observed" | "settled" | "blocked" | "recovery_required"

export type NativeObservationStatus = "succeeded" | "failed" | "unknown"

export type NativeActionRequest = Readonly<{
  readonly actionID: string
  readonly traceID: string
  readonly senderID: number
  readonly kind: NativeActionKind
  readonly name: string
  readonly inputDigest: string
}>

export type NativeActionReceipt = Readonly<{
  readonly actionID: string
  readonly traceID: string
  readonly senderID: number
  readonly kind: NativeActionKind
  readonly name: string
  readonly inputDigest: string
  readonly state: NativeActionState
  readonly observationStatus: NativeObservationStatus
  readonly outputDigest?: string
  readonly outputByteLength?: number
  readonly errorCode?: string
  readonly timeCreated: number
  readonly timeUpdated: number
}>

export type NativeActionExecution<A> = Readonly<{
  readonly value: A
  readonly receipt: NativeActionReceipt
}>

export class NativeActionValidationError extends Error {
  readonly code = "NATIVE_ACTION_INVALID_REQUEST"

  constructor(message: string) {
    super(message)
    this.name = "NativeActionValidationError"
  }
}

export class NativeActionCapabilityError extends Error {
  readonly code = "NATIVE_ACTION_INVALID_CAPABILITY"

  constructor() {
    super("The native action capability was not issued by Core")
    this.name = "NativeActionCapabilityError"
  }
}

export class NativeActionAlreadySettledError extends Error {
  readonly code = "NATIVE_ACTION_ALREADY_SETTLED"
  readonly receipt: NativeActionReceipt

  constructor(receipt: NativeActionReceipt) {
    super("The native action is already settled and must not be executed again")
    this.name = "NativeActionAlreadySettledError"
    this.receipt = receipt
  }
}

export class NativeActionRecoveryRequiredError extends Error {
  readonly code = "NATIVE_ACTION_RECOVERY_REQUIRED"
  readonly receipt: NativeActionReceipt

  constructor(receipt: NativeActionReceipt) {
    super("The native action was interrupted before observation; recovery is required")
    this.name = "NativeActionRecoveryRequiredError"
    this.receipt = receipt
  }
}

export type NativeActionJournal = {
  readonly load: () => Promise<ReadonlyArray<NativeActionReceipt>>
  readonly append: (receipt: NativeActionReceipt) => Promise<void>
}

const capabilityBrand: unique symbol = Symbol("@arforge/core/native-action-capability")

export type NativeActionCapability = Readonly<{
  readonly [capabilityBrand]: true
}>

type CapabilityBinding = Readonly<{
  readonly senderID: number
  readonly kind: NativeActionKind
}>

const MAX_NAME_BYTES = 160
const MAX_DIGEST_BYTES = 128
const MAX_INPUT_BYTES = 64 * 1024

const byteLength = (value: string) => Buffer.byteLength(value, "utf8")

const stableJson = (value: unknown): string => {
  if (value === undefined) return "null"
  const seen = new WeakSet<object>()
  const normalise = (input: unknown, depth: number): unknown => {
    if (depth > 12) throw new NativeActionValidationError("Native action input is too deeply nested")
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number") {
      if (!Number.isFinite(input))
        throw new NativeActionValidationError("Native action input contains a non-finite number")
      return input
    }
    if (typeof input !== "object") throw new NativeActionValidationError("Native action input is not JSON-safe")
    if (seen.has(input)) throw new NativeActionValidationError("Native action input contains a cycle")
    seen.add(input)
    if (Array.isArray(input)) return input.map((item) => normalise(item, depth + 1))
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))
      output[key] = normalise(value, depth + 1)
    return output
  }
  return JSON.stringify(normalise(value, 0)) ?? "null"
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const validID = (value: unknown, prefix: string) =>
  typeof value === "string" && value.startsWith(prefix) && value.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(value)

export function createNativeActionRequest(input: {
  readonly senderID: number
  readonly kind: NativeActionKind
  readonly name: string
  readonly payload: unknown
}): NativeActionRequest {
  if (!Number.isSafeInteger(input.senderID) || input.senderID <= 0)
    throw new NativeActionValidationError("senderID is invalid")
  if (!Object.values(NativeActionKind).includes(input.kind))
    throw new NativeActionValidationError("native action kind is invalid")
  if (!input.name || byteLength(input.name) > MAX_NAME_BYTES || !/^[a-z][a-z0-9._-]*$/i.test(input.name))
    throw new NativeActionValidationError("native action name is invalid")
  const encoded = stableJson(input.payload)
  if (byteLength(encoded) > MAX_INPUT_BYTES) throw new NativeActionValidationError("native action input is too large")
  const inputDigest = digest(encoded)
  const nonce = randomUUID()
  return Object.freeze({
    actionID: `act_native_${nonce}`,
    traceID: `trace_native_${nonce}`,
    senderID: input.senderID,
    kind: input.kind,
    name: input.name,
    inputDigest,
  })
}

export function validateNativeActionRequest(request: NativeActionRequest): NativeActionRequest {
  if (!validID(request.actionID, "act_native_")) throw new NativeActionValidationError("actionID is invalid")
  if (!validID(request.traceID, "trace_native_")) throw new NativeActionValidationError("traceID is invalid")
  if (!Number.isSafeInteger(request.senderID) || request.senderID <= 0)
    throw new NativeActionValidationError("senderID is invalid")
  if (!Object.values(NativeActionKind).includes(request.kind))
    throw new NativeActionValidationError("native action kind is invalid")
  if (!request.name || byteLength(request.name) > MAX_NAME_BYTES || !/^[a-z][a-z0-9._-]*$/i.test(request.name))
    throw new NativeActionValidationError("native action name is invalid")
  if (
    byteLength(request.inputDigest) !== 64 ||
    byteLength(request.inputDigest) > MAX_DIGEST_BYTES ||
    !/^[a-f0-9]+$/i.test(request.inputDigest)
  )
    throw new NativeActionValidationError("inputDigest is invalid")
  return request
}

export function createMemoryNativeActionJournal(initial: ReadonlyArray<NativeActionReceipt> = []): NativeActionJournal {
  const records = [...initial]
  return {
    load: async () => [...records],
    append: async (receipt) => {
      records.push(receipt)
    },
  }
}

export function createFileNativeActionJournal(path: string): NativeActionJournal {
  let queue = Promise.resolve()
  return {
    load: async () => {
      const raw = await readFile(path, "utf8").catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
        throw error
      })
      const records: NativeActionReceipt[] = []
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line) as NativeActionReceipt
          validateReceipt(parsed)
          records.push(parsed)
        } catch {
          throw new NativeActionValidationError("Native action journal is corrupt")
        }
      }
      return records
    },
    append: async (receipt) => {
      queue = queue.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${JSON.stringify(receipt)}\n`, "utf8")
      })
      return queue
    },
  }
}

function validateReceipt(receipt: NativeActionReceipt) {
  validateNativeActionRequest(receipt)
  if (!["proposed", "executing", "observed", "settled", "blocked", "recovery_required"].includes(receipt.state))
    throw new NativeActionValidationError("native action receipt state is invalid")
  if (!["succeeded", "failed", "unknown"].includes(receipt.observationStatus))
    throw new NativeActionValidationError("native action observation status is invalid")
  return receipt
}

const nextReceipt = (
  request: NativeActionRequest,
  state: NativeActionState,
  observationStatus: NativeObservationStatus,
  timeCreated: number,
  timeUpdated: number,
  extra: Partial<Pick<NativeActionReceipt, "outputDigest" | "outputByteLength" | "errorCode">> = {},
): NativeActionReceipt =>
  Object.freeze({
    ...request,
    state,
    observationStatus,
    timeCreated,
    timeUpdated,
    ...extra,
  })

const errorCode = (error: unknown) => {
  if (error instanceof NativeActionValidationError) return error.code
  if (error instanceof NativeActionCapabilityError) return error.code
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code.slice(0, 80)
  return "NATIVE_ACTION_OPERATION_FAILED"
}

export function createNativeActionRuntime(options: {
  readonly journal?: NativeActionJournal
  readonly now?: () => number
}) {
  const journal = options.journal ?? createMemoryNativeActionJournal()
  const now = options.now ?? Date.now
  const records = new Map<string, NativeActionReceipt>()
  const capabilities = new WeakMap<object, CapabilityBinding>()
  const capabilityBySenderAndKind = new Map<string, NativeActionCapability>()
  let loaded = false
  let loadPromise: Promise<void> | undefined

  const ensureLoaded = async () => {
    if (loaded) return
    if (!loadPromise) {
      loadPromise = journal.load().then((items) => {
        for (const item of items) {
          validateReceipt(item)
          records.set(item.actionID, item)
        }
        loaded = true
      })
    }
    await loadPromise
  }

  const issueCapability = (senderID: number, kind: NativeActionKind): NativeActionCapability => {
    const key = `${senderID}:${kind}`
    const existing = capabilityBySenderAndKind.get(key)
    if (existing) return existing
    const capability = Object.freeze({ [capabilityBrand]: true as const })
    capabilities.set(capability, { senderID, kind })
    capabilityBySenderAndKind.set(key, capability)
    return capability
  }

  const assertCapability = (capability: NativeActionCapability, request: NativeActionRequest) => {
    const binding = capabilities.get(capability)
    if (!binding || binding.senderID !== request.senderID || binding.kind !== request.kind)
      throw new NativeActionCapabilityError()
  }

  const append = async (receipt: NativeActionReceipt) => {
    records.set(receipt.actionID, receipt)
    await journal.append(receipt)
  }

  const execute = async <A>(
    request: NativeActionRequest,
    operation: (capability: NativeActionCapability) => Promise<A> | A,
  ): Promise<NativeActionExecution<A>> => {
    await ensureLoaded()
    validateNativeActionRequest(request)
    const previous = records.get(request.actionID)
    if (previous?.state === "settled" || previous?.state === "blocked")
      throw new NativeActionAlreadySettledError(previous)
    if (previous?.state === "recovery_required" || previous?.state === "executing" || previous?.state === "observed")
      throw new NativeActionRecoveryRequiredError(previous)

    const created = now()
    await append(nextReceipt(request, "proposed", "unknown", created, created))
    const capability = issueCapability(request.senderID, request.kind)
    assertCapability(capability, request)
    await append(nextReceipt(request, "executing", "unknown", created, now()))
    try {
      const value = await operation(capability)
      const encoded = stableJson(value)
      const observed = nextReceipt(request, "observed", "succeeded", created, now(), {
        outputDigest: digest(encoded),
        outputByteLength: byteLength(encoded),
      })
      await append(observed)
      const settled = nextReceipt(request, "settled", "succeeded", created, now(), {
        outputDigest: observed.outputDigest,
        outputByteLength: observed.outputByteLength,
      })
      await append(settled)
      return { value, receipt: settled }
    } catch (error) {
      const blocked = error instanceof NativeActionValidationError || error instanceof NativeActionCapabilityError
      const failed = nextReceipt(
        request,
        blocked ? "blocked" : "recovery_required",
        blocked ? "failed" : "unknown",
        created,
        now(),
        {
          errorCode: errorCode(error),
        },
      )
      await append(failed)
      throw error
    }
  }

  const recover = async () => {
    await ensureLoaded()
    const pending = [...records.values()].filter((record) =>
      ["proposed", "executing", "observed"].includes(record.state),
    )
    const recovered: NativeActionReceipt[] = []
    for (const record of pending) {
      const next = nextReceipt(record, "recovery_required", "unknown", record.timeCreated, now(), {
        errorCode: "NATIVE_ACTION_INTERRUPTED",
      })
      await append(next)
      recovered.push(next)
    }
    return recovered
  }

  return {
    execute,
    recover,
    list: async () => {
      await ensureLoaded()
      return [...records.values()]
    },
  }
}
