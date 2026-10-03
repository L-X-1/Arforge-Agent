import { canonicalJson, sha256Text } from "./arforge-governance"
import { hashDeclaredInput, readDeclaredJson } from "./arforge-source-snapshot"

// Separate from generated OPEN inventory. This checker never writes acceptance state.
export const CAPABILITY_LINKS_PATH = "docs/evidence/implementation/capability-links.v1.json"
type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const object = (value: unknown): ObjectValue => {
  if (!isObject(value)) throw new Error("expected object")
  return value
}
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    throw new Error("expected nonempty trimmed text")
  return value
}
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || !value.length) throw new Error("expected nonempty array")
  return value
}
const unique = (values: string[]) => {
  if (new Set(values).size !== values.length) throw new Error("duplicate identity or path")
  return values
}
const digest = (value: unknown) => {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("expected SHA-256 digest")
  return result
}
const oneOf = (value: unknown, choices: string[]) => {
  const result = text(value)
  if (!choices.includes(result)) throw new Error(`unsupported value: ${result}`)
  return result
}
const exact = (value: ObjectValue, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("unknown field")
}

export async function validateCapabilityLinks(root: string) {
  const findings: { code: string; path: string; detail: string }[] = []
  const records: { id: string; evidence_state: string; accepted: false }[] = []
  const ids = new Set<string>()
  const aliases = new Set<string>()
  const finding = (id: string, error: unknown) =>
    findings.push({ code: "LINK-INVALID", path: id, detail: String(error) })
  try {
    const manifest = object(await readDeclaredJson(root, CAPABILITY_LINKS_PATH))
    exact(manifest, ["schema_version", "records"])
    if (manifest.schema_version !== "1.0") throw new Error("unsupported schema version")
    for (const raw of array(manifest.records)) {
      let id = "<invalid-record>"
      let state = "missing"
      try {
        const record = object(raw)
        exact(record, [
          "id",
          "behavior",
          "aliases",
          "classification",
          "legacy",
          "owner",
          "scenarios",
          "limitations",
          "receipt",
        ])
        id = text(record.id)
        if (!/^[A-Z][A-Z0-9-]+$/.test(id)) throw new Error("expected stable acceptance ID without line numbers")
        if (ids.has(id)) throw new Error("duplicate acceptance ID")
        ids.add(id)
        text(record.behavior)
        oneOf(record.classification, [
          "equivalent-needs-verification",
          "merge-differences",
          "missing-port",
          "neutral-fixture",
          "excluded",
        ])
        array(record.limitations).forEach(text)
        for (const alias of unique(array(record.aliases).map(text))) {
          if (aliases.has(alias)) throw new Error(`alias already belongs to another behavior: ${alias}`)
          aliases.add(alias)
        }
        const required = new Set<string>()
        const reference = (value: unknown) => {
          const ref = object(value)
          exact(ref, ["path", "symbol"])
          text(ref.symbol) // human-declared qualified identity, not proof of semantic ownership
          required.add(text(ref.path))
        }
        array(record.legacy).forEach(reference)
        reference(record.owner)
        const scenarioIDs = unique(
          array(record.scenarios).map((value) => {
            const scenario = object(value)
            exact(scenario, ["id", "kind", "test_path", "selector", "expected"])
            oneOf(scenario.kind, ["normal", "error", "recovery", "cancel", "event-order", "data"])
            text(scenario.selector)
            text(scenario.expected)
            required.add(text(scenario.test_path))
            return text(scenario.id)
          }),
        )
        // Missing/linked owners and tests are findings even with no receipt.
        for (const file of required) await hashDeclaredInput(root, file)
        if (record.receipt !== undefined) {
          const receipt = object(record.receipt)
          exact(receipt, [
            "contract_digest",
            "inputs",
            "artifact",
            "scenario_ids",
            "outcome",
            "command",
            "environment",
            "scope",
          ])
          const { receipt: _receipt, ...contract } = record
          if (digest(receipt.contract_digest) !== sha256Text(canonicalJson(contract)))
            throw new Error("behavior contract changed")
          text(receipt.command)
          text(receipt.environment)
          text(receipt.scope)
          const covered = unique(array(receipt.scenario_ids).map(text))
          if (covered.length !== scenarioIDs.length || covered.some((value) => !scenarioIDs.includes(value)))
            throw new Error("receipt must bind exactly the declared scenarios")
          const seen: string[] = []
          for (const value of array(receipt.inputs)) {
            const input = object(value)
            exact(input, ["path", "digest"])
            const file = text(input.path)
            seen.push(file)
            if (file === CAPABILITY_LINKS_PATH) throw new Error("self-referential evidence input")
            if ((await hashDeclaredInput(root, file)) !== digest(input.digest))
              throw new Error(`input changed: ${file}`)
          }
          unique(seen)
          if ([...required].some((file) => !seen.includes(file))) throw new Error("unbound legacy, owner or test input")
          const artifact = object(receipt.artifact)
          exact(artifact, ["path", "digest"])
          const artifactPath = text(artifact.path)
          if (artifactPath === CAPABILITY_LINKS_PATH || seen.includes(artifactPath))
            throw new Error("evidence must be separate from inputs")
          if ((await hashDeclaredInput(root, artifactPath)) !== digest(artifact.digest))
            throw new Error("evidence artifact changed")
          const outcome = oneOf(receipt.outcome, ["passed", "failed"])
          state = outcome === "passed" ? "current-reported-pass" : "current-reported-failure"
        }
      } catch (error) {
        state = "invalid"
        finding(id, error)
      }
      records.push({ id, evidence_state: state, accepted: false })
    }
  } catch (error) {
    finding(CAPABILITY_LINKS_PATH, error)
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    semantics: "Structural and declared-input freshness only; reported results are not functional acceptance.",
    record_count: records.length,
    missing_evidence_count: records.filter((record) => record.evidence_state === "missing").length,
    findings,
    records,
  }
}
