import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type JsonRecord = Record<string, unknown>

export type GovernanceFinding = {
  readonly code: string
  readonly path: string
  readonly detail: string
}

export type BootstrapValidationReport = {
  readonly schema_version: "1.0"
  readonly valid: boolean
  readonly status: string
  readonly findings: readonly GovernanceFinding[]
}

const MANIFEST_PATH = "docs/evidence/implementation/protocol-bootstrap.v1.json"
const STATE_PATH = "docs/evidence/implementation/state.json"
const CLAIM_PATH = "docs/evidence/implementation/claims/BOOTSTRAP-PROTOCOL-001.json"
const CLAIMS_ROOT = "docs/evidence/implementation/claims"
const BASELINE_PATH = "docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json"
const CARD_PATH = "docs/evidence/implementation/cards/BOOTSTRAP-PROTOCOL-001.md"
const ATTESTATION_PATH = "docs/evidence/implementation/attestations/protocol-bootstrap.v1.sha256"
const STATUS_ARTIFACT_PATH = "docs/evidence/implementation/bootstrap/status-porcelain-v2.v1.json"
const STATUS_ATTESTATION_PATH = "docs/evidence/implementation/attestations/status-porcelain-v2.v1.sha256"
const EVIDENCE_BUNDLE_PATH = "docs/evidence/implementation/bootstrap/fresh-validation-bundle.v1.json"
const EVIDENCE_ATTESTATION_PATH = "docs/evidence/implementation/attestations/fresh-validation-bundle.v1.sha256"

const EXPECTED_PATHS = {
  cards_root: "docs/evidence/implementation/cards",
  state_root: STATE_PATH,
  claims_root: "docs/evidence/implementation/claims",
  evidence_root: "docs/evidence/implementation",
} as const

const REQUIRED_VALIDATORS = ["LP-001", "LP-002", "LP-003", "LP-004"] as const
const PRE_REVIEW_CLAIM_STATUSES = ["ACTIVE", "REVIEW_PENDING", "RELEASED", "BLOCKED", "ACCEPTED"] as const
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const isSafeRelativePath = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return false
  const normalized = value.replaceAll("\\", "/")
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../")
}

const isSafePathPattern = (value: unknown): value is string => {
  if (!isSafeRelativePath(value)) return false
  const normalized = value.replaceAll("\\", "/")
  // Claim allowlists are executable policy, not prose.  Keep the grammar
  // deliberately small so a reviewer can evaluate every match.
  return !/[\s:]/.test(normalized) && !normalized.includes("//")
}

const pathPatternMatches = (pattern: string, relative: string): boolean => {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
  const normalizedPath = relative.replaceAll("\\", "/").replace(/^\.\//, "")
  const tokenized = normalizedPattern.replaceAll("**/", "\u0000").replaceAll("**", "\u0001").replaceAll("*", "\u0002")
  const escaped = tokenized.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  const expression = escaped.replaceAll("\u0000", "(?:.*/)?").replaceAll("\u0001", ".*").replaceAll("\u0002", "[^/]*")
  return new RegExp("^" + expression + "$").test(normalizedPath)
}

const resolveSafe = (root: string, relative: string) => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relative)
  const relativeToRoot = path.relative(resolvedRoot, resolved)
  if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))) return resolved
  throw new Error("path escapes repository root: " + relative)
}

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .toSorted()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    )
  }
  return JSON.stringify(value)
}

export const sha256Text = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

export class CasConflictError extends Error {
  constructor(message = "compare-and-swap state transition rejected") {
    super(message)
    this.name = "CasConflictError"
  }
}

/**
 * Performs a single-writer, compare-before-write transition. The lock directory
 * acquisition is the atomic writer election; the expected digest is compared
 * against the exact current bytes before an atomic temp-file rename.
 */
export async function compareAndSwapFile(root: string, relative: string, expectedDigest: string, nextValue: unknown): Promise<string> {
  const target = resolveSafe(root, relative)
  const lockPath = target + ".cas-lock"
  try {
    await mkdir(lockPath)
  } catch (error) {
    throw new CasConflictError("CAS writer lock is already held: " + String(error))
  }
  const temporary = target + ".cas-" + randomUUID() + ".tmp"
  try {
    const current = await readFile(target, "utf8")
    const currentDigest = sha256Text(current)
    if (currentDigest !== expectedDigest) throw new CasConflictError("expected state digest does not match current bytes")
    const nextText = JSON.stringify(nextValue, null, 2) + "\n"
    await writeFile(temporary, nextText, "utf8")
    await rename(temporary, target)
    return sha256Text(nextText)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function transitionStateWithCas(root: string, expectedDigest: string, status: string) {
  const current = JSON.parse(await readFile(resolveSafe(root, STATE_PATH), "utf8")) as JsonRecord
  const next = {
    ...current,
    state_version: typeof current.state_version === "number" ? current.state_version + 1 : 1,
    status,
    last_cas_transition_at: new Date().toISOString(),
  }
  return compareAndSwapFile(root, STATE_PATH, expectedDigest, next)
}

const addRequiredString = (
  findings: GovernanceFinding[],
  value: unknown,
  file: string,
  field: string,
): value is string => {
  if (typeof value === "string" && value.length > 0) return true
  findings.push({ code: "LP-001", path: file, detail: "required string is missing: " + field })
  return false
}

const isSha256Digest = (value: unknown): value is string => typeof value === "string" && SHA256_PATTERN.test(value)

export const validateManifest = (manifest: unknown, root: string): GovernanceFinding[] => {
  const findings: GovernanceFinding[] = []
  if (!isRecord(manifest)) {
    return [{ code: "LP-001", path: MANIFEST_PATH, detail: "manifest must be a JSON object" }]
  }

  if (manifest.schema_version !== "1.0") {
    findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "schema_version must be 1.0" })
  }
  for (const field of ["plan_revision", "source_revision", "ledger_owner", "ledger_writer", "claim_version_field", "gate_owner"]) {
    addRequiredString(findings, manifest[field], MANIFEST_PATH, field)
  }
  if (manifest.protocol !== "arforge-development-governance") {
    findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "protocol identifier is not canonical" })
  }
  if (manifest.claim_protocol !== "CAS") {
    findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "bootstrap requires CAS claim protocol" })
  }
  if (manifest.claim_version_field !== "version") {
    findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "claim_version_field must be version" })
  }
  if (!Array.isArray(manifest.pre_review_claim_whitelist) || !manifest.pre_review_claim_whitelist.includes("BOOTSTRAP-PROTOCOL-001")) {
    findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "pre_review_claim_whitelist must include the bootstrap claim" })
  } else {
    const whitelist = manifest.pre_review_claim_whitelist
    if (whitelist.some((item) => typeof item !== "string" || item.length === 0)) {
      findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "pre_review_claim_whitelist contains an invalid claim id" })
    }
    if (new Set(whitelist).size !== whitelist.length) {
      findings.push({ code: "LP-006", path: MANIFEST_PATH, detail: "pre_review_claim_whitelist contains duplicate claim ids" })
    }
  }
  for (const validator of REQUIRED_VALIDATORS) {
    if (!Array.isArray(manifest.validators) || !manifest.validators.includes(validator)) {
      findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: "required validator is missing: " + validator })
    }
  }
  for (const [field, expected] of Object.entries(EXPECTED_PATHS)) {
    const actual = manifest[field]
    if (!isSafeRelativePath(actual)) {
      findings.push({ code: "LP-002", path: MANIFEST_PATH, detail: field + " is not a safe relative path" })
    } else {
      try {
        resolveSafe(root, actual)
      } catch (error) {
        findings.push({ code: "LP-002", path: MANIFEST_PATH, detail: String(error) })
      }
    }
    if (actual !== expected) {
      findings.push({ code: "LP-001", path: MANIFEST_PATH, detail: field + " must equal " + expected })
    }
  }
  const detached = asString(manifest.detached_attestation_ref)
  if (!detached || detached !== ATTESTATION_PATH || !isSafeRelativePath(detached)) {
    findings.push({ code: "LP-002", path: MANIFEST_PATH, detail: "detached attestation path is not canonical or safe" })
  } else {
    try {
      resolveSafe(root, detached)
    } catch (error) {
      findings.push({ code: "LP-002", path: MANIFEST_PATH, detail: String(error) })
    }
  }
  return findings
}

