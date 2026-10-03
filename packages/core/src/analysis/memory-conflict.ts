/**
 * Shared deterministic memory-conflict rules.
 *
 * MemoryV2 uses this module as its detector owner, while compatibility
 * reports can run the same rules over an in-memory fixture.  Keeping the
 * claim extraction and signature calculation here prevents a Python-shaped
 * benchmark from silently becoming a second conflict engine.
 */

import { createHash } from "node:crypto"

export type ConflictScope = "global" | "workspace"
export type ConflictBasis = "explicit-tag" | "deterministic-pattern-v1"

export interface ConflictMemory {
  readonly id: string
  readonly content: string
  readonly tags: ReadonlyArray<string>
  readonly scope: ConflictScope
  readonly project_id?: string | null
  readonly workspace_path?: string | null
}

export interface DerivedClaim {
  readonly key: string
  readonly value: string
  readonly basis: ConflictBasis
}

export interface DetectedConflict<T extends ConflictMemory = ConflictMemory> {
  readonly key: string
  readonly basis: ConflictBasis
  readonly left: T
  readonly right: T
  readonly signature: string
}

export interface ConflictDetectionReport<T extends ConflictMemory = ConflictMemory> {
  readonly items: ReadonlyArray<DetectedConflict<T>>
  readonly truncated: boolean
}

export interface ConflictBenchmarkCase {
  readonly memories: ReadonlyArray<ConflictMemory>
  readonly expectConflict: boolean
  readonly description: string
}

export interface ConflictBenchmarkCaseResult {
  readonly description: string
  readonly expect: boolean
  readonly actual: boolean
  readonly conflict_keys: ReadonlyArray<string>
  readonly verdict: "tp" | "tn" | "fp" | "fn"
}

export interface ConflictBenchmarkReport {
  readonly detection_rate: number
  readonly false_positive_rate: number
  readonly precision: number
  readonly recall: number
  readonly case_results: ReadonlyArray<ConflictBenchmarkCaseResult>
  readonly truncated: boolean
}

// Core's persisted conflict API is bounded at 500 candidates.  The legacy
// Python helper used a smaller in-memory cap, but the TS/Core owner must keep
// the durable MemoryV2 contract unchanged when it is shared by both paths.
export const MAX_CONFLICT_RESULTS = 500

const CHINESE_CLAIM_RE =
  /^(.{1,60}?(?:区域|语言|时区|端口|版本|分支|路径|目录|模型|名称|名字|邮箱|邮件|端点|环境|账号|账户|状态))\s*(?:是|为|=|：|:)\s*(.{1,200}?)[。.!]?$/u
const ENGLISH_CLAIM_RE =
  /^(?:the\s+)?(.{1,80}?(?:deployment\s+region|region|language|time\s*zone|timezone|port|version|branch|path|directory|model|name|email|endpoint|environment|account|status))\s+(?:is|equals|=|uses?)\s+(.{1,200}?)[.!]?$/i
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const KEY_WHITESPACE_UNDERSCORE_RE = /[\s_]+/g
const KEY_JUNK_RE = /[^\p{L}\p{N}.:-]+/gu
const WHITESPACE_RE = /\s+/g

export function sanitize(value: string): string {
  return value.replace(CONTROL_CHARS_RE, "").trim()
}

export function canonicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/g, "") || "/"
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

