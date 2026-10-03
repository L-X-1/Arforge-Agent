import { resolve } from "node:path"
import * as MemoryEvaluation from "../src/memory-evaluation"

type JsonObject = { readonly [key: string]: unknown }
type BaselineQuery = {
  readonly queryID?: unknown
  readonly relevantIDs?: unknown
  readonly retrievedIDs?: unknown
  readonly latencyMs?: unknown
}

const root = resolve(import.meta.dir, "../../..")
const datasetRoot = resolve(root, "artifacts/external-query-sets/beir-scifact")
const inputPath = resolve(datasetRoot, "baseline-recall-at-10.json")
const outputPath = resolve(datasetRoot, "memory-evaluation-v1.json")

const object = (value: unknown, name: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return Object.fromEntries(Object.entries(value))
}
const string = (value: unknown, name: string): string => {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  return value
}
const strings = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error(`${name} must be string[]`)
  return value
}
const number = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`)
  return value
}

const main = async () => {
  const report = object(JSON.parse(await Bun.file(inputPath).text()), "report")
  const dataset = object(report.dataset, "dataset")
  const baseline = object(report.baseline, "baseline")
  const queryRows = Array.isArray(baseline.perQuery) ? baseline.perQuery : []
  const queries = queryRows.map((raw, index) => {
    const query = object(raw, `baseline.perQuery[${index}]`) as BaselineQuery
    return {
      queryID: string(query.queryID, `query[${index}].queryID`),
      relevantIDs: strings(query.relevantIDs, `query[${index}].relevantIDs`),
      retrievedIDs: strings(query.retrievedIDs, `query[${index}].retrievedIDs`),
      latencyMs: number(query.latencyMs, `query[${index}].latencyMs`),
    }
  })
  const queryIDs = queries.map((query) => query.queryID)
  const snapshot = MemoryEvaluation.evaluate(
    {
      dataset: {
        id: string(dataset.id, "dataset.id"),
        revision: `test-${string(dataset.downloadedZipMD5, "dataset.downloadedZipMD5")}`,
        source: "external",
        queryIDs,
      },
      topK: number(baseline.limit, "baseline.limit"),
      queries,
    },
    "baseline",
  )
  const output = {
    schemaVersion: 1,
    dataset: {
      id: snapshot.dataset.id,
      revision: snapshot.dataset.revision,
      source: snapshot.dataset.source,
      queryCount: queryIDs.length,
      officialMD5: string(dataset.officialMD5, "dataset.officialMD5"),
      downloadedZipMD5: string(dataset.downloadedZipMD5, "dataset.downloadedZipMD5"),
    },
    baseline: {
      retriever: string(baseline.retriever, "baseline.retriever"),
      snapshot,
    },
    rawContentPersisted: false,
  }
  await Bun.write(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify({ outputPath, dataset: output.dataset, metrics: snapshot.metrics }, null, 2))
}

await main()