export const validateClaim = (
  claim: unknown,
  manifest: JsonRecord,
  state: JsonRecord,
  root: string,
  claimPath = CLAIM_PATH,
  expectedClaimId?: string,
): GovernanceFinding[] => {
  const findings: GovernanceFinding[] = []
  if (!isRecord(claim)) return [{ code: "LP-006", path: claimPath, detail: "claim must be a JSON object" }]
  if (claim.schema_version !== "1.0") findings.push({ code: "LP-006", path: claimPath, detail: "claim schema_version must be 1.0" })
  if (expectedClaimId && claim.claim_id !== expectedClaimId) {
    findings.push({ code: "LP-006", path: claimPath, detail: "unexpected claim id" })
  }
  if (!PRE_REVIEW_CLAIM_STATUSES.includes(claim.status as (typeof PRE_REVIEW_CLAIM_STATUSES)[number])) {
    findings.push({ code: "LP-006", path: claimPath, detail: "claim status is not a recognized pre-review state" })
  }
  if (typeof claim.version !== "number" || !Number.isSafeInteger(claim.version) || claim.version < 1) {
    findings.push({ code: "LP-006", path: claimPath, detail: "claim version must be a positive integer" })
  }
  if (claim.owner !== manifest.ledger_writer) {
    findings.push({ code: "LP-006", path: claimPath, detail: "claim owner must equal manifest ledger_writer" })
  }
  if (claim.protocol_manifest !== MANIFEST_PATH) {
    findings.push({ code: "LP-006", path: claimPath, detail: "claim protocol_manifest is not canonical" })
  }
  const expectedManifestDigest = sha256Text(canonicalJson(manifest))
  if (claim.protocol_manifest_digest !== expectedManifestDigest) {
    findings.push({ code: "LP-004", path: claimPath, detail: "claim protocol_manifest_digest does not match normalized manifest bytes" })
  }
  if (claim.baseline_manifest !== BASELINE_PATH) {
    findings.push({ code: "LP-006", path: claimPath, detail: "claim baseline_manifest is not canonical" })
  }
  const stateClaim = isRecord(state.active_claim) ? state.active_claim : undefined
  const statePendingClaims = Array.isArray(state.review_pending_claims) ? state.review_pending_claims : []
  const matches = (reference: unknown) =>
    isRecord(reference) &&
    reference.claim_id === claim.claim_id &&
    reference.version === claim.version &&
    (reference.claim_path === undefined || reference.claim_path === claimPath)
  if (claim.status === "ACTIVE" && !matches(stateClaim)) {
    findings.push({ code: "LP-006", path: claimPath, detail: "state active_claim does not match ACTIVE claim record" })
  }
  if (claim.status === "REVIEW_PENDING" && !statePendingClaims.some(matches)) {
    findings.push({ code: "LP-006", path: claimPath, detail: "REVIEW_PENDING claim is not recorded in state.review_pending_claims" })
  }
  const stateAcceptedClaims = Array.isArray(state.accepted_claims) ? state.accepted_claims : []
  if (claim.status === "ACCEPTED" && !stateAcceptedClaims.some(matches)) {
    findings.push({ code: "LP-006", path: claimPath, detail: "ACCEPTED claim is not recorded in state.accepted_claims" })
  }
  const whitelist = Array.isArray(manifest.pre_review_claim_whitelist) ? manifest.pre_review_claim_whitelist : []
  if (typeof claim.claim_id !== "string" || !whitelist.includes(claim.claim_id)) {
    findings.push({ code: "LP-003", path: claimPath, detail: "claim id is not in the pre-review whitelist" })
  }
  const paths = claim.allowed_paths
  if (!Array.isArray(paths) || paths.length === 0) {
    findings.push({ code: "LP-002", path: claimPath, detail: "claim allowed_paths must be non-empty" })
  } else {
    for (const item of paths) {
      if (typeof item !== "string" || !isSafePathPattern(item)) {
        findings.push({ code: "LP-002", path: claimPath, detail: "claim contains an unsafe or non-canonical allowed path pattern" })
        continue
      }
      try {
        resolveSafe(root, item)
      } catch (error) {
        findings.push({ code: "LP-002", path: claimPath, detail: String(error) })
      }
    }
  }
  return findings
}

