import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

type JsonObject = Record<string, unknown>

type BunLockPackage = [string, string, JsonObject | undefined, string | undefined]

type BunLock = {
  packages?: Record<string, BunLockPackage>
  workspaces?: Record<string, JsonObject>
}

type FileEntry = {
  path: string
  kind: "artifact" | "evidence"
  bytes: number
  sha256: string
}

type SignatureStatus = {
  schema_version: 1
  status: "candidate" | "signed" | "blocked"
  verified: boolean
  evidence_path?: string
  verified_artifacts: string[]
  failed_artifacts: string[]
  reason?: string
  private_key_export_blocked?: boolean
  required_reviewers_approved?: boolean
  signing_material_removed?: boolean
}

export type BuildReleaseEvidenceOptions = {
  root?: string
  outputDir?: string
  artifacts?: string[]
  signatureEvidence?: string
  channel?: string
  allowDirty?: boolean
  requireClean?: boolean
  requireSigned?: boolean
  sourceDateEpoch?: string
}

export type ReleaseEvidenceReport = {
  manifest: JsonObject
  signature: SignatureStatus
  outputDir: string
  verifiedFiles: string[]
}

const PRODUCT = "Arforge Agent"
const MANIFEST_FILE = "release-manifest.json"
const CHECKSUM_FILE = "SHA256SUMS"
const SBOM_FILE = "sbom.cdx.json"
const PROVENANCE_FILE = "provenance.json"
const SIGNATURE_FILE = "signature-status.json"

function git(root: string, args: string[]) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function posixPath(path: string) {
  return path.split(sep).join("/")
}

function safeRelative(root: string, path: string) {
  const value = posixPath(relative(root, path))
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error(`path must stay inside repository root: ${path}`)
  }
  return value
}

function parseJsonWithTrailingCommas(text: string) {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1")) as JsonObject
}

function packageVersion(name: string, spec: string) {
  const prefix = `${name}@`
  if (spec.startsWith(prefix)) return spec.slice(prefix.length)
  const separator = spec.lastIndexOf("@")
  return separator >= 0 ? spec.slice(separator + 1) : spec
}

function npmPurl(name: string, version: string) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

async function manifestLicense(path: string) {
  try {
    const manifest = JSON.parse(await readFile(path, "utf8")) as JsonObject
    const license = manifest.license
    if (typeof license === "string" && license.trim()) return license.trim()
    if (license && typeof license === "object" && typeof (license as JsonObject).type === "string") {
      return String((license as JsonObject).type)
    }
    if (Array.isArray(manifest.licenses)) {
      const values = manifest.licenses
        .map((item) =>
          typeof item === "string" ? item : item && typeof item === "object" ? (item as JsonObject).type : undefined,
        )
        .filter((item): item is string => typeof item === "string" && item.length > 0)
      if (values.length) return values.join(" OR ")
    }
  } catch {
    // A lockfile entry can be optional or platform-specific and may not be installed locally.
  }
  return "NOASSERTION"
}

async function packageLicense(root: string, name: string, version: string, bunDirectories: string[]) {
  const direct = await manifestLicense(join(root, "node_modules", ...name.split("/"), "package.json"))
  if (direct !== "NOASSERTION") return direct

  const prefix = `${name.replaceAll("/", "+")}@${version}`
  const isolatedDirectory = bunDirectories.find(
    (directory) => directory === prefix || directory.startsWith(`${prefix}+`),
  )
  if (!isolatedDirectory) return direct
  return manifestLicense(
    join(root, "node_modules", ".bun", isolatedDirectory, "node_modules", ...name.split("/"), "package.json"),
  )
}

