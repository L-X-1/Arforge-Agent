import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Layer } from "effect"
import { LLM, LLMClient, type JsonSchema, type Model } from "@arforge-ai/llm"
import * as Anthropic from "@arforge-ai/llm/providers/anthropic"
import { RequestExecutor, WebSocketExecutor } from "@arforge-ai/llm/route"

const root = resolve(import.meta.dir, "../../..")
export const MODEL = "deepseek-v4-flash"
const MAX_REQUESTS = 3
export const MAX_TOKENS_PER_REQUEST = 512
const REQUIRED_STABLE_SAMPLES = 3
const AUTHORIZED_BUDGET_CNY = 5

type JsonRecord = Record<string, unknown>
type Task = {
  readonly id: string
  readonly prompt: string
  readonly expected: unknown
}

const TASKS: ReadonlyArray<Task> = [
  {
    id: "case_ready_blocked_counts",
    prompt: 'Count the values in ["ready", "ready", "blocked", "ready"].',
    expected: { ready: 3, blocked: 1 },
  },
  {
    id: "case_ascending_numbers",
    prompt: "Sort the numbers [13, 2, 8, 5] in ascending order and return the resulting array.",
    expected: [2, 5, 8, 13],
  },
  {
    id: "case_terminal_statuses",
    prompt:
      'Count terminal statuses in ["queued", "running", "completed", "failed", "cancelled"]. Terminal means completed, failed, or cancelled.',
    expected: 3,
  },
  {
    id: "case_digest_length",
    prompt: 'Return the character length of this lowercase hexadecimal digest: "' + "a".repeat(64) + '".',
    expected: 64,
  },
]

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]))
export const BASELINE_TASK_IDS = TASKS.map((task) => task.id)
export const CHILD_TASK_IDS = [TASKS.slice(0, 2).map((task) => task.id), TASKS.slice(2).map((task) => task.id)] as const

export type AttemptResult = {
  readonly id: string
  readonly ok: boolean
  readonly durationMs: number
  readonly totalTokens: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly usageAvailable: boolean
  readonly responseSha256?: string
  readonly responseTextLength: number
  readonly reasoningTextLength: number
  readonly toolCallCount: number
  readonly finishReason?: string
  readonly validatedTaskIDs: ReadonlyArray<string>
  readonly errorTag?: string
  readonly errorReasonTag?: string
  readonly errorHttpStatus?: number
  readonly errorRetryable?: boolean
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return "null"
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function argumentValue(args: ReadonlyArray<string>, flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

function repositoryPath(input: string) {
  if (isAbsolute(input)) throw new Error("output path must be repository-relative")
  const absolute = resolve(root, input)
  const value = relative(root, absolute).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("output path must stay inside repository root")
  }
  return { absolute, relative: value }
}

function promptFor(taskIDs: ReadonlyArray<string>) {
  const tasks = taskIDs.map((id) => TASK_BY_ID.get(id)).filter((task): task is Task => task !== undefined)
  return [
    "You are a deterministic benchmark worker for an engineering experiment.",
    "Do not explain your work and do not use Markdown.",
    "Return the requested data through the forced structured result tool.",
    'The result must contain exactly one top-level key: "results".',
    'The value of "results" must contain exactly one key for each requested task ID and no other keys.',
    "Each task result must be the direct answer to its task, not a sentence.",
    "Requested tasks:",
    ...tasks.map((task) => `- ${task.id}: ${task.prompt}`),
  ].join("\n")
}

function taskJsonSchema(task: Task): JsonSchema {
  if (Array.isArray(task.expected)) return { type: "array", items: { type: "integer" } }
  if (isRecord(task.expected)) {
    const properties = Object.fromEntries(Object.keys(task.expected).map((key) => [key, { type: "integer" }]))
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required: Object.keys(task.expected),
    }
  }
  return { type: typeof task.expected === "number" ? "integer" : "string" }
}

function resultJsonSchema(taskIDs: ReadonlyArray<string>): JsonSchema {
  const properties = Object.fromEntries(
    taskIDs.flatMap((id) => {
      const task = TASK_BY_ID.get(id)
      return task ? [[id, taskJsonSchema(task)]] : []
    }),
  )
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      results: {
        type: "object",
        additionalProperties: false,
        properties,
        required: taskIDs,
      },
    },
    required: ["results"],
  }
}

function validateResults(value: unknown, taskIDs: ReadonlyArray<string>) {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.results)) return []
  const resultKeys = Object.keys(value.results).toSorted()
  const expectedKeys = [...taskIDs].toSorted()
  if (canonicalJson(resultKeys) !== canonicalJson(expectedKeys)) return []
  for (const id of taskIDs) {
    const task = TASK_BY_ID.get(id)
    if (!task || canonicalJson(value.results[id]) !== canonicalJson(task.expected)) return []
  }
  return [...taskIDs]
}