const readJson = async (root: string, relative: string, findings: GovernanceFinding[]): Promise<unknown | undefined> => {
  try {
    const file = resolveSafe(root, relative)
    return JSON.parse(await readFile(file, "utf8")) as unknown
  } catch (error) {
    findings.push({ code: "LP-001", path: relative, detail: "cannot read valid JSON: " + String(error) })
    return undefined
  }
}

const fileDigest = async (root: string, relative: string, findings: GovernanceFinding[]) => {
  try {
    return sha256Text(await readFile(resolveSafe(root, relative), "utf8"))
  } catch (error) {
    findings.push({ code: "LP-004", path: relative, detail: "cannot hash evidence file: " + String(error) })
    return undefined
  }
}

type StatusEntry = {
  readonly raw: string
  readonly path: string
  readonly ownership: "preexisting-user-dirty" | "card-owned"
  readonly card_id?: string
  readonly card_ids?: readonly string[]
}

const canonicalStatusEntries = (root: string): StatusEntry[] => {
  const output = execFileSync("git", ["status", "--porcelain=v2", "--untracked-files=all"], { cwd: root, encoding: "utf8" })
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0).toSorted()
  return lines.map((raw) => {
    const tabParts = raw.split("\t")
    const candidate = tabParts.at(-1) ?? raw
    const pathValue = tabParts.length > 1 ? candidate : raw.split(/\s+/).at(-1) ?? raw
    return { raw, path: pathValue.replaceAll("\\", "/"), ownership: "preexisting-user-dirty" }
  })
}

const baselineCoversPath = (baseline: JsonRecord, relative: string) => {
  const generatedPaths = new Set<string>([
    ...(Array.isArray(baseline.target_paths) ? baseline.target_paths.filter((value): value is string => typeof value === "string") : []),
    ...(Array.isArray(baseline.dispatcher_artifacts) ? baseline.dispatcher_artifacts.filter(isRecord).map((value) => value.path).filter((value): value is string => typeof value === "string") : []),
  ])
  if (generatedPaths.has(relative)) return false
  const entries = Array.isArray(baseline.entries) ? baseline.entries : []
  return entries.some((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") return false
    const normalized = entry.path.replaceAll("\\", "/").replace(/\/+$/, "")
    // The evidence root existed before this dispatcher and is intentionally a
    // directory baseline entry, but generated children are governed by claim
    // allowlists/dispatcher_artifacts. Do not let the parent directory hide
    // an unauthorized new evidence file.
    if (normalized === "docs/evidence/implementation") return false
    return normalized === relative || (entry.kind === "directory" && relative.startsWith(normalized + "/"))
  })
}

const readCardAllowlists = async (root: string, manifest: JsonRecord): Promise<Map<string, readonly string[]>> => {
  const result = new Map<string, readonly string[]>()
  const whitelist = Array.isArray(manifest.pre_review_claim_whitelist) ? manifest.pre_review_claim_whitelist : []
  for (const claimId of whitelist) {
    if (typeof claimId !== "string") continue
    try {
      const claim = JSON.parse(await readFile(resolveSafe(root, CLAIMS_ROOT + "/" + claimId + ".json"), "utf8")) as JsonRecord
      const paths = Array.isArray(claim.allowed_paths) ? claim.allowed_paths.filter((value): value is string => typeof value === "string" && isSafePathPattern(value)) : []
      result.set(claimId, paths)
    } catch {
      // Structural claim validation reports the missing/invalid claim.  The
      // status artifact must not fall back to a path-name heuristic.
    }
  }
  return result
}

const allowedCardIdsForPath = (relative: string, allowlists: Map<string, readonly string[]>): string[] => {
  return [...allowlists.entries()]
    .filter(([, patterns]) => patterns.some((pattern) => pathPatternMatches(pattern, relative)))
    .map(([claimId]) => claimId)
    .toSorted()
}

const statusArtifactValue = async (root: string, baseline: JsonRecord) => {
  const rawEntries = canonicalStatusEntries(root)
  const manifest = JSON.parse(await readFile(resolveSafe(root, MANIFEST_PATH), "utf8")) as JsonRecord
  const allowlists = await readCardAllowlists(root, manifest)
  const entries = rawEntries.map((entry) => {
    if (baselineCoversPath(baseline, entry.path)) return { ...entry, ownership: "preexisting-user-dirty" as const }
    const cardIds = allowedCardIdsForPath(entry.path, allowlists)
    if (cardIds.length === 0) return { ...entry, ownership: "preexisting-user-dirty" as const }
    return {
      ...entry,
      ownership: "card-owned" as const,
      ...(cardIds.length === 1 ? { card_id: cardIds[0] } : {}),
      card_ids: cardIds,
    }
  })
  const unexpectedPaths = entries.filter((entry) => !baselineCoversPath(baseline, entry.path) && entry.ownership !== "card-owned").map((entry) => entry.path)
  return {
    schema_version: "1.0",
    format: "git-status-porcelain-v2",
    repository_root: root,
    captured_at_utc: new Date().toISOString(),
    status_digest: sha256Text(canonicalJson(entries.map(({ raw, path: entryPath, ownership, card_id, card_ids }) => ({ raw, path: entryPath, ownership, card_id, card_ids })))),
    entry_count: entries.length,
    entries,
    unexpected_paths: [...new Set(unexpectedPaths)].toSorted(),
  }
}

const isGitRepository = (root: string) => {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" }).trim() === "true"
  } catch {
    return false
  }
}