async function buildSbom(root: string, version: string, lockDigest: string, createdAt: string) {
  const lockText = await readFile(join(root, "bun.lock"), "utf8")
  const lock = parseJsonWithTrailingCommas(lockText) as BunLock
  const entries = Object.entries(lock.packages ?? {}).sort(([left], [right]) => left.localeCompare(right))
  const bunDirectories = await readdir(join(root, "node_modules", ".bun")).catch(() => [] as string[])
  const components: JsonObject[] = []

  for (const [name, record] of entries) {
    if (!Array.isArray(record) || typeof record[0] !== "string") continue
    const resolvedVersion = packageVersion(name, record[0])
    const purl = npmPurl(name, resolvedVersion)
    const license = await packageLicense(root, name, resolvedVersion, bunDirectories)
    const properties = [
      { name: "arforge:dependency:source", value: "bun.lock" },
      { name: "arforge:dependency:lock-key", value: name },
      ...(typeof record[1] === "string" ? [{ name: "arforge:dependency:resolution", value: record[1] }] : []),
      ...(typeof record[3] === "string" ? [{ name: "arforge:dependency:integrity", value: record[3] }] : []),
    ]
    components.push({
      type: "library",
      "bom-ref": purl,
      name,
      version: resolvedVersion,
      purl,
      licenses: [{ license: license === "NOASSERTION" ? { name: license } : { id: license } }],
      ...(typeof record[3] === "string" ? { hashes: [{ alg: "SHA-512", content: record[3] }] } : {}),
      properties,
    })
  }

  const rootRef = npmPurl("arforge-agent", version)
  const serialDigest = createHash("sha256").update(`${rootRef}:${lockDigest}`).digest("hex")
  const serialNumber = `urn:uuid:${serialDigest.slice(0, 8)}-${serialDigest.slice(8, 12)}-${serialDigest.slice(12, 16)}-${serialDigest.slice(16, 20)}-${serialDigest.slice(20, 32)}`

  return {
    $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber,
    version: 1,
    metadata: {
      timestamp: createdAt,
      component: { type: "application", "bom-ref": rootRef, name: PRODUCT, version, purl: rootRef },
      properties: [
        { name: "arforge:lockfile", value: "bun.lock" },
        { name: "arforge:lockfile:sha256", value: lockDigest },
        { name: "arforge:dependency:provenance", value: "Bun lockfile resolution records" },
      ],
    },
    components,
  }
}

