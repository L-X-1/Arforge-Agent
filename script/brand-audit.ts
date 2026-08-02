import path from "path"
import { readdir } from "node:fs/promises"

export type Category = "product" | "distribution" | "generated" | "fixture" | "compatibility" | "legal" | "audit"

export interface Policy {
  readonly terms: ReadonlyArray<{ readonly id: string; readonly pattern: string }>
  readonly excludeDirectories: ReadonlyArray<string>
  readonly auditArtifacts: ReadonlyArray<string>
  readonly finalBudgets: Readonly<Record<Category, number>>
}

export interface Finding {
  readonly term: string
  readonly category: Category
  readonly file: string
  readonly line?: number
  readonly source: "path" | "content"
  readonly count: number
}

export interface Report {
  readonly version: 1
  readonly generatedAt: string
  readonly totals: Readonly<Record<string, number>>
  readonly categories: Readonly<Record<Category, number>>
  /** Files containing at least one finding. Retained for baseline compatibility. */
  readonly files: number
  /** Files visited after policy directory exclusions. Older baselines may omit this. */
  readonly visitedFiles?: number
  /** Non-binary files whose contents were decoded and scanned. Older baselines may omit this. */
  readonly scannedTextFiles?: number
  readonly findings: ReadonlyArray<Finding>
}

const binaryExtensions = new Set([
  ".7z",
  ".a",
  ".avi",
  ".bin",
  ".bmp",
  ".br",
  ".class",
  ".dll",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
])

const slash = (value: string) => value.replaceAll("\\", "/")

export function classify(file: string, policy: Policy): Category {
  const normalized = slash(file)
  const lowered = normalized.toLocaleLowerCase()
  const segmented = `/${lowered}/`
  if (policy.auditArtifacts.includes(normalized)) return "audit"
  if (
    /(^|\/)(license|licence|notice|copying)(\.|$)/i.test(normalized) ||
    segmented.includes("/licenses/") ||
    segmented.includes("/third-party/")
  )
    return "legal"
  if (
    segmented.includes("/migration/") ||
    segmented.includes("/migrations/") ||
    segmented.includes("/legacy/") ||
    lowered.includes("compat")
  )
    return "compatibility"
  if (
    segmented.includes("/generated/") ||
    lowered.includes(".gen.") ||
    lowered.endsWith(".snap") ||
    lowered.endsWith("schema.json") ||
    lowered.endsWith("openapi.json")
  )
    return "generated"
  if (
    segmented.includes("/test/") ||
    segmented.includes("/tests/") ||
    segmented.includes("/fixture/") ||
    segmented.includes("/fixtures/") ||
    segmented.includes("/__snapshots__/")
  )
    return "fixture"
  if (
    path.posix.basename(lowered) === "package.json" ||
    path.posix.basename(lowered).includes("lock") ||
    segmented.includes("/manifest") ||
    segmented.includes("/public/") ||
    segmented.includes("/assets/") ||
    segmented.includes("/.github/") ||
    lowered.endsWith(".toml") ||
    lowered.endsWith(".yml") ||
    lowered.endsWith(".yaml")
  )
    return "distribution"
  return "product"
}

export function scanText(file: string, text: string, policy: Policy): Finding[] {
  const category = classify(file, policy)
  return text.split(/\r?\n/).flatMap((line, index) =>
    policy.terms.flatMap((term) => {
      const count = Array.from(line.matchAll(new RegExp(term.pattern, "gi"))).length
      return count === 0
        ? []
        : [{ term: term.id, category, file, line: index + 1, source: "content" as const, count }]
    }),
  )
}

export function summarize(findings: ReadonlyArray<Finding>): Omit<Report, "generatedAt"> {
  const totals: Record<string, number> = {}
  const categories: Record<Category, number> = {
    product: 0,
    distribution: 0,
    generated: 0,
    fixture: 0,
    compatibility: 0,
    legal: 0,
    audit: 0,
  }
  for (const finding of findings) {
    totals[finding.term] = (totals[finding.term] ?? 0) + finding.count
    categories[finding.category] += finding.count
  }
  return {
    version: 1,
    totals,
    categories,
    files: new Set(findings.map((finding) => finding.file)).size,
    findings: [...findings],
  }
}