export async function writeBootstrapStatusArtifact(root: string) {
  const baseline = JSON.parse(await readFile(resolveSafe(root, BASELINE_PATH), "utf8")) as JsonRecord
  const artifact = await statusArtifactValue(root, baseline)
  await mkdir(resolveSafe(root, path.dirname(STATUS_ARTIFACT_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(STATUS_ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, STATUS_ARTIFACT_PATH), JSON.stringify(artifact, null, 2) + "\n")
  const digest = sha256Text(canonicalJson(artifact))
  await writeFile(resolveSafe(root, STATUS_ATTESTATION_PATH), "sha256:" + digest + "\n")
  return { path: STATUS_ARTIFACT_PATH, entry_count: artifact.entry_count, status_digest: artifact.status_digest, artifact_digest: digest, unexpected_paths: artifact.unexpected_paths }
}

type EvidenceCommandSpec = {
  readonly id: string
  readonly card_id: string
  readonly phase: string
  readonly command: string
  readonly args: readonly string[]
  readonly scope: string
}

const executeEvidenceCommand = (root: string, spec: EvidenceCommandSpec) => {
  const startedAt = new Date().toISOString()
  const result = spawnSync("bun", spec.args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  const exitCode = typeof result.status === "number" ? result.status : 1
  const output = [result.stdout, result.stderr, result.error?.message].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n")
  const finishedAt = new Date().toISOString()
  return {
    id: spec.id,
    card_id: spec.card_id,
    phase: spec.phase,
    command: spec.command,
    cwd: root,
    scope: spec.scope,
    attempt: 1,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: exitCode,
    output,
    output_digest: sha256Text(output),
    output_artifact_ref: EVIDENCE_BUNDLE_PATH + "#" + spec.id,
  }
}

const freshEvidenceSpecs = (): EvidenceCommandSpec[] => [
  { id: "B-FRESH-001", card_id: "BOOTSTRAP-PROTOCOL-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-governance.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-governance.test.ts"], scope: "bootstrap validator and CAS tests" },
  { id: "B-FRESH-002", card_id: "BOOTSTRAP-PROTOCOL-001", phase: "static", command: "bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-governance.ts script/arforge-governance.test.ts", args: ["x", "tsc", "--noEmit", "--module", "ESNext", "--moduleResolution", "Bundler", "--target", "ES2023", "--lib", "ES2023", "--typeRoots", "packages/core/node_modules/@types", "--skipLibCheck", "script/arforge-governance.ts", "script/arforge-governance.test.ts"], scope: "bootstrap TypeScript" },
  { id: "O-FRESH-001", card_id: "PY-001-OWNER-REGISTRY-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-owner-registry.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-owner-registry.test.ts"], scope: "owner AST and source safety" },
  { id: "O-FRESH-002", card_id: "PY-001-OWNER-REGISTRY-001", phase: "validator", command: "bun run script/arforge-owner-registry.ts validate-owner-registry --root .", args: ["run", "script/arforge-owner-registry.ts", "validate-owner-registry", "--root", "."], scope: "owner registry" },
  { id: "P-FRESH-001", card_id: "PY-002-CAPABILITY-LEDGER-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-ledger.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-python-ledger.test.ts"], scope: "capability reverse consumers" },
  { id: "P-FRESH-002", card_id: "PY-002-CAPABILITY-LEDGER-001", phase: "validator", command: "bun run script/arforge-python-ledger.ts validate-python-ledger --root .", args: ["run", "script/arforge-python-ledger.ts", "validate-python-ledger", "--root", "."], scope: "capability ledger" },
  { id: "T-FRESH-001", card_id: "PY-005-TEST-FIXTURE-LEDGER-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-tests-ledger.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-python-tests-ledger.test.ts"], scope: "test scope and owner classification" },
  { id: "T-FRESH-002", card_id: "PY-005-TEST-FIXTURE-LEDGER-001", phase: "validator", command: "bun run script/arforge-python-tests-ledger.ts validate-python-tests-ledger --root .", args: ["run", "script/arforge-python-tests-ledger.ts", "validate-python-tests-ledger", "--root", "."], scope: "test fixture ledger" },
  { id: "D-FRESH-001", card_id: "PY-007-DEPENDENCY-ARTIFACT-LEDGER-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-python-dependencies-ledger.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-python-dependencies-ledger.test.ts"], scope: "dependency explicit roots" },
  { id: "D-FRESH-002", card_id: "PY-007-DEPENDENCY-ARTIFACT-LEDGER-001", phase: "validator", command: "bun run script/arforge-python-dependencies-ledger.ts validate-python-dependencies-ledger --root .", args: ["run", "script/arforge-python-dependencies-ledger.ts", "validate-python-dependencies-ledger", "--root", "."], scope: "dependency and asset ledger" },
  { id: "TS-FRESH-001", card_id: "PY-101-TS-COMPOSITION-001", phase: "targeted", command: "bun test --config E:/Arforge-Agent/script/bunfig.toml E:/Arforge-Agent/script/arforge-ts-composition-ledger.test.ts", args: ["test", "--config", "E:/Arforge-Agent/script/bunfig.toml", "E:/Arforge-Agent/script/arforge-ts-composition-ledger.test.ts"], scope: "TS composition topology and negative bypass tests" },
  { id: "TS-FRESH-002", card_id: "PY-101-TS-COMPOSITION-001", phase: "validator", command: "bun run script/arforge-ts-composition-ledger.ts validate-ts-composition-ledger --root .", args: ["run", "script/arforge-ts-composition-ledger.ts", "validate-ts-composition-ledger", "--root", "."], scope: "deterministic TS composition artifact" },
  { id: "TS-FRESH-003", card_id: "PY-101-TS-COMPOSITION-001", phase: "static", command: "bunx tsc --noEmit --module ESNext --moduleResolution Bundler --target ES2023 --lib ES2023 --typeRoots packages/core/node_modules/@types --skipLibCheck script/arforge-ts-composition-ledger.ts script/arforge-ts-composition-ledger.test.ts", args: ["x", "tsc", "--noEmit", "--module", "ESNext", "--moduleResolution", "Bundler", "--target", "ES2023", "--lib", "ES2023", "--typeRoots", "packages/core/node_modules/@types", "--skipLibCheck", "script/arforge-ts-composition-ledger.ts", "script/arforge-ts-composition-ledger.test.ts"], scope: "TS composition TypeScript" },
  { id: "B-FRESH-003", card_id: "BOOTSTRAP-PROTOCOL-001", phase: "validator", command: "bun run script/arforge-governance.ts validate-bootstrap --root .", args: ["run", "script/arforge-governance.ts", "validate-bootstrap", "--root", "."], scope: "full bootstrap gate" },
]

