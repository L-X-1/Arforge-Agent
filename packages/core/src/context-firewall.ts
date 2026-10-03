export * as ContextFirewall from "./context-firewall"

import * as ContextPackage from "./context-package"
import * as Evidence from "./evidence"
import * as SourceRegistry from "./source-registry"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"

export type Source =
  | SourceRegistry.SourceType
  | "document"
  | "remote_instruction"
  | "skill"
  | "reference"

export type Trust = "trusted" | "verified" | "untrusted" | "hostile"
export type Sensitivity = "public" | "internal" | "confidential" | "secret"

export interface Fragment {
  readonly source: Source
  readonly trust: Trust
  readonly instructionAllowed: boolean
  readonly content: string
}

const instructionSources = new Set<Source>(["system_rules", "project_rules"])

export class FirewallError extends Error {
  readonly _tag = "Context.FirewallError"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

export function make(input: Fragment): Fragment {
  if (input.instructionAllowed && (!instructionSources.has(input.source) || input.trust !== "trusted"))
    throw new FirewallError("Only trusted system/project rules may set instruction_allowed=true")
  return Object.freeze({ ...input })
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const cdata = (value: string) => value.replaceAll("]]>", "]]]]><![CDATA[>")

export function render(fragment: Fragment): string {
  const value = make(fragment)
  return [
    `<context_fragment source="${escapeAttribute(value.source)}" trust="${escapeAttribute(value.trust)}" instruction_allowed="${value.instructionAllowed ? "true" : "false"}">`,
    "<content><![CDATA[",
    cdata(value.content),
    "]]></content>",
    "</context_fragment>",
  ].join("\n")
}

export const trustedProjectRules = (filename: string, content: string) =>
  render({
    source: "project_rules",
    trust: "trusted",
    instructionAllowed: true,
    content: `<project_rules filename="${escapeAttribute(filename)}">\n${content}\n</project_rules>`,
  })

export const untrusted = (source: Exclude<Source, "system_rules" | "project_rules">, content: string) =>
  render({ source, trust: "untrusted", instructionAllowed: false, content })

export interface PackageInput {
  readonly package: ContextPackage.Package
  readonly sources?: SourceRegistry.Interface
  readonly evidence?: Evidence.Interface
  /** The maximum sensitivity that may enter a provider message. Secret is always blocked. */
  readonly maxSensitivity?: Exclude<Sensitivity, "secret">
}

export interface FirewallMessage {
  readonly unitID: string
  readonly role: ContextPackage.Message["role"]
  readonly text: string
  readonly sourceID?: string
  readonly trust: ContextPackage.ManifestEntry["trust"]
  readonly sensitivity: Sensitivity
  readonly instructionAllowed: boolean
  readonly wrapped: boolean
}

export interface BlockedUnit {
  readonly unitID: string
  readonly reason: "secret_sensitivity" | "sensitivity_limit" | "hostile_source" | "missing_source" | "missing_evidence"
  readonly sourceID?: string
}

export interface Audit {
  readonly packageDigest: string
  readonly selectedUnitIDs: ReadonlyArray<string>
  readonly instructionUnitIDs: ReadonlyArray<string>
  readonly wrappedUnitIDs: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<BlockedUnit>
}

export interface Result {
  readonly packageDigest: string
  readonly messages: ReadonlyArray<FirewallMessage>
  readonly audit: Audit
}

const sensitivityRank: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
}

const sourceLabel = (type: SourceRegistry.SourceType): Source => type

const safeRole = (message: ContextPackage.Message, instructionAllowed: boolean): ContextPackage.Message["role"] =>
  message.role === "system" && !instructionAllowed ? "context" : message.role

const freezeResult = (value: Result): Result =>
  Object.freeze({
    ...value,
    messages: Object.freeze(value.messages.map((message) => Object.freeze({ ...message }))),
    audit: Object.freeze({
      ...value.audit,
      selectedUnitIDs: Object.freeze([...value.audit.selectedUnitIDs]),
      instructionUnitIDs: Object.freeze([...value.audit.instructionUnitIDs]),
      wrappedUnitIDs: Object.freeze([...value.audit.wrappedUnitIDs]),
      blocked: Object.freeze(value.audit.blocked.map((item) => Object.freeze({ ...item }))),
    }),
  })

function assertManifestIntegrity(value: ContextPackage.Package): void {
  const selected = value.manifest.filter((entry) => entry.selected)
  if (selected.length !== value.messages.length) throw new FirewallError("selected manifest and provider messages diverge")
  const selectedIDs = new Set(selected.map((entry) => entry.unitID))
  const messageIDs = new Set(value.messages.map((message) => message.unitID))
  if (selectedIDs.size !== selected.length || messageIDs.size !== value.messages.length)
    throw new FirewallError("context package contains duplicate selected unit IDs")
  for (const message of value.messages) if (!selectedIDs.has(message.unitID)) throw new FirewallError("provider message is not manifest-selected")
}

function assertSourceBinding(
  entry: ContextPackage.ManifestEntry,
  source: SourceRegistry.SourceRecord | undefined,
  evidence: ReturnType<Evidence.Interface["project"]>,
  registryProvided: boolean,
  evidenceProvided: boolean,
): void {
  if (entry.sourceID !== undefined && registryProvided && source === undefined) throw new FirewallError("source is not registered")
  if (entry.evidenceID !== undefined && evidenceProvided && evidence === undefined) throw new FirewallError("evidence is not registered")
  if (source === undefined) return
  if (source.trust === "hostile") throw new FirewallError("hostile source cannot enter a provider message")
  if (source.trust === "verified" && entry.trust === "trusted") throw new FirewallError("package cannot broaden source trust")
  if (source.trust === "untrusted" && (entry.trust === "trusted" || entry.trust === "verified"))
    throw new FirewallError("package cannot broaden source trust")
  if (entry.instructionAllowed && (!source.instructionAllowed || source.trust !== "trusted"))
    throw new FirewallError("package cannot broaden source instruction permission")
  if (entry.sensitivity !== undefined && sensitivityRank[entry.sensitivity] < sensitivityRank[source.sensitivity])
    throw new FirewallError("package cannot lower source sensitivity")
  if (evidence !== undefined) {
    if (evidence.sourceID !== entry.sourceID) throw new FirewallError("evidence source binding mismatch")
    if (entry.sourceDigest !== undefined && evidence.contentDigest !== entry.sourceDigest)
      throw new FirewallError("evidence content digest mismatch")
    if (entry.instructionAllowed && !evidence.instructionAllowed) throw new FirewallError("evidence cannot broaden instruction permission")
    if (sensitivityRank[evidence.sensitivity] > sensitivityRank[source.sensitivity])
      throw new FirewallError("evidence sensitivity is inconsistent with source")
  }
}

/**
 * Re-checks a digest-bound Context Package at the provider boundary.
 * Untrusted material is always wrapped as data and a system role never grants it authority.
 */
export function apply(input: PackageInput): Result {
  const value = ContextPackage.verify(input.package)
  assertManifestIntegrity(value)
  const maxSensitivity = input.maxSensitivity ?? "confidential"
  const byID = new Map(value.manifest.map((entry) => [entry.unitID, entry]))
  const messages: FirewallMessage[] = []
  const blocked: BlockedUnit[] = []
  const instructionUnitIDs: string[] = []
  const wrappedUnitIDs: string[] = []

  for (const message of value.messages) {
    const entry = byID.get(message.unitID)
    if (entry === undefined) throw new FirewallError("provider message is missing manifest metadata")
    const source = entry.sourceID === undefined ? undefined : input.sources?.get(entry.sourceID)
    const evidence =
      entry.evidenceID === undefined
        ? undefined
        : input.evidence?.project(Schema.decodeUnknownSync(AgentRuntime.EvidenceID)(entry.evidenceID))
    assertSourceBinding(entry, source, evidence, input.sources !== undefined, input.evidence !== undefined)
    const sensitivity = entry.sensitivity ?? source?.sensitivity ?? "internal"
    if (sensitivity === "secret") {
      blocked.push({ unitID: entry.unitID, reason: "secret_sensitivity", ...(entry.sourceID === undefined ? {} : { sourceID: entry.sourceID }) })
      continue
    }
    if (sensitivityRank[sensitivity] > sensitivityRank[maxSensitivity]) {
      blocked.push({ unitID: entry.unitID, reason: "sensitivity_limit", ...(entry.sourceID === undefined ? {} : { sourceID: entry.sourceID }) })
      continue
    }
    if (source?.trust === "hostile") {
      blocked.push({ unitID: entry.unitID, reason: "hostile_source", ...(entry.sourceID === undefined ? {} : { sourceID: entry.sourceID }) })
      continue
    }
    const instructionAllowed = entry.instructionAllowed === true
    if (instructionAllowed) {
      if (input.sources === undefined || entry.sourceID === undefined || source === undefined)
        throw new FirewallError("instruction segment requires an explicitly registered source")
      instructionUnitIDs.push(entry.unitID)
    }
    const wrapped = !instructionAllowed
    const trust = entry.trust
    const text = wrapped
      ? render({
          source: source === undefined ? "reference" : sourceLabel(source.type),
          trust: "untrusted",
          instructionAllowed: false,
          content: entry.sourceID === undefined ? message.text : `source_id=${entry.sourceID}\n${message.text}`,
        })
      : message.text
    if (wrapped) wrappedUnitIDs.push(entry.unitID)
    messages.push({
      unitID: entry.unitID,
      role: safeRole(message, instructionAllowed),
      text,
      ...(entry.sourceID === undefined ? {} : { sourceID: entry.sourceID }),
      trust,
      sensitivity,
      instructionAllowed,
      wrapped,
    })
  }
  return freezeResult({
    packageDigest: value.digest,
    messages,
    audit: {
      packageDigest: value.digest,
      selectedUnitIDs: value.messages.map((message) => message.unitID),
      instructionUnitIDs,
      wrappedUnitIDs,
      blocked,
    },
  })
}

export const auditPackage = apply