function statusPaths(root: string, outputDir: string) {
  const outputRelative = isAbsolute(outputDir) ? posixPath(relative(root, outputDir)) : posixPath(outputDir)
  return git(root, ["status", "--porcelain=v1"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? line)
    .filter((path) => {
      if (!outputRelative || outputRelative === "." || outputRelative.startsWith("../")) return true
      return path !== outputRelative && !path.startsWith(`${outputRelative}/`)
    })
}

function sourceTimestamp(root: string, explicit?: string) {
  const value = explicit ?? process.env.SOURCE_DATE_EPOCH ?? (git(root, ["show", "-s", "--format=%ct", "HEAD"]) || "0")
  if (!/^\d+$/.test(value)) throw new Error(`SOURCE_DATE_EPOCH must be an integer, received: ${value}`)
  return { epoch: value, iso: new Date(Number(value) * 1000).toISOString() }
}

function artifactEntry(root: string, path: string, digest: string, bytes: number): FileEntry {
  return { path: `artifact/${safeRelative(root, path)}`, kind: "artifact", bytes, sha256: digest }
}

function evidenceEntry(name: string, digest: string, bytes: number): FileEntry {
  return { path: `evidence/${posixPath(name)}`, kind: "evidence", bytes, sha256: digest }
}

function artifactMatch(expected: string, candidate: unknown) {
  if (typeof candidate !== "string") return false
  const normalized = posixPath(candidate).replace(/^\.\//, "")
  return normalized === expected || normalized === basename(expected)
}

async function buildSignatureStatus(
  root: string,
  artifactEntries: FileEntry[],
  evidencePath?: string,
): Promise<SignatureStatus> {
  if (!evidencePath) {
    return {
      schema_version: 1,
      status: "candidate",
      verified: false,
      verified_artifacts: [],
      failed_artifacts: [],
      reason: "No real signing evidence was supplied; candidate is not a signed release.",
    }
  }

  const absoluteEvidence = resolve(root, evidencePath)
  const evidence = JSON.parse(await readFile(absoluteEvidence, "utf8")) as JsonObject
  const records = Array.isArray(evidence.artifacts) ? evidence.artifacts : []
  const failed: string[] = []
  const verified: string[] = []
  const privateKeyExportBlocked = evidence.private_key_export_blocked === true
  const reviewersApproved = evidence.required_reviewers_approved === true
  const signingMaterialRemoved = evidence.signing_material_removed === true

  for (const entry of artifactEntries) {
    const expected = entry.path.slice("artifact/".length)
    const record = records.find(
      (item) => item && typeof item === "object" && artifactMatch(expected, (item as JsonObject).name),
    ) as JsonObject | undefined
    const valid =
      record !== undefined &&
      String(record.sha256 ?? "").toLowerCase() === entry.sha256 &&
      (record.signature_valid === true || String(record.signature_status).toLowerCase() === "valid") &&
      record.timestamped === true &&
      typeof record.signer_subject === "string" &&
      record.signer_subject.length > 0
    if (valid) verified.push(expected)
    else failed.push(expected)
  }

  const signed =
    artifactEntries.length > 0 &&
    (evidence.status === "pass" || evidence.status === "signed") &&
    privateKeyExportBlocked &&
    reviewersApproved &&
    signingMaterialRemoved &&
    failed.length === 0

  return {
    schema_version: 1,
    status: signed ? "signed" : "blocked",
    verified: signed,
    evidence_path: posixPath(relative(root, absoluteEvidence)),
    verified_artifacts: verified,
    failed_artifacts: failed,
    ...(signed
      ? {}
      : {
          reason:
            "Signing evidence is incomplete, does not bind every artifact, or is missing protected-review metadata.",
        }),
    private_key_export_blocked: privateKeyExportBlocked,
    required_reviewers_approved: reviewersApproved,
    signing_material_removed: signingMaterialRemoved,
  }
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function fileEntryForOutput(outputDir: string, name: string): Promise<FileEntry> {
  const path = join(outputDir, name)
  return evidenceEntry(name, await sha256(path), (await stat(path)).size)
}

export async function buildReleaseEvidence(options: BuildReleaseEvidenceOptions = {}): Promise<ReleaseEvidenceReport> {
  const root = resolve(options.root ?? process.cwd())
  const outputDir = resolve(options.outputDir ?? join(root, "artifacts", "release-evidence"))
  const requireClean = options.requireClean ?? !options.allowDirty
  const dirtyPaths = statusPaths(root, outputDir)
  if (requireClean && dirtyPaths.length > 0) {
    throw new Error(`release evidence requires a clean source tree; found ${dirtyPaths.slice(0, 12).join(", ")}`)
  }

  const lockPath = join(root, "bun.lock")
  const packagePath = join(root, "package.json")
  const lockDigest = await sha256(lockPath)
  const packageDigest = await sha256(packagePath)
  const timestamp = sourceTimestamp(root, options.sourceDateEpoch)
  const commit = process.env.GITHUB_SHA || git(root, ["rev-parse", "HEAD"]) || "unknown"
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]) || "unknown"
  const version = String((JSON.parse(await readFile(packagePath, "utf8")) as JsonObject).version ?? "unknown")
  const artifacts: FileEntry[] = []

  for (const rawPath of options.artifacts ?? []) {
    const path = resolve(root, rawPath)
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new Error(`release artifact is not a file: ${path}`)
    artifacts.push(artifactEntry(root, path, await sha256(path), metadata.size))
  }

  await mkdir(outputDir, { recursive: true })
  const sbom = await buildSbom(root, version, lockDigest, timestamp.iso)
  const provenance = {
    schema_version: 1,
    product: PRODUCT,
    version,
    channel: options.channel ?? process.env.ARFORGE_CHANNEL ?? "candidate",
    source: { commit, tree, dirty: dirtyPaths.length > 0 },
    build: {
      builder: "bun",
      builder_version: Bun.version,
      package_manager: "bun@1.3.14",
      source_date_epoch: timestamp.epoch,
      created_at: timestamp.iso,
      lockfile: { path: "bun.lock", sha256: lockDigest },
      package_manifest: { path: "package.json", sha256: packageDigest },
      reproducible_inputs_complete: true,
    },
    dependency_provenance: {
      source: "bun.lock",
      lockfile_format: "bun-lockfile-v1",
      resolution_integrity_required: true,
    },
  }
  await writeJson(join(outputDir, SBOM_FILE), sbom)
  await writeJson(join(outputDir, PROVENANCE_FILE), provenance)

  const signature = await buildSignatureStatus(root, artifacts, options.signatureEvidence)
  await writeJson(join(outputDir, SIGNATURE_FILE), signature)

  const evidenceFiles = [
    await fileEntryForOutput(outputDir, SBOM_FILE),
    await fileEntryForOutput(outputDir, PROVENANCE_FILE),
    await fileEntryForOutput(outputDir, SIGNATURE_FILE),
  ]
  const files = [...artifacts, ...evidenceFiles].sort((left, right) => left.path.localeCompare(right.path))
  const manifest: JsonObject = {
    schema_version: 1,
    product: PRODUCT,
    version,
    channel: options.channel ?? process.env.ARFORGE_CHANNEL ?? "candidate",
    status: signature.status,
    created_at: timestamp.iso,
    source: { commit, tree, dirty: dirtyPaths.length > 0 },
    reproducible: {
      source_date_epoch: timestamp.epoch,
      deterministic_timestamp: true,
      lockfile_sha256: lockDigest,
      package_manifest_sha256: packageDigest,
      input_closure_complete: true,
    },
    signature,
    files,
  }
  await writeJson(join(outputDir, MANIFEST_FILE), manifest)

  const manifestEntry = await fileEntryForOutput(outputDir, MANIFEST_FILE)
  const checksumEntries = [...files, manifestEntry].sort((left, right) => left.path.localeCompare(right.path))
  const checksums = checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n"
  await writeFile(join(outputDir, CHECKSUM_FILE), checksums, "utf8")

  if (options.requireSigned && signature.status !== "signed") {
    throw new Error("release evidence is not signed; real signature and timestamp evidence is required")
  }

  return { manifest, signature, outputDir, verifiedFiles: checksumEntries.map((entry) => entry.path) }
}

function resolveEvidenceFile(outputDir: string, root: string, entryPath: string) {
  const relativePath = entryPath.startsWith("evidence/")
    ? entryPath.slice("evidence/".length)
    : entryPath.startsWith("artifact/")
      ? entryPath.slice("artifact/".length)
      : undefined
  if (!relativePath || relativePath.includes("..")) throw new Error(`unsupported evidence path: ${entryPath}`)
  if (entryPath.startsWith("evidence/")) return resolve(outputDir, relativePath)
  return resolve(root, relativePath)
}

function repositoryRootForEvidence(rootInput?: string) {
  return resolve(rootInput ?? process.cwd())
}

export async function verifyReleaseEvidence(
  outputDirInput: string,
  requireSigned = false,
  rootInput?: string,
): Promise<ReleaseEvidenceReport> {
  const outputDir = resolve(outputDirInput)
  const root = repositoryRootForEvidence(rootInput)
  const manifest = JSON.parse(await readFile(join(outputDir, MANIFEST_FILE), "utf8")) as JsonObject
  const entries = Array.isArray(manifest.files) ? (manifest.files as FileEntry[]) : []
  if (manifest.schema_version !== 1 || entries.length === 0) throw new Error("invalid release manifest")

  const verifiedFiles: string[] = []
  for (const entry of entries) {
    const path = resolveEvidenceFile(outputDir, root, entry.path)
    const actual = await sha256(path)
    if (actual !== entry.sha256) throw new Error(`release evidence hash mismatch: ${entry.path}`)
    if ((await stat(path)).size !== entry.bytes) throw new Error(`release evidence size mismatch: ${entry.path}`)
    verifiedFiles.push(entry.path)
  }

  const checksumText = await readFile(join(outputDir, CHECKSUM_FILE), "utf8")
  const checksumEntries = checksumText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/)
      if (!match) throw new Error("invalid release checksum line")
      return { sha256: match[1], path: match[2] }
    })
  const manifestPath = join(outputDir, MANIFEST_FILE)
  const expectedManifestHash = checksumEntries.find((entry) => entry.path === "evidence/release-manifest.json")
  if (!expectedManifestHash || expectedManifestHash.sha256 !== (await sha256(manifestPath))) {
    throw new Error("release manifest checksum is missing or invalid")
  }
  for (const entry of checksumEntries) {
    const path = resolveEvidenceFile(outputDir, root, entry.path)
    if ((await sha256(path)) !== entry.sha256) throw new Error(`checksum mismatch: ${entry.path}`)
  }

  const signature = JSON.parse(await readFile(join(outputDir, SIGNATURE_FILE), "utf8")) as SignatureStatus
  if (requireSigned && signature.status !== "signed") throw new Error("release evidence is not signed")
  return { manifest, signature, outputDir, verifiedFiles: checksumEntries.map((entry) => entry.path) }
}