export async function writeFreshEvidenceBundle(root: string) {
  const stateText = await readFile(resolveSafe(root, STATE_PATH), "utf8")
  const stateDigest = sha256Text(stateText)
  const state = JSON.parse(stateText) as JsonRecord
  const historical = Array.isArray(state.evidence_runs) ? state.evidence_runs : []
  const specs = freshEvidenceSpecs()
  const results = specs.slice(0, -1).map((spec) => executeEvidenceCommand(root, spec))
  const pending = { ...executeEvidenceCommand(root, specs.at(-1)!), output: "pending bootstrap evidence", output_digest: sha256Text("pending bootstrap evidence") }
  const provisionalCommands = [...results, pending]
  const provisionalBundle = { schema_version: "1.0", bundle_id: "fresh-validation-bundle-v1", generated_at_utc: new Date().toISOString(), commands: provisionalCommands }
  const evidenceRuns = provisionalCommands.map(({ output, ...command }) => command)
  const nextState = { ...state, historical_evidence_runs: historical, evidence_runs: evidenceRuns, evidence_bundle_ref: EVIDENCE_BUNDLE_PATH, evidence_bundle_digest: sha256Text(canonicalJson(provisionalBundle)) }
  await mkdir(resolveSafe(root, path.dirname(EVIDENCE_BUNDLE_PATH)), { recursive: true })
  await mkdir(resolveSafe(root, path.dirname(EVIDENCE_ATTESTATION_PATH)), { recursive: true })
  await writeFile(resolveSafe(root, EVIDENCE_BUNDLE_PATH), JSON.stringify(provisionalBundle, null, 2) + "\n")
  await writeFile(resolveSafe(root, EVIDENCE_ATTESTATION_PATH), "sha256:" + sha256Text(canonicalJson(provisionalBundle)) + "\n")
  const provisionalStateDigest = await compareAndSwapFile(root, STATE_PATH, stateDigest, nextState)
  await writeBootstrapStatusArtifact(root)
  const bootstrap = executeEvidenceCommand(root, specs.at(-1)!)
  const commands = [...results, bootstrap]
  const bundle = { schema_version: "1.0", bundle_id: "fresh-validation-bundle-v1", generated_at_utc: new Date().toISOString(), commands }
  const finalRuns = commands.map(({ output, ...command }) => command)
  const finalState = { ...nextState, evidence_runs: finalRuns, evidence_bundle_digest: sha256Text(canonicalJson(bundle)) }
  await writeFile(resolveSafe(root, EVIDENCE_BUNDLE_PATH), JSON.stringify(bundle, null, 2) + "\n")
  await writeFile(resolveSafe(root, EVIDENCE_ATTESTATION_PATH), "sha256:" + sha256Text(canonicalJson(bundle)) + "\n")
  await compareAndSwapFile(root, STATE_PATH, provisionalStateDigest, finalState)
  await writeBootstrapStatusArtifact(root)
  return { command_count: commands.length, evidence_bundle_digest: sha256Text(canonicalJson(bundle)), bootstrap_exit_code: bootstrap.exit_code }
}

const validateStatusArtifact = async (root: string, baseline: JsonRecord, findings: GovernanceFinding[]) => {
  let artifact: JsonRecord
  try {
    artifact = JSON.parse(await readFile(resolveSafe(root, STATUS_ARTIFACT_PATH), "utf8")) as JsonRecord
  } catch (error) {
    findings.push({ code: "LP-014", path: STATUS_ARTIFACT_PATH, detail: "cannot read canonical porcelain-v2 status artifact: " + String(error) })
    return
  }
  const expected = await statusArtifactValue(root, baseline)
  if (artifact.status_digest !== expected.status_digest || artifact.entry_count !== expected.entry_count || canonicalJson(artifact.entries) !== canonicalJson(expected.entries)) {
    findings.push({ code: "LP-014", path: STATUS_ARTIFACT_PATH, detail: "status artifact is stale or does not match current canonical porcelain-v2 output" })
  }
  if (!Array.isArray(artifact.unexpected_paths) || artifact.unexpected_paths.length !== 0) findings.push({ code: "LP-014", path: STATUS_ARTIFACT_PATH, detail: "status artifact contains paths outside baseline or explicit card ownership" })
  try {
    const attestation = (await readFile(resolveSafe(root, STATUS_ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + sha256Text(canonicalJson(artifact))) findings.push({ code: "LP-014", path: STATUS_ATTESTATION_PATH, detail: "status artifact attestation does not match" })
  } catch (error) {
    findings.push({ code: "LP-014", path: STATUS_ATTESTATION_PATH, detail: "cannot read status artifact attestation: " + String(error) })
  }
}

const validateBaselineFilesystem = async (root: string, baseline: JsonRecord, findings: GovernanceFinding[]) => {
  const entries = Array.isArray(baseline.entries) ? baseline.entries : []
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isSafeRelativePath(entry.path)) continue
    const file = BASELINE_PATH + ".entries[" + index + "]"
    try {
      const info = await stat(resolveSafe(root, entry.path))
      if (entry.kind === "directory") {
        if (!info.isDirectory()) findings.push({ code: "LP-015", path: file, detail: "baseline directory entry no longer resolves to a directory" })
        continue
      }
      if (!info.isFile()) {
        findings.push({ code: "LP-015", path: file, detail: "baseline file entry no longer resolves to a file" })
        continue
      }
      const bytes = await readFile(resolveSafe(root, entry.path))
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (digest !== entry.content_digest || bytes.byteLength !== entry.size) findings.push({ code: "LP-015", path: file, detail: "baseline file digest or size drifted" })
    } catch (error) {
      findings.push({ code: "LP-015", path: file, detail: "baseline entry is missing: " + String(error) })
    }
  }
}

