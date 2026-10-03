import type { GoldenCase } from "./golden"

/**
 * The Python runner remains a migration/compatibility runner. These snapshots
 * are intentionally in-memory and are never written as a second evaluation
 * fact. A caller must provide the same frozen fixture digest to both sides.
 */
export interface PythonMigrationSnapshot {
  readonly caseID: string
  readonly category: string
  readonly fixtureDigest: string
  readonly passed: boolean
  readonly score: number
  readonly platform: string
  readonly toolSurfaceRevision: string
  readonly tokenEstimatorID: string
  readonly providerAdapterID: string
}

export interface TypeScriptMigrationSnapshot {
  readonly caseID: string
  readonly suiteID: string
  readonly suiteRevision: number
  readonly caseRevision: number
  readonly fixtureDigest: string
  readonly passed: boolean
  readonly score: number
  readonly platform: string
  readonly toolSurfaceRevision: string
  readonly tokenEstimatorID: string
  readonly providerAdapterID: string
}

export type MigrationDifferenceKind =
  | "identity"
  | "manifest"
  | "result"
  | "tool-surface"
  | "token-estimator"
  | "platform"
  | "provider-adapter"

export interface MigrationDifference {
  readonly kind: MigrationDifferenceKind
  readonly field: string
  readonly python: string | number | boolean
  readonly typescript: string | number | boolean
  readonly blocking: boolean
}

export interface MigrationComparison {
  readonly caseID: string
  readonly status: "equivalent" | "equivalent-with-explanations" | "incompatible"
  readonly equivalent: boolean
  readonly differences: ReadonlyArray<MigrationDifference>
  readonly blockingDifferences: ReadonlyArray<MigrationDifference>
  readonly explanations: ReadonlyArray<MigrationDifference>
}

const addDifference = (
  differences: MigrationDifference[],
  kind: MigrationDifferenceKind,
  field: string,
  python: string | number | boolean,
  typescript: string | number | boolean,
  blocking: boolean,
) => {
  if (python !== typescript) differences.push({ kind, field, python, typescript, blocking })
}

/**
 * Compare one legacy Python observation with one TS Runtime observation.
 *
 * Identity, frozen-manifest and pass/score differences block equivalence.
 * Runtime metadata differences are retained as explicit explanations so a
 * migration report cannot hide tool, accounting, platform, or provider
 * adapter changes behind a single boolean result.
 */
export const comparePythonTypeScriptRun = (input: {
  readonly goldenCase: GoldenCase
  readonly python: PythonMigrationSnapshot
  readonly typescript: TypeScriptMigrationSnapshot
}): MigrationComparison => {
  const differences: MigrationDifference[] = []
  const { goldenCase, python, typescript } = input

  addDifference(differences, "identity", "python.caseID", goldenCase.caseID, python.caseID, true)
  addDifference(differences, "identity", "typescript.caseID", goldenCase.caseID, typescript.caseID, true)
  addDifference(differences, "identity", "python.category", goldenCase.legacyCategory, python.category, true)
  addDifference(differences, "identity", "typescript.suiteID", goldenCase.suiteID, typescript.suiteID, true)
  addDifference(differences, "identity", "typescript.suiteRevision", goldenCase.suiteRevision, typescript.suiteRevision, true)
  addDifference(differences, "identity", "typescript.caseRevision", goldenCase.caseRevision, typescript.caseRevision, true)

  addDifference(differences, "manifest", "python.fixtureDigest", goldenCase.fixtureDigest, python.fixtureDigest, true)
  addDifference(differences, "manifest", "typescript.fixtureDigest", goldenCase.fixtureDigest, typescript.fixtureDigest, true)

  addDifference(differences, "result", "passed", python.passed, typescript.passed, true)
  addDifference(differences, "result", "score", python.score, typescript.score, true)

  addDifference(differences, "platform", "platform", python.platform, typescript.platform, false)
  addDifference(differences, "tool-surface", "toolSurfaceRevision", python.toolSurfaceRevision, typescript.toolSurfaceRevision, false)
  addDifference(differences, "token-estimator", "tokenEstimatorID", python.tokenEstimatorID, typescript.tokenEstimatorID, false)
  addDifference(differences, "provider-adapter", "providerAdapterID", python.providerAdapterID, typescript.providerAdapterID, false)

  const blockingDifferences = differences.filter((difference) => difference.blocking)
  const explanations = differences.filter((difference) => !difference.blocking)
  const equivalent = blockingDifferences.length === 0
  return {
    caseID: goldenCase.caseID,
    status: equivalent ? (explanations.length === 0 ? "equivalent" : "equivalent-with-explanations") : "incompatible",
    equivalent,
    differences,
    blockingDifferences,
    explanations,
  }
}