export function safeErrorDetails(error: unknown) {
  const record = isRecord(error) ? error : undefined
  const reason = record && isRecord(record.reason) ? record.reason : undefined
  const http = reason && isRecord(reason.http) ? reason.http : undefined
  const response = http && isRecord(http.response) ? http.response : undefined
  const status = response?.status
  return {
    errorTag:
      typeof record?._tag === "string"
        ? record._tag
        : typeof record?.name === "string"
          ? record.name
          : "provider-request-failed",
    errorReasonTag: typeof reason?._tag === "string" ? reason._tag : undefined,
    errorHttpStatus: typeof status === "number" && Number.isSafeInteger(status) ? status : undefined,
    errorRetryable: typeof record?.retryable === "boolean" ? record.retryable : undefined,
  }
}

function tokenValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

const requestExecutorLayer = RequestExecutor.fetchLayer
const llmDeps = Layer.mergeAll(requestExecutorLayer, WebSocketExecutor.layer)
const llmClientLayer = LLMClient.layer.pipe(Layer.provide(llmDeps))
export const runtimeLayer = Layer.mergeAll(llmDeps, llmClientLayer)

export function executeAttempt(model: Model, id: string, taskIDs: ReadonlyArray<string>): Effect.Effect<AttemptResult> {
  const startedAt = Date.now()
  return LLM.generateObject({
    model,
    system: "Return only the requested structured result. Never reveal credentials or environment details.",
    prompt: promptFor(taskIDs),
    jsonSchema: resultJsonSchema(taskIDs),
    generation: { maxTokens: MAX_TOKENS_PER_REQUEST, temperature: 0 },
  }).pipe(
    Effect.map((generated) => {
      const object = generated.object
      const response = generated.response
      const usage = generated.usage
      const inputTokens = tokenValue(usage?.inputTokens)
      const outputTokens = tokenValue(usage?.outputTokens)
      const totalTokens = tokenValue(usage?.totalTokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0)
      const validatedTaskIDs = validateResults(object, taskIDs)
      return {
        id,
        ok: validatedTaskIDs.length === taskIDs.length,
        durationMs: Math.max(0, Date.now() - startedAt),
        totalTokens,
        inputTokens,
        outputTokens,
        usageAvailable: usage !== undefined,
        responseSha256: sha256(canonicalJson(object)),
        responseTextLength: response.text.length,
        reasoningTextLength: response.reasoning.length,
        toolCallCount: response.toolCalls.length,
        finishReason: response.finishReason,
        validatedTaskIDs,
      }
    }),
    Effect.catch((error) =>
      Effect.succeed({
        id,
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt),
        totalTokens: 0,
        usageAvailable: false,
        validatedTaskIDs: [],
        responseTextLength: 0,
        reasoningTextLength: 0,
        toolCallCount: 0,
        ...safeErrorDetails(error),
      }),
    ),
  )
}