const validateEvidenceBundle = async (root: string, state: JsonRecord, findings: GovernanceFinding[]) => {
  let bundle: JsonRecord
  try {
    bundle = JSON.parse(await readFile(resolveSafe(root, EVIDENCE_BUNDLE_PATH), "utf8")) as JsonRecord
  } catch (error) {
    findings.push({ code: "LP-016", path: EVIDENCE_BUNDLE_PATH, detail: "cannot read fresh validation evidence bundle: " + String(error) })
    return
  }
  const rawCommands = Array.isArray(bundle.commands) ? bundle.commands : []
  if (bundle.schema_version !== "1.0" || bundle.bundle_id !== "fresh-validation-bundle-v1") {
    findings.push({ code: "LP-016", path: EVIDENCE_BUNDLE_PATH, detail: "fresh evidence bundle identity is not canonical" })
  }
  const commands = rawCommands.filter(isRecord)
  if (commands.length !== rawCommands.length || commands.length === 0) {
    findings.push({ code: "LP-016", path: EVIDENCE_BUNDLE_PATH, detail: "bundle.commands must be a non-empty array of command records" })
  }
  const commandIds = commands.map((command) => (typeof command.id === "string" ? command.id : ""))
  if (commandIds.some((id) => id.length === 0) || new Set(commandIds).size !== commandIds.length) {
    findings.push({ code: "LP-016", path: EVIDENCE_BUNDLE_PATH, detail: "bundle command ids must be unique non-empty strings" })
  }
  const byId = new Map(commands.map((command) => [typeof command.id === "string" ? command.id : "", command]))
  for (const [index, command] of commands.entries()) {
    const file = EVIDENCE_BUNDLE_PATH + ".commands[" + index + "]"
    for (const field of ["id", "card_id", "phase", "command", "cwd", "scope", "started_at", "finished_at", "output", "output_digest", "output_artifact_ref"]) {
      if (typeof command[field] !== "string") findings.push({ code: "LP-016", path: file, detail: "bundle command missing required field: " + field })
    }
    if (typeof command.attempt !== "number" || !Number.isSafeInteger(command.attempt) || command.attempt < 1) {
      findings.push({ code: "LP-016", path: file, detail: "bundle command attempt must be a positive integer" })
    }
    if (typeof command.exit_code !== "number" || !Number.isSafeInteger(command.exit_code)) {
      findings.push({ code: "LP-016", path: file, detail: "bundle command exit_code must be an integer" })
    }
    const started = Date.parse(String(command.started_at ?? ""))
    const finished = Date.parse(String(command.finished_at ?? ""))
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      findings.push({ code: "LP-016", path: file, detail: "bundle command timestamps are not ordered ISO timestamps" })
    }
    if (!isSha256Digest(command.output_digest) || (typeof command.output === "string" && sha256Text(command.output) !== command.output_digest)) {
      findings.push({ code: "LP-016", path: file, detail: "bundle command output_digest does not match command.output bytes" })
    }
    const expectedRef = EVIDENCE_BUNDLE_PATH + "#" + String(command.id ?? "")
    if (command.output_artifact_ref !== expectedRef) {
      findings.push({ code: "LP-016", path: file, detail: "bundle command output_artifact_ref is not canonical" })
    }
  }
  const evidenceRuns = Array.isArray(state.evidence_runs) ? state.evidence_runs.filter(isRecord) : []
  if (evidenceRuns.length === 0) findings.push({ code: "LP-016", path: STATE_PATH, detail: "state.evidence_runs must contain fresh evidence records" })
  if (state.evidence_bundle_ref !== EVIDENCE_BUNDLE_PATH) {
    findings.push({ code: "LP-016", path: STATE_PATH, detail: "state.evidence_bundle_ref is not bound to the canonical evidence bundle" })
  }
  const bundleDigest = sha256Text(canonicalJson(bundle))
  if (state.evidence_bundle_digest !== bundleDigest) {
    findings.push({ code: "LP-016", path: STATE_PATH, detail: "state.evidence_bundle_digest does not match current bundle bytes" })
  }
  if (evidenceRuns.length !== commands.length || new Set(evidenceRuns.map((run) => String(run.id ?? ""))).size !== evidenceRuns.length || evidenceRuns.some((run) => !byId.has(String(run.id ?? "")))) {
    findings.push({ code: "LP-016", path: STATE_PATH, detail: "state.evidence_runs must be a one-to-one projection of bundle.commands" })
  }
  for (const [index, run] of evidenceRuns.entries()) {
    const file = STATE_PATH + ".evidence_runs[" + index + "]"
    for (const field of ["id", "phase", "started_at", "finished_at", "output_artifact_ref", "output_digest", "card_id", "scope"]) {
      if (typeof run[field] !== "string" || run[field].length === 0) findings.push({ code: "LP-016", path: file, detail: "evidence run missing required field: " + field })
    }
    if (typeof run.attempt !== "number" || !Number.isSafeInteger(run.attempt) || run.attempt < 1) findings.push({ code: "LP-016", path: file, detail: "evidence run attempt must be a positive integer" })
    const started = Date.parse(String(run.started_at ?? ""))
    const finished = Date.parse(String(run.finished_at ?? ""))
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) findings.push({ code: "LP-016", path: file, detail: "evidence run timestamps are not ordered ISO timestamps" })
    if (!isSha256Digest(run.output_digest)) findings.push({ code: "LP-016", path: file, detail: "evidence run output_digest must be SHA-256" })
    const ref = typeof run.output_artifact_ref === "string" ? run.output_artifact_ref : ""
    const prefix = EVIDENCE_BUNDLE_PATH + "#"
    const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : ""
    const command = byId.get(id)
    if (!command) findings.push({ code: "LP-016", path: file, detail: "evidence output_artifact_ref does not resolve to a bundle command" })
    else if (command.output_digest !== run.output_digest || command.card_id !== run.card_id || command.id !== run.id || command.output_artifact_ref !== run.output_artifact_ref) findings.push({ code: "LP-016", path: file, detail: "evidence run is not byte-bound to its bundle command" })
  }
  try {
    const attestation = (await readFile(resolveSafe(root, EVIDENCE_ATTESTATION_PATH), "utf8")).trim()
    if (attestation !== "sha256:" + sha256Text(canonicalJson(bundle))) findings.push({ code: "LP-016", path: EVIDENCE_ATTESTATION_PATH, detail: "fresh evidence bundle attestation does not match" })
  } catch (error) {
    findings.push({ code: "LP-016", path: EVIDENCE_ATTESTATION_PATH, detail: "cannot read fresh evidence bundle attestation: " + String(error) })
  }
}

