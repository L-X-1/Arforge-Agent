import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { validateStage8EvidenceContract } from "./stage8-evidence-contract"

export const STAGE8_EXIT_CHECK_IDS = [
  "baseline_and_multi_agent_gain",
  "child_remote_capability_revocation",
  "background_task_visibility_stop_audit",
  "tenant_rls_backup_delete_drill",
  "signed_release_rollback",
] as const

export type Stage8ExitCheckID = (typeof STAGE8_EXIT_CHECK_IDS)[number]
export type Stage8EvidenceStatus = "pass" | "missing" | "fail"

export type Stage8EvidenceItem = {
  readonly status: Stage8EvidenceStatus
  readonly evidence_path?: string
  readonly sha256?: string
  readonly note?: string
}

export type Stage8ExitEvidenceDocument = {
  readonly schema_version: 1
  readonly checkpoint: {
    readonly commit: string
    readonly tree: string
  }
  readonly evidence: Record<Stage8ExitCheckID, Stage8EvidenceItem>
}

export type Stage8ExitReport = {
  readonly schema_version: 1
  readonly decision: "EXIT" | "DO_NOT_EXIT"
  readonly checkpoint: Stage8ExitEvidenceDocument["checkpoint"]
  readonly checks: ReadonlyArray<{
    readonly id: Stage8ExitCheckID
    readonly status: "pass" | "missing" | "fail"
    readonly evidence_path: string | null
    readonly digest_verified: boolean
    readonly reason: string
  }>
  readonly reasons: ReadonlyArray<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function isGitObject(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
}

function safeRelative(root: string, path: string) {
  const value = relative(root, path).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("evidence path must stay inside repository root")
  }
  return value
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function invalidDocumentReason(value: unknown): string | undefined {
  if (!isRecord(value) || value.schema_version !== 1) return "evidence document schema_version must be 1"
  const checkpoint = value.checkpoint
  if (!isRecord(checkpoint) || !isGitObject(checkpoint.commit) || !isGitObject(checkpoint.tree)) {
    return "checkpoint commit and tree must be 40-character git object IDs"
  }
  const evidence = value.evidence
  if (!isRecord(evidence)) return "evidence must be an object"
  for (const id of STAGE8_EXIT_CHECK_IDS) {
    const item = evidence[id]
    if (!isRecord(item) || (item.status !== "pass" && item.status !== "missing" && item.status !== "fail")) {
      return "evidence item is invalid: " + id
    }
  }
  return undefined
}

function decodeDocument(value: unknown): Stage8ExitEvidenceDocument {
  const reason = invalidDocumentReason(value)
  if (reason || !isRecord(value) || !isRecord(value.checkpoint) || !isRecord(value.evidence)) {
    throw new Error(reason ?? "invalid stage 8 evidence document")
  }
  const evidenceRecord = value.evidence
  const decodeItem = (id: Stage8ExitCheckID): Stage8EvidenceItem => {
    const item = evidenceRecord[id]
    if (!isRecord(item) || (item.status !== "pass" && item.status !== "missing" && item.status !== "fail")) {
      throw new Error("invalid stage 8 evidence item: " + id)
    }
    return {
      status: item.status,
      ...(typeof item.evidence_path === "string" ? { evidence_path: item.evidence_path } : {}),
      ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
      ...(typeof item.note === "string" ? { note: item.note } : {}),
    }
  }
  const evidence = {
    baseline_and_multi_agent_gain: decodeItem("baseline_and_multi_agent_gain"),
    child_remote_capability_revocation: decodeItem("child_remote_capability_revocation"),
    background_task_visibility_stop_audit: decodeItem("background_task_visibility_stop_audit"),
    tenant_rls_backup_delete_drill: decodeItem("tenant_rls_backup_delete_drill"),
    signed_release_rollback: decodeItem("signed_release_rollback"),
  }
  return {
    schema_version: 1,
    checkpoint: { commit: String(value.checkpoint.commit), tree: String(value.checkpoint.tree) },
    evidence,
  }
}

export async function auditStage8Exit(
  rootInput: string,
  document: Stage8ExitEvidenceDocument,
): Promise<Stage8ExitReport> {
  const root = resolve(rootInput)
  const checks: Array<Stage8ExitReport["checks"][number]> = []

  for (const id of STAGE8_EXIT_CHECK_IDS) {
    const item = document.evidence[id]
    if (item.status !== "pass") {
      checks.push({
        id,
        status: item.status,
        evidence_path: item.evidence_path ?? null,
        digest_verified: false,
        reason: item.note ?? "required exit evidence is not marked pass",
      })
      continue
    }
    if (!nonEmptyString(item.evidence_path) || !isSha256(item.sha256)) {
      checks.push({
        id,
        status: "fail",
        evidence_path: item.evidence_path ?? null,
        digest_verified: false,
        reason: "pass evidence requires evidence_path and SHA-256",
      })
      continue
    }
    try {
      const absolutePath = resolve(root, item.evidence_path)
      const relativePath = safeRelative(root, absolutePath)
      const metadata = await stat(absolutePath)
      if (!metadata.isFile()) throw new Error("evidence path is not a file")
      const actual = await sha256(absolutePath)
      const verified = actual.toLowerCase() === item.sha256.toLowerCase()
      if (verified) {
        const contractReasons = validateStage8EvidenceContract(id, JSON.parse(await readFile(absolutePath, "utf8")))
        if (contractReasons.length > 0) {
          checks.push({
            id,
            status: "fail",
            evidence_path: relativePath,
            digest_verified: true,
            reason: `evidence contract invalid: ${contractReasons.join("; ")}`,
          })
          continue
        }
      }
      checks.push({
        id,
        status: verified ? "pass" : "fail",
        evidence_path: relativePath,
        digest_verified: verified,
        reason: verified ? "evidence digest verified" : "evidence digest mismatch",
      })
    } catch (error) {
      checks.push({
        id,
        status: "fail",
        evidence_path: item.evidence_path,
        digest_verified: false,
        reason: error instanceof Error ? error.message : "evidence file could not be verified",
      })
    }
  }

  const reasons = checks.filter((check) => check.status !== "pass").map((check) => check.id + ": " + check.reason)
  return {
    schema_version: 1,
    decision: reasons.length === 0 ? "EXIT" : "DO_NOT_EXIT",
    checkpoint: document.checkpoint,
    checks,
    reasons,
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
  const inputPath = argumentValue(args, "--input")
  if (!inputPath) throw new Error("--input is required")
  const parsed: unknown = JSON.parse(await readFile(resolve(process.cwd(), inputPath), "utf8"))
  const document = decodeDocument(parsed)
  const report = await auditStage8Exit(process.cwd(), document)
  const outputPath = argumentValue(args, "--output")
  if (outputPath) await writeFile(resolve(process.cwd(), outputPath), JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(JSON.stringify({ decision: report.decision, failedChecks: report.reasons.length }))
  if (!args.includes("--report-only") && report.decision !== "EXIT") process.exitCode = 1
}