function metrics(attempts: ReadonlyArray<AttemptResult>, durationMs: number) {
  return {
    sampleSize: 1,
    succeeded: attempts.every((attempt) => attempt.ok) ? 1 : 0,
    totalDurationMs: durationMs,
    totalTokens: attempts.reduce((sum, attempt) => sum + attempt.totalTokens, 0),
    totalCostMinor: 0,
    conflicts: 0,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const outputInput = argumentValue(args, "--output") ?? "artifacts/stage8-deepseek-experiment.json"
  const output = repositoryPath(outputInput)
  const baseURL = process.env.ANTHROPIC_BASE_URL
  const keyAvailable = Boolean(process.env.ANTHROPIC_API_KEY)
  const endpoint = baseURL ? new URL(baseURL) : undefined
  const endpointAllowed = endpoint?.protocol === "https:" && endpoint.hostname === "api.deepseek.com"
  const datasetDigest = sha256(canonicalJson(TASKS))
  const requestDigest = sha256(
    canonicalJson({
      model: MODEL,
      datasetDigest,
      generation: { maxTokens: MAX_TOKENS_PER_REQUEST, temperature: 0 },
      baseline: BASELINE_TASK_IDS,
      children: CHILD_TASK_IDS,
    }),
  )
  const common = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceClass: "deepseek-live-experiment",
    provider: "deepseek",
    model: MODEL,
    endpointHost: endpoint?.hostname ?? "unavailable",
    datasetDigest,
    requestDigest,
    authorization: {
      maxRequests: MAX_REQUESTS,
      budgetCnyLimit: AUTHORIZED_BUDGET_CNY,
      maxTokensPerRequest: MAX_TOKENS_PER_REQUEST,
      requestsUsed: 0,
    },
    safety: {
      secretsPrinted: false,
      productionDataChanged: false,
      stagingDataChanged: false,
    },
  }

  if (!args.includes("--authorize-live")) {
    const report = {
      ...common,
      status: "blocked",
      decision: "DO_NOT_PROMOTE",
      promotionEligible: false,
      failureReason: "explicit --authorize-live is required; no provider request was attempted",
      authorization: { ...common.authorization, requestsUsed: 0 },
    }
    await mkdir(resolve(output.absolute, ".."), { recursive: true })
    await writeFile(output.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
    console.log(JSON.stringify({ output: output.absolute, status: report.status, decision: report.decision }))
    process.exitCode = 1
    return
  }

  if (!keyAvailable || !baseURL || !endpointAllowed) {
    const report = {
      ...common,
      status: "fail",
      decision: "DO_NOT_PROMOTE",
      authorization: { ...common.authorization, requestsUsed: 0 },
      promotionEligible: false,
      failureReason: !keyAvailable
        ? "ANTHROPIC_API_KEY is unavailable"
        : !baseURL
          ? "ANTHROPIC_BASE_URL is unavailable"
          : "configured endpoint is not the authorized HTTPS api.deepseek.com host",
    }
    await mkdir(resolve(output.absolute, ".."), { recursive: true })
    await writeFile(output.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
    console.log(JSON.stringify({ output: output.absolute, status: report.status, decision: report.decision }))
    process.exitCode = 1
    return
  }

  const model = Anthropic.configure({
    baseURL,
    generation: { maxTokens: MAX_TOKENS_PER_REQUEST, temperature: 0 },
  }).model(MODEL)
  const startedAt = Date.now()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const baselineStartedAt = Date.now()
      const baseline = yield* executeAttempt(model, "baseline", BASELINE_TASK_IDS)
      const baselineDurationMs = Math.max(0, Date.now() - baselineStartedAt)
      const multiStartedAt = Date.now()
      const children = yield* Effect.all(
        [executeAttempt(model, "child-a", CHILD_TASK_IDS[0]), executeAttempt(model, "child-b", CHILD_TASK_IDS[1])],
        { concurrency: 2 },
      )
      const multiDurationMs = Math.max(0, Date.now() - multiStartedAt)
      return { baseline, children, baselineDurationMs, multiDurationMs }
    }).pipe(Effect.provide(runtimeLayer)),
  )
  const attempts = [result.baseline, ...result.children]
  const successful = result.baseline.ok && result.children.every((attempt) => attempt.ok)
  const requestCount = attempts.length
  const report = {
    ...common,
    status: successful && requestCount === MAX_REQUESTS ? "candidate" : "fail",
    decision: "DO_NOT_PROMOTE",
    promotionEligible: false,
    reason:
      successful && requestCount === MAX_REQUESTS
        ? `live comparison completed, but both modes have sampleSize=1; at least ${REQUIRED_STABLE_SAMPLES} stable samples are required`
        : "one or more live benchmark requests or response validations failed",
    authorization: { ...common.authorization, requestsUsed: requestCount },
    dataset: {
      taskIDs: BASELINE_TASK_IDS,
      childAssignments: CHILD_TASK_IDS,
    },
    baseline: metrics([result.baseline], result.baselineDurationMs),
    multi: metrics(result.children, result.multiDurationMs),
    source: "live",
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      ok: attempt.ok,
      durationMs: attempt.durationMs,
      totalTokens: attempt.totalTokens,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      usageAvailable: attempt.usageAvailable,
      responseSha256: attempt.responseSha256,
      responseTextLength: attempt.responseTextLength,
      reasoningTextLength: attempt.reasoningTextLength,
      toolCallCount: attempt.toolCallCount,
      finishReason: attempt.finishReason,
      validatedTaskIDs: attempt.validatedTaskIDs,
      errorTag: attempt.errorTag,
      errorReasonTag: attempt.errorReasonTag,
      errorHttpStatus: attempt.errorHttpStatus,
      errorRetryable: attempt.errorRetryable,
    })),
    accounting: {
      totalCostMinor: 0,
      costMeasurement: "not_available; this candidate must not be used for promotion",
    },
    safety: {
      ...common.safety,
      network: "real-provider",
    },
  }
  await mkdir(resolve(output.absolute, ".."), { recursive: true })
  await writeFile(output.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      output: output.absolute,
      status: report.status,
      decision: report.decision,
      requestsUsed: requestCount,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      secretsPrinted: false,
    }),
  )
  if (!successful || requestCount !== MAX_REQUESTS) process.exitCode = 1
}

if (import.meta.main) await main()