const validateStateCardReference = async (
  root: string,
  reference: unknown,
  file: string,
  findings: GovernanceFinding[],
) => {
  if (!isRecord(reference)) {
    findings.push({ code: "LP-004", path: file, detail: "state card reference must be an object" })
    return
  }
  const cardPath = asString(reference.card_path)
  if (!cardPath || !isSafeRelativePath(cardPath) || !cardPath.startsWith("docs/evidence/implementation/cards/")) {
    findings.push({ code: "LP-002", path: file, detail: "state card reference must point inside the canonical cards root" })
    return
  }
  const expectedDigest = reference.card_digest
  if (!isSha256Digest(expectedDigest)) {
    findings.push({ code: "LP-004", path: file, detail: "state card reference must include a SHA-256 card_digest" })
    return
  }
  const actualDigest = await fileDigest(root, cardPath, findings)
  if (actualDigest && actualDigest !== expectedDigest) {
    findings.push({ code: "LP-004", path: file, detail: "state card_digest does not match referenced card bytes" })
  }
}

export async function validateBootstrap(root: string): Promise<BootstrapValidationReport> {
  const findings: GovernanceFinding[] = []
  const manifest = await readJson(root, MANIFEST_PATH, findings)
  findings.push(...validateManifest(manifest, root))
  const state = await readJson(root, STATE_PATH, findings)
  const claim = await readJson(root, CLAIM_PATH, findings)
  const baseline = await readJson(root, BASELINE_PATH, findings)

  if (isRecord(state)) {
    if (state.schema_version !== "1.0") findings.push({ code: "LP-001", path: STATE_PATH, detail: "state schema_version must be 1.0" })
    if (state.manifest_path !== MANIFEST_PATH) findings.push({ code: "LP-001", path: STATE_PATH, detail: "state manifest_path is not canonical" })
    if (state.card_path !== CARD_PATH) findings.push({ code: "LP-001", path: STATE_PATH, detail: "state card_path is not canonical" })
    if (state.status !== "REVIEW_PENDING") {
      findings.push({ code: "LP-006", path: STATE_PATH, detail: "bootstrap must remain REVIEW_PENDING until independent review" })
    }
    if (isRecord(manifest)) {
      for (const [field, expected] of Object.entries(EXPECTED_PATHS)) {
        const statePaths = isRecord(state.canonical_paths) ? state.canonical_paths : undefined
        if (!statePaths || statePaths[field] !== expected) {
          findings.push({ code: "LP-001", path: STATE_PATH, detail: "state canonical path mismatch: " + field })
        }
      }
      findings.push(...validateClaim(claim, manifest, state, root, CLAIM_PATH, "BOOTSTRAP-PROTOCOL-001"))

      if (isRecord(state.active_card)) {
        await validateStateCardReference(root, state.active_card, STATE_PATH + ".active_card", findings)
      }

      const activeClaim = isRecord(state.active_claim) ? state.active_claim : undefined
      if (activeClaim && activeClaim.claim_id !== "BOOTSTRAP-PROTOCOL-001") {
        await validateStateCardReference(root, activeClaim, STATE_PATH + ".active_claim", findings)
        const activePath = asString(activeClaim.claim_path)
        if (!activePath || !isSafeRelativePath(activePath) || !activePath.startsWith(CLAIMS_ROOT + "/")) {
          findings.push({ code: "LP-002", path: STATE_PATH, detail: "active claim path must be inside the canonical claims root" })
        } else {
          const activeRecord = await readJson(root, activePath, findings)
          findings.push(...validateClaim(activeRecord, manifest, state, root, activePath, activeClaim.claim_id as string))
        }
      }
      if (Array.isArray(state.review_pending_claims)) {
        for (const [index, pending] of state.review_pending_claims.entries()) {
          if (!isRecord(pending) || pending.claim_id === "BOOTSTRAP-PROTOCOL-001") continue
          const pendingPath = asString(pending.claim_path)
          const pendingFile = STATE_PATH + ".review_pending_claims[" + index + "]"
          if (!pendingPath || !isSafeRelativePath(pendingPath) || !pendingPath.startsWith(CLAIMS_ROOT + "/")) {
            findings.push({ code: "LP-002", path: pendingFile, detail: "review-pending claim path must be inside the canonical claims root" })
          } else {
            await validateStateCardReference(root, pending, pendingFile, findings)
            const pendingRecord = await readJson(root, pendingPath, findings)
            findings.push(...validateClaim(pendingRecord, manifest, state, root, pendingPath, pending.claim_id as string))
          }
        }
      }
      if (Array.isArray(state.accepted_claims)) {
        for (const [index, accepted] of state.accepted_claims.entries()) {
          if (!isRecord(accepted) || accepted.claim_id === "BOOTSTRAP-PROTOCOL-001") continue
          const acceptedPath = asString(accepted.claim_path)
          const acceptedFile = STATE_PATH + ".accepted_claims[" + index + "]"
          if (!acceptedPath || !isSafeRelativePath(acceptedPath) || !acceptedPath.startsWith(CLAIMS_ROOT + "/")) {
            findings.push({ code: "LP-002", path: acceptedFile, detail: "accepted claim path must be inside the canonical claims root" })
          } else {
            await validateStateCardReference(root, accepted, acceptedFile, findings)
            const acceptedRecord = await readJson(root, acceptedPath, findings)
            findings.push(...validateClaim(acceptedRecord, manifest, state, root, acceptedPath, accepted.claim_id as string))
          }
        }
      }
    }
  }

  if (isRecord(baseline)) {
    if (baseline.schema_version !== "1.0") findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline schema_version must be 1.0" })
    for (const field of ["captured_at_utc", "repository_root", "branch", "head_commit"]) {
      if (typeof baseline[field] !== "string" || baseline[field].length === 0) {
        findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline required metadata is missing: " + field })
      }
    }
    if (!isSha256Digest(baseline.status_digest)) {
      findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline status_digest must be a SHA-256 hex digest" })
    }
    if (!Array.isArray(baseline.entries)) {
      findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline entries must be an array" })
    } else {
      const paths = baseline.entries.map((entry, index) => {
        const entryPath = isRecord(entry) ? entry.path : undefined
        const entryFile = BASELINE_PATH + ".entries[" + index + "]"
        if (!isRecord(entry)) {
          findings.push({ code: "LP-004", path: entryFile, detail: "baseline entry must be an object" })
          return undefined
        }
        if (!isSafeRelativePath(entryPath)) {
          findings.push({ code: "LP-002", path: entryFile, detail: "baseline entry path must be safe and repository-relative" })
        }
        if (entry.kind !== "file" && entry.kind !== "directory") {
          findings.push({ code: "LP-004", path: entryFile, detail: "baseline entry kind must be file or directory" })
        }
        if (entry.kind === "file") {
          if (!isSha256Digest(entry.content_digest)) {
            findings.push({ code: "LP-004", path: entryFile, detail: "file baseline entry must include a SHA-256 content_digest" })
          }
          if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
            findings.push({ code: "LP-004", path: entryFile, detail: "file baseline entry size must be a non-negative integer" })
          }
        } else if (entry.kind === "directory" && (entry.content_digest !== null || entry.size !== null)) {
          findings.push({ code: "LP-004", path: entryFile, detail: "directory baseline entry content_digest and size must be null" })
        }
        return entryPath
      })
      const unique = new Set(paths)
      if (unique.size !== paths.length) findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline contains duplicate paths" })
      if (baseline.entry_count !== paths.length) {
        findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline entry_count does not match entries" })
      }
      for (const target of [MANIFEST_PATH, STATE_PATH, CLAIM_PATH, BASELINE_PATH, CARD_PATH]) {
        if (paths.includes(target)) findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline overlaps target path: " + target })
      }
    }
    if (baseline.target_paths !== undefined) {
      if (!Array.isArray(baseline.target_paths) || baseline.target_paths.length === 0) {
        findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline target_paths must be a non-empty array when present" })
      } else {
        for (const [index, target] of baseline.target_paths.entries()) {
          if (!isSafeRelativePath(target)) {
            findings.push({ code: "LP-002", path: BASELINE_PATH + ".target_paths[" + index + "]", detail: "baseline target path must be safe and repository-relative" })
          }
        }
      }
    }
    if (baseline.dispatcher_artifacts !== undefined) {
      if (!Array.isArray(baseline.dispatcher_artifacts)) {
        findings.push({ code: "LP-004", path: BASELINE_PATH, detail: "baseline dispatcher_artifacts must be an array when present" })
      } else {
        for (const [index, artifact] of baseline.dispatcher_artifacts.entries()) {
          const artifactFile = BASELINE_PATH + ".dispatcher_artifacts[" + index + "]"
          if (!isRecord(artifact) || !isSafeRelativePath(artifact.path) || typeof artifact.kind !== "string" || artifact.kind.length === 0 || !isSha256Digest(artifact.content_digest) || artifact.created_after_initial_capture !== true) {
            findings.push({ code: "LP-004", path: artifactFile, detail: "dispatcher artifact must declare safe path, kind, SHA-256 content_digest and created_after_initial_capture=true" })
          }
        }
      }
    }
    await validateBaselineFilesystem(root, baseline, findings)
    if (isGitRepository(root)) await validateStatusArtifact(root, baseline, findings)
  }

  if (isRecord(state) && isGitRepository(root)) await validateEvidenceBundle(root, state, findings)

  const manifestDigest = isRecord(manifest) ? sha256Text(canonicalJson(manifest)) : undefined
  const cardDigest = await fileDigest(root, CARD_PATH, findings)
  if (isRecord(state)) {
    if (manifestDigest && state.manifest_digest !== manifestDigest) {
      findings.push({ code: "LP-004", path: STATE_PATH, detail: "state manifest_digest does not match normalized manifest bytes" })
    }
    if (cardDigest && state.card_digest !== cardDigest) {
      findings.push({ code: "LP-004", path: STATE_PATH, detail: "state card_digest does not match card bytes" })
    }
  }
  try {
    const attestation = (await readFile(resolveSafe(root, ATTESTATION_PATH), "utf8")).trim()
    if (!manifestDigest || attestation !== "sha256:" + manifestDigest) {
      findings.push({ code: "LP-004", path: ATTESTATION_PATH, detail: "detached manifest attestation does not match" })
    }
  } catch (error) {
    findings.push({ code: "LP-004", path: ATTESTATION_PATH, detail: "cannot read detached attestation: " + String(error) })
  }

  const status = isRecord(state) && typeof state.status === "string" ? state.status : "UNKNOWN"
  return { schema_version: "1.0", valid: findings.length === 0, status, findings }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "write-status-artifact") {
    const result = await writeBootstrapStatusArtifact(parseRoot(args))
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.unexpected_paths.length === 0 ? 0 : 1)
  }
  if (args[0] === "refresh-evidence") {
    const result = await writeFreshEvidenceBundle(parseRoot(args))
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.bootstrap_exit_code === 0 ? 0 : 1)
  }
  if (args[0] === "cas-state-transition") {
    const root = parseRoot(args)
    const expectedIndex = args.indexOf("--expected")
    const statusIndex = args.indexOf("--status")
    const expected = expectedIndex >= 0 ? args[expectedIndex + 1] : undefined
    const status = statusIndex >= 0 ? args[statusIndex + 1] : undefined
    if (!expected || !status) {
      console.error("usage: bun run script/arforge-governance.ts cas-state-transition --root <repo> --expected <sha256> --status <state>")
      process.exit(2)
    }
    console.log(JSON.stringify({ state_digest: await transitionStateWithCas(root, expected, status) }, null, 2))
    process.exit(0)
  }
  if (args[0] !== "validate-bootstrap") {
    console.error("usage: bun run script/arforge-governance.ts validate-bootstrap|write-status-artifact|refresh-evidence|cas-state-transition --root <repo>")
    process.exit(2)
  }
  const report = await validateBootstrap(parseRoot(args))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid ? 0 : 1)
}
