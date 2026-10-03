import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { validateStage8EvidenceContract, type Stage8EvidenceContractID } from "./stage8-evidence-contract"

const root = resolve(import.meta.dir, "..")

const CHECK_IDS = [
  "baseline_and_multi_agent_gain",
  "child_remote_capability_revocation",
  "background_task_visibility_stop_audit",
  "tenant_rls_backup_delete_drill",
  "signed_release_rollback",
] as const

type CheckID = (typeof CHECK_IDS)[number]
type EvidenceItem = {
  readonly status: "pass" | "missing" | "fail"
  readonly evidence_path?: string
  readonly sha256?: string
  readonly note?: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function argumentValue(args: ReadonlyArray<string>, flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

function repositoryPath(input: string) {
  if (isAbsolute(input)) throw new Error("evidence paths must be repository-relative")
  const absolute = resolve(root, input)
  const value = relative(root, absolute).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("evidence path must stay inside repository root")
  }
  return { absolute, relative: value }
}

function gitRevision(args: ReadonlyArray<string>) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function evidenceItem(id: CheckID, input: string | undefined): Promise<EvidenceItem> {
  if (!input) return { status: "missing", note: `${id} evidence was not supplied` }
  const path = repositoryPath(input)
  try {
    await stat(path.absolute)
    const parsed: unknown = JSON.parse(await readFile(path.absolute, "utf8"))
    if (!isRecord(parsed))
      return { status: "fail", evidence_path: path.relative, note: "evidence report is not a JSON object" }
    const status = parsed.status === "pass" ? "pass" : parsed.status === "missing" ? "missing" : "fail"
    const contractReasons =
      status === "pass"
        ? validateStage8EvidenceContract(id as Stage8EvidenceContractID, parsed)
        : []
    return {
      status: contractReasons.length > 0 ? "fail" : status,
      evidence_path: path.relative,
      sha256: await sha256(path.absolute),
      note:
        contractReasons.length > 0
          ? `evidence contract invalid: ${contractReasons.join("; ")}`
          : typeof parsed.evidence_class === "string"
            ? `source class: ${parsed.evidence_class}`
            : undefined,
    }
  } catch (error) {
    return {
      status: "missing",
      evidence_path: path.relative,
      note: error instanceof Error ? `evidence could not be read: ${error.message}` : "evidence could not be read",
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const outputInput = argumentValue(args, "--output") ?? "artifacts/stage-8-exit-evidence.json"
  const output = repositoryPath(outputInput)
  const evidence = {
    baseline_and_multi_agent_gain: await evidenceItem(
      "baseline_and_multi_agent_gain",
      argumentValue(args, "--baseline"),
    ),
    child_remote_capability_revocation: await evidenceItem(
      "child_remote_capability_revocation",
      argumentValue(args, "--capability"),
    ),
    background_task_visibility_stop_audit: await evidenceItem(
      "background_task_visibility_stop_audit",
      argumentValue(args, "--background"),
    ),
    tenant_rls_backup_delete_drill: await evidenceItem(
      "tenant_rls_backup_delete_drill",
      argumentValue(args, "--tenant"),
    ),
    signed_release_rollback: await evidenceItem("signed_release_rollback", argumentValue(args, "--signed-release")),
  } satisfies Record<CheckID, EvidenceItem>
  const missingCount = Object.values(evidence).filter((item) => item.status !== "pass").length
  const document = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    checkpoint: { commit: gitRevision(["rev-parse", "HEAD"]), tree: gitRevision(["rev-parse", "HEAD^{tree}"]) },
    evidence,
  }
  await writeFile(output.absolute, JSON.stringify(document, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      output: output.absolute,
      decision: missingCount === 0 ? "EXIT_CANDIDATE" : "DO_NOT_EXIT",
      missingCount,
    }),
  )
  if (args.includes("--require-complete") && missingCount > 0) process.exitCode = 1
}

if (import.meta.main) await main()