function argumentValues(args: string[], flag: string) {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1]
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
      values.push(value)
      index += 1
    }
  }
  return values
}

async function main() {
  const args = process.argv.slice(2)
  const outputDir = argumentValues(args, "--output")[0] ?? "artifacts/release-evidence"
  const artifacts = argumentValues(args, "--artifact")
  const signatureEvidence = argumentValues(args, "--signature-evidence")[0]
  const channel = argumentValues(args, "--channel")[0]
  const sourceDateEpoch = argumentValues(args, "--source-date-epoch")[0]
  const requireSigned = args.includes("--require-signed")

  if (args.includes("--verify")) {
    const report = await verifyReleaseEvidence(outputDir, requireSigned, process.cwd())
    console.log(
      JSON.stringify({
        outputDir: report.outputDir,
        status: report.signature.status,
        verifiedFiles: report.verifiedFiles.length,
      }),
    )
    return
  }

  const report = await buildReleaseEvidence({
    outputDir,
    artifacts,
    signatureEvidence,
    channel,
    sourceDateEpoch,
    allowDirty: args.includes("--allow-dirty"),
    requireClean: args.includes("--require-clean") || !args.includes("--allow-dirty"),
    requireSigned,
  })
  console.log(
    JSON.stringify({
      outputDir: report.outputDir,
      status: report.signature.status,
      files: report.verifiedFiles.length,
    }),
  )
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