export function normalize(value: string): string {
  return sanitize(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(WHITESPACE_RE, " ").trim()
}

export function normalizeClaimKey(value: string): string {
  return sanitize(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(KEY_WHITESPACE_UNDERSCORE_RE, "-")
    .replace(KEY_JUNK_RE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
}

export function deriveClaim(row: Pick<ConflictMemory, "content" | "tags">): DerivedClaim | undefined {
  const explicit = row.tags.find((tag) => tag.toLocaleLowerCase("en-US").startsWith("fact-key:"))
  if (explicit) {
    const key = normalizeClaimKey(explicit.slice("fact-key:".length))
    const value = normalize(row.content)
    if (key && value) return { key, value, basis: "explicit-tag" }
  }

  const content = sanitize(row.content).normalize("NFKC")
  const chinese = content.match(CHINESE_CLAIM_RE)
  if (chinese?.[1] && chinese[2]) {
    const key = normalizeClaimKey(chinese[1])
    const value = normalize(chinese[2])
    if (key && value) return { key, value, basis: "deterministic-pattern-v1" }
  }

  const english = content.match(ENGLISH_CLAIM_RE)
  if (english?.[1] && english[2]) {
    const key = normalizeClaimKey(english[1])
    const value = normalize(english[2])
    if (key && value) return { key, value, basis: "deterministic-pattern-v1" }
  }
  return undefined
}

export function scopeFingerprint(row: Pick<ConflictMemory, "scope" | "project_id" | "workspace_path">): string {
  return row.scope === "global"
    ? "global"
    : `workspace:${row.project_id ?? ""}:${canonicalPath(row.workspace_path ?? "")}`
}

export function contentFingerprint(content: string): string {
  return createHash("sha256").update(normalize(content)).digest("hex")
}

export function detectConflicts<T extends ConflictMemory>(rows: ReadonlyArray<T>): ConflictDetectionReport<T> {
  const groups = new Map<string, Array<{ readonly row: T; readonly claim: DerivedClaim }>>()
  for (const row of rows) {
    const claim = deriveClaim(row)
    if (!claim) continue
    const groupKey = `${scopeFingerprint(row)}\u0000${claim.key}`
    const group = groups.get(groupKey) ?? []
    group.push({ row, claim })
    groups.set(groupKey, group)
  }

  const result: DetectedConflict<T>[] = []
  for (const group of groups.values()) {
    const sorted = group.toSorted((left, right) => left.row.id.localeCompare(right.row.id))
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex]!
        const right = sorted[rightIndex]!
        if (left.claim.value === right.claim.value) continue
        const basis =
          left.claim.basis === "explicit-tag" || right.claim.basis === "explicit-tag"
            ? "explicit-tag"
            : "deterministic-pattern-v1"
        const signature = createHash("sha256")
          .update(
            [
              scopeFingerprint(left.row),
              left.claim.key,
              left.row.id,
              contentFingerprint(left.row.content),
              right.row.id,
              contentFingerprint(right.row.content),
            ].join("\u0000"),
          )
          .digest("hex")
        if (result.length >= MAX_CONFLICT_RESULTS) return { items: result, truncated: true }
        result.push({ key: left.claim.key, basis, left: left.row, right: right.row, signature })
      }
    }
  }
  return { items: result, truncated: false }
}

const benchmarkMemory = (
  id: number,
  content: string,
  options: Partial<Pick<ConflictMemory, "tags" | "project_id" | "workspace_path" | "scope">> = {},
): ConflictMemory => ({
  id: `mem_benchmark_${id}`,
  content,
  tags: options.tags ?? [],
  project_id: options.project_id,
  workspace_path: options.workspace_path,
  scope: options.scope ?? "global",
})

