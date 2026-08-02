import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type DeleteTarget = {
  path: string
  type: "file" | "directory"
  bytes?: number
  role: string
}

type Plan = {
  schemaVersion: number
  workspace: string
  status: string
  authorization: {
    tier2Approved: boolean
    approvedOption?: "A" | "B"
    approvedAt?: string
    acceptedApprovalPhrases: string[]
  }
  options: {
    A: { delete: DeleteTarget[] }
    B: { includes: string; additionalDelete: DeleteTarget[] }
  }
  explicitlyRetain: string[]
  executionResult?: {
    executedAt: string
    approvedOption: "A" | "B"
    targetsRecycled: number
    manifest: string
    permanentlyDeleted: boolean
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const planPath = resolve(root, "specs/tier2-deletion-plan.json")
const plan = JSON.parse(await Bun.file(planPath).text()) as Plan
const findings: string[] = []

if (plan.schemaVersion !== 1) findings.push(`unsupported schemaVersion: ${plan.schemaVersion}`)
if (resolve(plan.workspace).toLowerCase() !== root.toLowerCase()) {
  findings.push(`workspace mismatch: ${plan.workspace}`)
}
const allowedStatuses = new Set([
  "awaiting-owner-approval",
  "approved-waiting-database-preconditions",
  "executed-recoverable",
])
if (!allowedStatuses.has(plan.status)) findings.push(`unexpected plan status: ${plan.status}`)
if (plan.authorization.tier2Approved) {
  if (plan.authorization.approvedOption !== "A" && plan.authorization.approvedOption !== "B") {
    findings.push("approved plan must name option A or B")
  }
  if (!plan.authorization.approvedAt) findings.push("approved plan must record approvedAt")
  if (!["approved-waiting-database-preconditions", "executed-recoverable"].includes(plan.status)) {
    findings.push("approved plan must be waiting for database gates or record recoverable execution")
  }
} else if (plan.authorization.approvedOption || plan.authorization.approvedAt) {
  findings.push("unapproved plan must not contain approval metadata")
}
if (plan.options.B.includes !== "A") findings.push("option B must explicitly include option A")
if (plan.authorization.acceptedApprovalPhrases.length !== 2) {
  findings.push("expected one exact approval phrase for each deletion option")
}

const targets = [...plan.options.A.delete, ...plan.options.B.additionalDelete]
const targetNames = targets.map((target) => normalize(target.path))
if (new Set(targetNames).size !== targetNames.length) findings.push("duplicate deletion target")

const retained = plan.explicitlyRetain.map(normalize)
for (const keep of retained) {
  for (const target of targetNames) {
    if (keep === target || keep.startsWith(`${target}/`)) {
      findings.push(`retained path overlaps deletion target: ${keep} within ${target}`)
    }
  }
}

if (plan.status === "executed-recoverable") {
  if (!plan.executionResult) {
    findings.push("executed plan must include executionResult")
  } else {
    if (plan.executionResult.approvedOption !== plan.authorization.approvedOption) {
      findings.push("execution option does not match owner approval")
    }
    if (plan.executionResult.targetsRecycled !== targets.length) {
      findings.push("execution target count does not match the approved plan")
    }
    if (plan.executionResult.permanentlyDeleted) {
      findings.push("Tier 2 execution must remain recoverable")
    }
    try {
      await lstat(resolveSafe(plan.executionResult.manifest))
    } catch (error) {
      findings.push(`execution manifest missing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const target of targets) {
    try {
      await lstat(resolveSafe(target.path))
      findings.push(`${target.path}: approved target remains after execution`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") findings.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} else {
  for (const target of targets) {
    const absolute = resolveSafe(target.path)
    try {
      const info = await lstat(absolute)
      const actualType = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other"
      if (actualType !== target.type) findings.push(`${target.path}: expected ${target.type}, found ${actualType}`)
      if (info.isSymbolicLink()) findings.push(`${target.path}: symbolic-link target is not deletion-safe`)
      const canonical = await realpath(absolute)
      assertWithinRoot(canonical, `${target.path}: real path escapes workspace`)
      if (typeof target.bytes === "number" && target.type === "file" && info.size !== target.bytes) {
        findings.push(`${target.path}: recorded ${target.bytes} bytes, found ${info.size}`)
      }
    } catch (error) {
      findings.push(`${target.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

for (const keep of plan.explicitlyRetain) {
  const absolute = resolveSafe(keep)
  try {
    await lstat(absolute)
  } catch (error) {
    findings.push(`retained path missing (${keep}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (findings.length) {
  console.error(`Tier 2 deletion-plan audit failed with ${findings.length} finding(s):`)
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log(
  [
    "Tier 2 deletion-plan audit passed.",
    `- status: ${plan.status}`,
    `- approved option: ${plan.authorization.approvedOption ?? "none"}`,
    `- option A targets: ${plan.options.A.delete.length}`,
    `- option B additional targets: ${plan.options.B.additionalDelete.length}`,
    `- explicitly retained paths: ${plan.explicitlyRetain.length}`,
    `- targets recycled: ${plan.executionResult?.targetsRecycled ?? 0}`,
    `- permanently deleted: ${plan.executionResult?.permanentlyDeleted ?? false}`,
  ].join("\n"),
)

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "")
}

function resolveSafe(value: string) {
  if (isAbsolute(value)) throw new Error(`plan paths must be workspace-relative: ${value}`)
  const absolute = resolve(root, value)
  assertWithinRoot(absolute, `path escapes workspace: ${value}`)
  return absolute
}

function assertWithinRoot(absolute: string, message: string) {
  const child = relative(root, absolute)
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return
  throw new Error(message)
}