async function scan(root: string, policy: Policy): Promise<Report> {
  const findings: Finding[] = []
  let visitedFiles = 0
  let scannedTextFiles = 0
  async function* files(directory: string, relative = ""): AsyncGenerator<string> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (policy.excludeDirectories.includes(entry.name)) continue
      const raw = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        yield* files(path.join(directory, entry.name), raw)
        continue
      }
      if (entry.isFile()) yield raw
    }
  }

  for await (const raw of files(root)) {
    visitedFiles += 1
    const file = slash(raw)
    const category = classify(file, policy)
    for (const term of policy.terms) {
      const count = Array.from(file.matchAll(new RegExp(term.pattern, "gi"))).length
      if (count > 0) findings.push({ term: term.id, category, file, source: "path", count })
    }
    if (binaryExtensions.has(path.extname(file).toLocaleLowerCase())) continue
    const source = Bun.file(path.join(root, file))
    if (source.size > 5_000_000) continue
    const bytes = new Uint8Array(await source.arrayBuffer())
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) continue
    scannedTextFiles += 1
    findings.push(...scanText(file, new TextDecoder("utf-8", { fatal: false }).decode(bytes), policy))
  }
  return {
    ...summarize(findings),
    visitedFiles,
    scannedTextFiles,
    generatedAt: new Date().toISOString(),
  }
}

function regressions(report: Report, baseline: Report) {
  const failures: string[] = []
  for (const [term, count] of Object.entries(report.totals)) {
    const allowed = baseline.totals[term] ?? 0
    if (count > allowed) failures.push(`${term}: ${count} > baseline ${allowed}`)
  }
  for (const [category, count] of Object.entries(report.categories) as [Category, number][]) {
    const allowed = baseline.categories[category] ?? 0
    if (count > allowed) failures.push(`${category}: ${count} > baseline ${allowed}`)
  }
  return failures
}

function finalBudgetFailures(report: Report, policy: Policy) {
  return (Object.entries(report.categories) as [Category, number][]).flatMap(([category, count]) => {
    const allowed = policy.finalBudgets[category]
    return count > allowed ? [`${category}: ${count} > final budget ${allowed}`] : []
  })
}

function print(report: Report) {
  const hits = Object.values(report.totals).reduce((sum, count) => sum + count, 0)
  const scope =
    report.visitedFiles === undefined
      ? ""
      : `; visited ${report.visitedFiles} files, scanned ${report.scannedTextFiles ?? 0} text files`
  console.log(`Brand audit: ${hits} hits in ${report.files} finding files${scope}`)
  for (const [term, count] of Object.entries(report.totals).toSorted()) console.log(`  ${term}: ${count}`)
  console.log("Categories:")
  for (const [category, count] of Object.entries(report.categories)) console.log(`  ${category}: ${count}`)
  const top = new Map<string, number>()
  for (const finding of report.findings) top.set(finding.file, (top.get(finding.file) ?? 0) + finding.count)
  console.log("Top files:")
  for (const [file, count] of Array.from(top).toSorted((a, b) => b[1] - a[1]).slice(0, 15))
    console.log(`  ${count} ${file}`)
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..")
  const policyPath = path.join(root, "specs", "brand-policy.json")
  const baselinePath = path.join(root, "specs", "brand-baseline.json")
  const policy = (await Bun.file(policyPath).json()) as Policy
  const report = await scan(root, policy)
  const args = new Set(process.argv.slice(2))
  print(report)

  if (args.has("--json")) console.log(JSON.stringify(report, null, 2))
  if (args.has("--write-baseline")) {
    const { findings: _findings, ...baseline } = report
    await Bun.write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Wrote ${path.relative(root, baselinePath)}`)
  }

  const failures: string[] = []
  if (args.has("--check")) {
    if (!(await Bun.file(baselinePath).exists())) failures.push("brand baseline is missing")
    else failures.push(...regressions(report, (await Bun.file(baselinePath).json()) as Report))
  }
  if (args.has("--strict")) failures.push(...finalBudgetFailures(report, policy))
  if (failures.length > 0) {
    console.error("Brand audit failed:")
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }
}