export function builtinConflictSuite(): ReadonlyArray<ConflictBenchmarkCase> {
  return [
    {
      memories: [
        benchmarkMemory(1, "服务器端口是 8080", { project_id: "p1", workspace_path: "/work", scope: "workspace" }),
        benchmarkMemory(2, "服务器端口是 9090", { project_id: "p1", workspace_path: "/work", scope: "workspace" }),
      ],
      expectConflict: true,
      description: "中文模式真冲突：端口 8080 vs 9090",
    },
    {
      memories: [
        benchmarkMemory(1, "The deployment region is us-east-1"),
        benchmarkMemory(2, "deployment region is eu-west-1"),
      ],
      expectConflict: true,
      description: "英文模式真冲突：deployment region us-east-1 vs eu-west-1",
    },
    {
      memories: [
        benchmarkMemory(1, "默认模型是 gpt-4", { tags: ["fact-key:model"] }),
        benchmarkMemory(2, "默认模型是 gpt-4o", { tags: ["fact-key:model"] }),
      ],
      expectConflict: true,
      description: "显式 fact-key 标签同 key 不同值：model gpt-4 vs gpt-4o",
    },
    {
      memories: [benchmarkMemory(1, "开发语言是 Python"), benchmarkMemory(2, "开发语言是 JavaScript")],
      expectConflict: true,
      description: "中文模式真冲突：语言 Python vs JavaScript",
    },
    {
      memories: [benchmarkMemory(1, "当前版本是 1.2.0"), benchmarkMemory(2, "当前版本是 1.2.1")],
      expectConflict: true,
      description: "中文模式真冲突：版本 1.2.0 vs 1.2.1",
    },
    {
      memories: [benchmarkMemory(1, "项目时区是 Asia/Shanghai"), benchmarkMemory(2, "项目时区是 UTC")],
      expectConflict: true,
      description: "中文模式真冲突：时区 Asia/Shanghai vs UTC",
    },
    {
      memories: [
        benchmarkMemory(1, "服务器端口是 8080", { project_id: "p1", workspace_path: "/work", scope: "workspace" }),
        benchmarkMemory(2, "服务器端口是  8080", { project_id: "p1", workspace_path: "/work", scope: "workspace" }),
      ],
      expectConflict: false,
      description: "同值非冲突：端口值相同（含空白差异，验证归一化）",
    },
    {
      memories: [
        benchmarkMemory(1, "The deployment region is us-east-1"),
        benchmarkMemory(2, "deployment region is us-east-1"),
      ],
      expectConflict: false,
      description: "同值非冲突：deployment region 值相同",
    },
    {
      memories: [benchmarkMemory(1, "今天天气不错"), benchmarkMemory(2, "晚饭记得买菜")],
      expectConflict: false,
      description: "无关内容：两条均提取不到 claim",
    },
    {
      memories: [benchmarkMemory(1, "服务器端口是 8080"), benchmarkMemory(2, "请记得提交代码")],
      expectConflict: false,
      description: "无关内容：仅一条能提取 claim，无成对比较",
    },
    {
      memories: [
        benchmarkMemory(1, "服务器端口是 8080", { project_id: "p1", workspace_path: "/work", scope: "workspace" }),
        benchmarkMemory(2, "服务器端口是 9090"),
      ],
      expectConflict: false,
      description: "跨 scope 非冲突：workspace 与 global 指纹不同",
    },
    {
      memories: [benchmarkMemory(1, "项目时区是 UTC"), benchmarkMemory(2, "项目时区是 UTC")],
      expectConflict: false,
      description: "同 key 同 scope 但值相同的边界：不冲突",
    },
  ]
}

export function runConflictBenchmark(
  cases: ReadonlyArray<ConflictBenchmarkCase> = builtinConflictSuite(),
): ConflictBenchmarkReport {
  const caseResults: ConflictBenchmarkCaseResult[] = []
  let trueConflicts = 0
  let detectedTrue = 0
  let nonConflicts = 0
  let detectedFalse = 0
  let detectedTotal = 0
  let truncated = false

  for (const benchmarkCase of cases) {
    const outcome = detectConflicts(benchmarkCase.memories)
    truncated ||= outcome.truncated
    const detected = outcome.items.length > 0
    if (benchmarkCase.expectConflict) {
      trueConflicts += 1
      if (detected) {
        detectedTrue += 1
        detectedTotal += 1
      }
    } else {
      nonConflicts += 1
      if (detected) {
        detectedFalse += 1
        detectedTotal += 1
      }
    }
    const verdict =
      benchmarkCase.expectConflict && detected ? "tp" : benchmarkCase.expectConflict ? "fn" : detected ? "fp" : "tn"
    caseResults.push({
      description: benchmarkCase.description,
      expect: benchmarkCase.expectConflict,
      actual: detected,
      conflict_keys: [...new Set(outcome.items.map((item) => item.key))].toSorted(),
      verdict,
    })
  }

  const detectionRate = trueConflicts ? detectedTrue / trueConflicts : 0
  const falsePositiveRate = nonConflicts ? detectedFalse / nonConflicts : 0
  const precision = detectedTotal ? detectedTrue / detectedTotal : 0
  return {
    detection_rate: Number(detectionRate.toFixed(4)),
    false_positive_rate: Number(falsePositiveRate.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(detectionRate.toFixed(4)),
    case_results: caseResults,
    truncated,
  }
}

export const MemoryConflictAnalysis = {
  canonicalPath,
  contentFingerprint,
  deriveClaim,
  detect: detectConflicts,
  normalize,
  normalizeClaimKey,
  runBenchmark: runConflictBenchmark,
  scopeFingerprint,
  sanitize,
}
