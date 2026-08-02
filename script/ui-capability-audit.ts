import { readdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { CONTROL_CENTER_CAPABILITY_MAP, mappingForMethod } from "../packages/app/src/capabilities/control-center-map"
import {
  UI_CAPABILITY_REVIEW,
  reviewedUiCapabilityMethods,
} from "../packages/app/src/capabilities/ui-capability-review"

const root = resolve(import.meta.dir, "..")
const appRoot = resolve(root, "packages/app/src")
const generatedClient = resolve(root, "packages/client/src/generated/client.ts")
const output = resolve(root, "artifacts/ui-capability-audit.json")

const generated = await generatedClientMethods()
const sourceFiles = await collectSourceFiles(appRoot)
const source = await Promise.all(
  sourceFiles.map(async (file) => ({
    file,
    text: await readFile(file, "utf8"),
    test: /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  })),
)

const methods = generated.map((method) => {
  const [group, operation] = method.split(".")
  if (!group || !operation) throw new Error(`Invalid generated client method: ${method}`)
  const pattern = new RegExp(`\\.${escapeRegExp(group)}\\s*\\.\\s*${escapeRegExp(operation)}\\s*\\(`, "g")
  const evidence = source.flatMap((entry) => {
    if (entry.file.endsWith("capabilities/control-center-map.ts")) return []
    const matches = [...entry.text.matchAll(pattern)]
    return matches.map((match) => ({
      file: relative(root, entry.file).replaceAll("\\", "/"),
      line: entry.text.slice(0, match.index).split(/\r?\n/).length,
      test: entry.test,
    }))
  })
  const mapping = mappingForMethod(method)
  if (!mapping) throw new Error(`Generated method has no capability mapping: ${method}`)
  return {
    method,
    surface: mapping.surface,
    feature: mapping.feature,
    risk: mapping.risk,
    productEvidence: evidence.filter((item) => !item.test),
    testEvidence: evidence.filter((item) => item.test),
  }
})

const duplicateMappings = CONTROL_CENTER_CAPABILITY_MAP.flatMap((entry) => entry.methods).filter(
  (method, index, all) => all.indexOf(method) !== index,
)
const missingMappings = generated.filter((method) => !mappingForMethod(method))
const extraMappings = CONTROL_CENTER_CAPABILITY_MAP.flatMap((entry) => entry.methods).filter(
  (method) => !generated.includes(method),
)
const productReachable = methods.filter((entry) => entry.productEvidence.length > 0)
const directNonInternal = productReachable.filter((entry) => entry.surface !== "transport-internal")
const withoutDirectProductCall = methods.filter(
  (entry) => entry.productEvidence.length === 0 && entry.surface !== "transport-internal",
)
const reviewMethods = reviewedUiCapabilityMethods()
const reviewDuplicates = reviewMethods.filter((method, index) => reviewMethods.indexOf(method) !== index)
const reviewCandidates = withoutDirectProductCall.map((entry) => entry.method)
const unreviewedCandidates = reviewCandidates.filter((method) => !reviewMethods.includes(method))
const staleReviews = reviewMethods.filter((method) => !reviewCandidates.includes(method))
const reviewed = UI_CAPABILITY_REVIEW.map((entry) => ({
  ...entry,
  methods: entry.methods.map((method) => methods.find((candidate) => candidate.method === method)!),
}))

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: {
    backend: "packages/client/src/generated/client.ts",
    frontend: "packages/app/src/**/*.{ts,tsx}",
    meaning:
      "Direct generated-client call reachability only. Absence is a review candidate, not proof that the user behavior is missing; mature SDK adapters and semantic replacement require manual review.",
  },
  totals: {
    generatedMethods: generated.length,
    mappedMethods: methods.length,
    duplicateMappings: duplicateMappings.length,
    missingMappings: missingMappings.length,
    extraMappings: extraMappings.length,
    directProductReachable: productReachable.length,
    directNonInternal: directNonInternal.length,
    internalTransport: methods.filter((entry) => entry.surface === "transport-internal").length,
    manualReviewCandidates: withoutDirectProductCall.length,
    semanticUi: UI_CAPABILITY_REVIEW.filter((entry) => entry.disposition === "semantic-ui").reduce(
      (sum, entry) => sum + entry.methods.length,
      0,
    ),
    intentionalInternal: UI_CAPABILITY_REVIEW.filter(
      (entry) => entry.disposition === "transport-internal" || entry.disposition === "automation-internal",
    ).reduce((sum, entry) => sum + entry.methods.length, 0),
    confirmedUiGaps: UI_CAPABILITY_REVIEW.filter((entry) => entry.disposition === "ui-gap").reduce(
      (sum, entry) => sum + entry.methods.length,
      0,
    ),
    uiEligibleMethods:
      directNonInternal.length +
      UI_CAPABILITY_REVIEW.filter(
        (entry) => entry.disposition === "semantic-ui" || entry.disposition === "ui-gap",
      ).reduce((sum, entry) => sum + entry.methods.length, 0),
    uiClosedMethods:
      directNonInternal.length +
      UI_CAPABILITY_REVIEW.filter((entry) => entry.disposition === "semantic-ui").reduce(
        (sum, entry) => sum + entry.methods.length,
        0,
      ),
  },
  integrity: {
    duplicateMappings,
    missingMappings,
    extraMappings,
    reviewDuplicates,
    unreviewedCandidates,
    staleReviews,
  },
  manualReviewCandidates: withoutDirectProductCall.map((entry) => ({
    method: entry.method,
    surface: entry.surface,
    feature: entry.feature,
    risk: entry.risk,
    testEvidence: entry.testEvidence,
  })),
  reviewed,
  methods,
}

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
console.log(JSON.stringify({ output, ...report.totals, integrity: report.integrity }, null, 2))
if (
  duplicateMappings.length ||
  missingMappings.length ||
  extraMappings.length ||
  reviewDuplicates.length ||
  unreviewedCandidates.length ||
  staleReviews.length
) {
  process.exitCode = 1
}

async function generatedClientMethods() {
  const text = await readFile(generatedClient, "utf8")
  const methods: string[] = []
  let group = ""
  for (const line of text.split(/\r?\n/)) {
    const groupMatch = /^    ([A-Za-z][A-Za-z0-9]*): \{$/.exec(line)
    if (groupMatch) {
      group = groupMatch[1]!
      continue
    }
    const methodMatch = /^      ([A-Za-z][A-Za-z0-9]*): \(/.exec(line)
    if (group && methodMatch) methods.push(`${group}.${methodMatch[1]}`)
  }
  return methods
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return collectSourceFiles(path)
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) return []
      return [path]
    }),
  )
  return files.flat()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
