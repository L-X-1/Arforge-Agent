import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type CanaryOptions = {
  readonly root?: string
  readonly baseUrl: string
  readonly artifactPath: string
  readonly rollbackArtifactDigest: string
  readonly cohortID: string
  readonly trafficPercent: number
  readonly requests?: number
  readonly timeoutMs?: number
  readonly observationDelayMs?: number
  readonly fetchImpl?: FetchLike
}

export type CanaryReceipt = {
  readonly schema_version: 1
  readonly status: "passed" | "failed"
  readonly artifact_path: string
  readonly artifact_digest: string
  readonly rollback_artifact_digest: string
  readonly cohort: {
    readonly id: string
    readonly traffic_percent: number
    readonly observation_start: number
    readonly observation_end: number
  }
  readonly target_origin: string
  readonly endpoint: "/global/health"
  readonly observed_requests: number
  readonly successful_requests: number
  readonly p95_latency_ms: number
  readonly error_budget_burn: number
  readonly critical_alerts: number
  readonly failure_reasons: ReadonlyArray<string>
}

const MAX_REQUESTS = 100
const DEFAULT_REQUESTS = 10
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_OBSERVATION_DELAY_MS = 100
const AVAILABILITY_TARGET = 0.999
const LATENCY_TARGET_MS = 750

function posixPath(path: string) {
  return path.split(sep).join("/")
}

function safeArtifactPath(root: string, path: string) {
  const value = posixPath(relative(root, path))
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("artifact path must stay inside repository root: " + path)
  }
  return "artifact/" + value
}

function validDigest(value: string) {
  return /^[0-9a-f]{64}$/i.test(value)
}

function validCount(value: number) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_REQUESTS
}

function validTimeout(value: number) {
  return Number.isSafeInteger(value) && value >= 250 && value <= 30_000
}

function validDelay(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 60_000
}

function healthEndpoint(baseUrl: string) {
  const target = new URL(baseUrl)
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new Error("canary base URL must use http or https")
  if (target.username || target.password || target.search || target.hash)
    throw new Error("canary base URL must not contain credentials, query, or fragment")
  if (target.pathname !== "/" && target.pathname !== "")
    throw new Error("canary base URL must be an origin, not an arbitrary path")
  return { origin: target.origin, endpoint: new URL("/global/health", target).toString() }
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function p95(values: ReadonlyArray<number>) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isHealthyResponse(value: unknown): boolean {
  return isRecord(value) && value.healthy === true
}

export async function runCanary(options: CanaryOptions): Promise<CanaryReceipt> {
  const root = resolve(options.root ?? process.cwd())
  const artifactAbsolutePath = resolve(root, options.artifactPath)
  const artifactMetadata = await stat(artifactAbsolutePath)
  if (!artifactMetadata.isFile()) throw new Error("canary artifact is not a file: " + artifactAbsolutePath)
  const artifactPath = safeArtifactPath(root, artifactAbsolutePath)
  const artifactDigest = await sha256(artifactAbsolutePath)
  const rollbackArtifactDigest = options.rollbackArtifactDigest.toLowerCase()
  const requests = options.requests ?? DEFAULT_REQUESTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const observationDelayMs = options.observationDelayMs ?? DEFAULT_OBSERVATION_DELAY_MS
  if (!options.cohortID.trim()) throw new Error("canary cohort ID is required")
  if (!Number.isFinite(options.trafficPercent) || options.trafficPercent <= 0 || options.trafficPercent > 100) {
    throw new Error("canary traffic percent must be greater than 0 and at most 100")
  }
  if (!validDigest(rollbackArtifactDigest) || rollbackArtifactDigest === artifactDigest) {
    throw new Error("rollback artifact digest must be a different SHA-256 digest")
  }
  if (!validCount(requests)) throw new Error("canary requests must be an integer between 1 and " + MAX_REQUESTS)
  if (!validTimeout(timeoutMs)) throw new Error("canary timeout must be between 250ms and 30000ms")
  if (!validDelay(observationDelayMs)) throw new Error("canary observation delay must be between 0ms and 60000ms")

  const target = healthEndpoint(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const observationStart = Date.now()
  const latencies: number[] = []
  const failureReasons: string[] = []
  let successfulRequests = 0

  for (let index = 0; index < requests; index += 1) {
    const requestStarted = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(target.endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
      const latency = Math.max(0, Date.now() - requestStarted)
      latencies.push(latency)
      const body: unknown = await response.json().catch(() => undefined)
      if (response.ok && isHealthyResponse(body)) successfulRequests += 1
      else failureReasons.push(response.ok ? "invalid_health_response" : "http_" + response.status)
    } catch {
      latencies.push(Math.max(0, Date.now() - requestStarted))
      failureReasons.push("request_failed_or_timed_out")
    } finally {
      clearTimeout(timer)
    }
    if (index + 1 < requests && observationDelayMs > 0) await sleep(observationDelayMs)
  }

  const observationEnd = Math.max(Date.now(), observationStart + 1)
  const p95LatencyMs = p95(latencies)
  const availability = successfulRequests / requests
  const errorBudgetBurn = Math.max(0, (1 - availability) / (1 - AVAILABILITY_TARGET))
  const criticalReasons = [...new Set(failureReasons)]
  if (p95LatencyMs > LATENCY_TARGET_MS) criticalReasons.push("p95_latency_exceeded")
  const status = criticalReasons.length === 0 ? "passed" : "failed"

  return {
    schema_version: 1,
    status,
    artifact_path: artifactPath,
    artifact_digest: artifactDigest,
    rollback_artifact_digest: rollbackArtifactDigest,
    cohort: {
      id: options.cohortID,
      traffic_percent: options.trafficPercent,
      observation_start: observationStart,
      observation_end: observationEnd,
    },
    target_origin: target.origin,
    endpoint: "/global/health",
    observed_requests: requests,
    successful_requests: successfulRequests,
    p95_latency_ms: p95LatencyMs,
    error_budget_burn: errorBudgetBurn,
    critical_alerts: status === "passed" ? 0 : 1,
    failure_reasons: [...new Set(criticalReasons)],
  }
}

function argumentValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(flag + " requires a value")
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const baseUrl = argumentValue(args, "--base-url")
  const artifactPath = argumentValue(args, "--artifact")
  const rollbackArtifactDigest = argumentValue(args, "--rollback-artifact-digest")
  const cohortID = argumentValue(args, "--cohort")
  const outputPath = argumentValue(args, "--output")
  if (!baseUrl || !artifactPath || !rollbackArtifactDigest || !cohortID || !outputPath) {
    throw new Error("--base-url, --artifact, --rollback-artifact-digest, --cohort and --output are required")
  }
  const receipt = await runCanary({
    baseUrl,
    artifactPath,
    rollbackArtifactDigest,
    cohortID,
    trafficPercent: Number(argumentValue(args, "--traffic-percent") ?? "5"),
    requests: Number(argumentValue(args, "--requests") ?? String(DEFAULT_REQUESTS)),
    timeoutMs: Number(argumentValue(args, "--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS)),
    observationDelayMs: Number(argumentValue(args, "--delay-ms") ?? String(DEFAULT_OBSERVATION_DELAY_MS)),
  })
  await writeFile(resolve(process.cwd(), outputPath), JSON.stringify(receipt, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      status: receipt.status,
      observedRequests: receipt.observed_requests,
      p95LatencyMs: receipt.p95_latency_ms,
    }),
  )
  if (receipt.status !== "passed") process.exitCode = 1
}
