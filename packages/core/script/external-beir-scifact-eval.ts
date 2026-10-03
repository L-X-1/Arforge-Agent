import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import * as CodeRetrieval from "../src/code-retrieval"
import * as SourceRegistry from "../src/source-registry"

type JsonLine = { readonly _id?: unknown; readonly title?: unknown; readonly text?: unknown }
type Qrel = { readonly queryID: string; readonly corpusID: string; readonly score: number }

const root = resolve(import.meta.dir, "../../..")
const datasetRoot = join(root, "artifacts", "external-query-sets", "beir-scifact")
const rawRoot = join(datasetRoot, "raw", "scifact")
const reportPath = join(datasetRoot, "baseline-recall-at-10.json")
const officialURL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip"
const officialMD5 = "5f7d1de60b170fc8027bb7898e2efca1"
const queryLimit = 20
const retrievalLimit = 10
const observedAt = Date.UTC(2020, 0, 1)

const readLines = async (path: string): Promise<ReadonlyArray<JsonLine>> => {
  const text = await Bun.file(path).text()
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid BEIR JSONL object")
      return value as JsonLine
    })
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const fileMD5 = async (path: string) => createHash("md5").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex")

const sourceFor = (id: string, text: string): SourceRegistry.SourceRecord =>
  SourceRegistry.make({
    sourceID: `web:beir-scifact:${id}`,
    type: "web",
    owner: "BEIR/SciFact",
    location: `beir://scifact/${id}`,
    trust: "verified",
    instructionAllowed: false,
    sensitivity: "public",
    freshness: { observedAt },
    limits: { maxBytes: Math.max(1, new TextEncoder().encode(text).byteLength), maxTokens: 100_000 },
    provenance: { locator: `beir://scifact/${id}`, digest: `sha256:${digest(text)}` },
    redactionPolicy: { mode: "none", fields: [] },
    retrievalAdapter: "web",
  })

const stringField = (value: unknown): string => (typeof value === "string" ? value : "")

const main = async () => {
  const corpusRows = await readLines(join(rawRoot, "corpus.jsonl"))
  const queryRows = await readLines(join(rawRoot, "queries.jsonl"))
  const qrelLines = (await Bun.file(join(rawRoot, "qrels", "test.tsv")).text()).split(/\r?\n/u).filter(Boolean)
  const qrels: Qrel[] = qrelLines.slice(1).map((line) => {
    const [queryID, corpusID, score] = line.split("\t")
    if (!queryID || !corpusID || score === undefined) throw new Error("invalid BEIR qrels row")
    return { queryID, corpusID, score: Number(score) }
  })
  const relevantByQuery = new Map<string, Set<string>>()
  for (const row of qrels) {
    if (row.score <= 0) continue
    const ids = relevantByQuery.get(row.queryID) ?? new Set<string>()
    ids.add(row.corpusID)
    relevantByQuery.set(row.queryID, ids)
  }
  const queryIDs = [...relevantByQuery.keys()].toSorted().slice(0, queryLimit)
  const queries = new Map(queryRows.map((row) => [stringField(row._id), stringField(row.text)]))
  if (queryIDs.some((id) => !queries.has(id))) throw new Error("BEIR qrels references a missing query")
  const documents = corpusRows.map((row) => {
    const id = stringField(row._id)
    const text = `${stringField(row.title)}\n${stringField(row.text)}`.trim()
    return {
      source: sourceFor(id, text),
      path: `beir://scifact/${id}`,
      text,
      updatedAt: observedAt,
    }
  })
  const perQuery = []
  for (const queryID of queryIDs) {
    const startedAt = Date.now()
    const hits = await CodeRetrieval.retrieve({ text: queries.get(queryID)!, limit: retrievalLimit, embedding: "hashing" }, documents)
    const relevant = relevantByQuery.get(queryID)!
    const retrievedIDs = hits.map((hit) => hit.sourceID.slice("web:beir-scifact:".length))
    const relevantIDs = [...relevant].toSorted()
    const retrievedRelevant = retrievedIDs.filter((id) => relevant.has(id)).length
    perQuery.push({
      queryID,
      relevantIDs,
      retrievedIDs,
      relevantCount: relevant.size,
      retrievedRelevantAt10: retrievedRelevant,
      recallAt10: relevant.size === 0 ? 0 : retrievedRelevant / relevant.size,
      hitAt10: retrievedRelevant > 0,
      latencyMs: Math.max(0, Date.now() - startedAt),
    })
  }
  const relevantCount = perQuery.reduce((sum, item) => sum + item.relevantCount, 0)
  const retrievedRelevantAt10 = perQuery.reduce((sum, item) => sum + item.retrievedRelevantAt10, 0)
  const report = {
    schemaVersion: 1,
    dataset: {
      id: "beir-scifact",
      split: "test",
      source: "external",
      queryCount: queryIDs.length,
      corpusCount: corpusRows.length,
      qrelCount: qrels.length,
      officialDownloadURL: officialURL,
      officialMD5,
      downloadedZipMD5: await fileMD5(join(datasetRoot, "scifact.zip")),
    },
    baseline: {
      retriever: "@arforge-ai/core CodeRetrieval",
      embedding: "hashing",
      limit: retrievalLimit,
      queryCount: queryIDs.length,
      relevantJudgements: relevantCount,
      retrievedRelevantAt10,
      recallAt10: relevantCount === 0 ? 0 : retrievedRelevantAt10 / relevantCount,
      queryHitRateAt10: perQuery.filter((item) => item.hitAt10).length / queryIDs.length,
      perQuery,
    },
    rawContentPersisted: false,
  }
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ reportPath, dataset: report.dataset, baseline: report.baseline }, null, 2))
}

await main()
