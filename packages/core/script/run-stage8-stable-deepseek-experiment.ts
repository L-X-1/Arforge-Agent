import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect } from "effect"
import type { Model } from "@arforge-ai/llm"
import * as Anthropic from "@arforge-ai/llm/providers/anthropic"
import {
  BASELINE_TASK_IDS,
  CHILD_TASK_IDS,
  executeAttempt,
  MAX_TOKENS_PER_REQUEST,
  MODEL,
  runtimeLayer,
  type AttemptResult,
} from "./run-stage8-deepseek-experiment"

const root = resolve(import.meta.dir, "../../..")

export const MAX_STABLE_SAMPLES = 3
export const REQUESTS_PER_SAMPLE = 3
export const MAX_REQUESTS = MAX_STABLE_SAMPLES * REQUESTS_PER_SAMPLE
export const MAX_BUDGET_CNY = 5

type JsonRecord = Record<string, unknown>

type SampleResult = {
  readonly sample: number
  readonly baseline: AttemptResult
  readonly children: ReadonlyArray<AttemptResult>
  readonly baselineDurationMs: number
  readonly multiDurationMs: number
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

function safeErrorTag(error: unknown) {
  if (isRecord(error)) {
    if (typeof error._tag === "string") return error._tag
    if (typeof error.name === "string") return error.name
  }
  return "stable-experiment-failed"
}

function numberArgument(args: ReadonlyArray<string>, flag: string) {
  const value = argumentValue(args, flag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function endpointDetails(baseURL: string | undefined) {
  if (!baseURL) return undefined
  try {
    return new URL(baseURL)
  } catch {
    return undefined
  }
}

function sanitizeAttempt(sample: number, mode: string, attempt: AttemptResult) {
  return {
    sample,
    mode,
    id: attempt.id,
    ok: attempt.ok,
    duration_ms: attempt.durationMs,
    total_tokens: attempt.totalTokens,
    input_tokens: attempt.inputTokens,
    output_tokens: attempt.outputTokens,
    usage_available: attempt.usageAvailable,
    response_sha256: attempt.responseSha256,
    response_text_length: attempt.responseTextLength,
    reasoning_text_length: attempt.reasoningTextLength,
    tool_call_count: attempt.toolCallCount,
    finish_reason: attempt.finishReason,
    validated_task_ids: attempt.validatedTaskIDs,
    error_tag: attempt.errorTag,
    error_reason_tag: attempt.errorReasonTag,
    error_http_status: attempt.errorHttpStatus,
    error_retryable: attempt.errorRetryable,
  }
}

function mean(values: ReadonlyArray<number>) {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

async function writeReport(path: { readonly absolute: string }, report: unknown) {
  await mkdir(resolve(path.absolute, ".."), { recursive: true })
  await writeFile(path.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
}

async function runSample(model: Model, sample: number): Promise<SampleResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const baselineStartedAt = Date.now()
      const baseline = yield* executeAttempt(model, `sample-${sample}-baseline`, BASELINE_TASK_IDS)
      const baselineDurationMs = Math.max(0, Date.now() - baselineStartedAt)
      const multiStartedAt = Date.now()
      const children = yield* Effect.all(
        [
          executeAttempt(model, `sample-${sample}-child-a`, CHILD_TASK_IDS[0]),
          executeAttempt(model, `sample-${sample}-child-b`, CHILD_TASK_IDS[1]),
        ],
        { concurrency: 2 },
      )
      const multiDurationMs = Math.max(0, Date.now() - multiStartedAt)
      return { sample, baseline, children, baselineDurationMs, multiDurationMs }
    }).pipe(Effect.provide(runtimeLayer)),
  )
}

async function main() {
  const args = process.argv.slice(2)
  const output = repositoryPath(argumentValue(args, "--output") ?? "artifacts/stage8-deepseek-stable-experiment.json")
  const requestedSamples = numberArgument(args, "--samples")
  const requestedBudget = numberArgument(args, "--budget-cny")
  const baseURL = process.env.ANTHROPIC_BASE_URL
  const endpoint = endpointDetails(baseURL)
  const endpointAllowed =
    endpoint?.protocol === "https:" && endpoint.hostname === "api.deepseek.com" && endpoint.port.length === 0
  const keyAvailable = Boolean(process.env.ANTHROPIC_API_KEY)
  const datasetDigest = sha256(canonicalJson({ baseline: BASELINE_TASK_IDS, children: CHILD_TASK_IDS }))
  const requestDigest = sha256(
    canonicalJson({
      model: MODEL,
      dataset_digest: datasetDigest,
      generation: { max_tokens: MAX_TOKENS_PER_REQUEST, temperature: 0 },
      samples: MAX_STABLE_SAMPLES,
      requests: MAX_REQUESTS,
    }),
  )
  const common = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    evidence_type: "baseline_and_multi_agent_gain",
    evidence_class: "deepseek-live-experiment",
    source: "live",
    provider: "deepseek",
    model: MODEL,
    endpoint_host: endpoint?.hostname ?? "unavailable",
    dataset_digest: datasetDigest,
    request_digest: requestDigest,
    authorization: {
      max_requests: MAX_REQUESTS,
      budget_cny_limit: MAX_BUDGET_CNY,
      requested_budget_cny: requestedBudget ?? null,
      requested_samples: requestedSamples ?? null,
      max_tokens_per_request: MAX_TOKENS_PER_REQUEST,
      requests_used: 0,
    },
    safety: {
      secrets_printed: false,
      production_data_changed: false,
      staging_data_changed: false,
    },
  }

  const blockReasons: string[] = []
  if (!args.includes("--authorize-live")) blockReasons.push("explicit --authorize-live is required; no provider request was attempted")
  if (requestedSamples !== MAX_STABLE_SAMPLES) blockReasons.push(`--samples must equal ${MAX_STABLE_SAMPLES}`)
  if (requestedBudget === undefined || !Number.isFinite(requestedBudget) || requestedBudget <= 0 || requestedBudget > MAX_BUDGET_CNY) {
    blockReasons.push(`--budget-cny must be greater than 0 and no more than ${MAX_BUDGET_CNY}`)
  }
  if (!keyAvailable) blockReasons.push("ANTHROPIC_API_KEY is unavailable")
  if (!baseURL) blockReasons.push("ANTHROPIC_BASE_URL is unavailable")
  else if (!endpointAllowed) blockReasons.push("configured endpoint is not the authorized HTTPS api.deepseek.com host")

  if (blockReasons.length > 0) {
    const report = {
      ...common,
      status: "blocked",
      decision: "DO_NOT_PROMOTE",
      promotion_eligible: false,
      failure_reason: blockReasons.join("; "),
      baseline: { sampleSize: 0, succeeded: 0, mean_duration_ms: 0 },
      multi: { sampleSize: 0, succeeded: 0, mean_duration_ms: 0 },
      comparison: {
        status: "blocked",
        quantitative_gain: false,
        metric: "mean wall-clock duration in milliseconds",
      },
    }
    await writeReport(output, report)
    console.log(JSON.stringify({ output: output.absolute, status: report.status, decision: report.decision, requestsUsed: 0 }))
    process.exitCode = 1
    return
  }

  const model = Anthropic.configure({
    baseURL: baseURL!,
    generation: { maxTokens: MAX_TOKENS_PER_REQUEST, temperature: 0 },
  }).model(MODEL)
  const samples: SampleResult[] = []
  let executionFailure: string | undefined
  const startedAt = Date.now()
  for (let sample = 1; sample <= MAX_STABLE_SAMPLES; sample += 1) {
    try {
      samples.push(await runSample(model, sample))
    } catch (error) {
      executionFailure = safeErrorTag(error)
      break
    }
  }

  const baselineDurations = samples.map((sample) => sample.baselineDurationMs)
  const multiDurations = samples.map((sample) => sample.multiDurationMs)
  const baselineSucceeded = samples.filter((sample) => sample.baseline.ok).length
  const multiSucceeded = samples.filter((sample) => sample.children.every((attempt) => attempt.ok)).length
  const baselineMean = mean(baselineDurations)
  const multiMean = mean(multiDurations)
  const quantitativeGain =
    samples.length === MAX_STABLE_SAMPLES &&
    baselineSucceeded === MAX_STABLE_SAMPLES &&
    multiSucceeded === MAX_STABLE_SAMPLES &&
    multiMean < baselineMean
  const attempts = samples.flatMap((sample) => [
    sanitizeAttempt(sample.sample, "baseline", sample.baseline),
    ...sample.children.map((attempt) => sanitizeAttempt(sample.sample, "multi", attempt)),
  ])
  const requestCount = attempts.length
  const report = {
    ...common,
    status: quantitativeGain ? "pass" : "fail",
    decision: "DO_NOT_PROMOTE",
    promotion_eligible: false,
    failure_reason: quantitativeGain
      ? undefined
      : executionFailure ??
        `stable comparison did not prove a quantitative gain; samples=${samples.length}, baseline_mean_ms=${baselineMean}, multi_mean_ms=${multiMean}`,
    authorization: { ...common.authorization, requests_used: requestCount },
    dataset: {
      baseline_task_ids: BASELINE_TASK_IDS,
      child_assignments: CHILD_TASK_IDS,
    },
    baseline: {
      sampleSize: samples.length,
      succeeded: baselineSucceeded,
      mean_duration_ms: baselineMean,
      total_tokens: samples.reduce((sum, sample) => sum + sample.baseline.totalTokens, 0),
    },
    multi: {
      sampleSize: samples.length,
      succeeded: multiSucceeded,
      mean_duration_ms: multiMean,
      total_tokens: samples.reduce(
        (sum, sample) => sum + sample.children.reduce((childSum, attempt) => childSum + attempt.totalTokens, 0),
        0,
      ),
    },
    comparison: {
      status: quantitativeGain ? "pass" : "fail",
      quantitative_gain: quantitativeGain,
      metric: "mean wall-clock duration in milliseconds; lower is better",
      baseline_mean_duration_ms: baselineMean,
      multi_mean_duration_ms: multiMean,
      improvement_ms: baselineMean - multiMean,
    },
    attempts,
    accounting: {
      budget_cny_limit: MAX_BUDGET_CNY,
      total_cost_cny: null,
      cost_measurement: "provider cost was not returned; this evidence is not a billing record",
    },
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    safety: { ...common.safety, network: "real-provider" },
  }
  await writeReport(output, report)
  console.log(
    JSON.stringify({
      output: output.absolute,
      status: report.status,
      decision: report.decision,
      requestsUsed: requestCount,
      elapsedMs: report.elapsed_ms,
      secretsPrinted: false,
    }),
  )
  if (!quantitativeGain || requestCount !== MAX_REQUESTS) process.exitCode = 1
}

if (import.meta.main) await main()
