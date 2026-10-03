/** Original PersonalJob result codecs and read-only execution proof; no state owner or writer. */
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { Prompt } from "@arforge-ai/schema/prompt"
import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import type { DurableRun } from "./runtime/durable-run"
import type { SessionStore } from "./session/store"
import { SessionTable } from "./session/sql"
import { SessionInput } from "./session/input"
import { SessionRunUsageTable } from "./runtime/sql"
import * as RuntimeBilling from "./runtime/billing"
import { OpaqueArtifact } from "./runtime/artifact-ref"
import * as SessionCheckpoint from "./session/checkpoint"
import * as SessionRunnerHistory from "./session/runner/history"
import { parseRequestEnvelopeJson } from "./session/request-envelope"
import { canonicalHash } from "./util/canonical-hash"
import { redact } from "./redact"

const maximumSummaryLength = 8_000

export const summaryFromAssistant = (assistant: SessionMessage.Assistant | undefined) => {
  if (!assistant) return ""
  return assistant.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}

export const truncateSummary = (value: string, fallback: string) => {
  const summary = redact(value).trim().slice(0, maximumSummaryLength)
  return summary || fallback
}

export const resultDigest = (result: Omit<PersonalJob.Result, "recordedAt" | "digest">) => {
  // Effect DateTime is intentionally a non-plain runtime value. Normalize
  // nested opaque receipts to their wire representation before hashing so a
  // valid receipt can participate in the same durable result digest without
  // weakening canonicalHash's fail-closed non-plain-object rule.
  const normalized = {
    status: result.status,
    summary: result.summary,
    artifactRefs: [...result.artifactRefs],
    usage: result.usage,
    ...(result.artifacts === undefined
      ? {}
      : {
          artifacts: result.artifacts.map((artifact) => ({
            ...artifact,
            ...(artifact.artifactRef === undefined
              ? {}
              : { artifactRef: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(artifact.artifactRef) }),
          })),
        }),
  }
  const digest = canonicalHash(normalized)
  if (!digest) throw new Error("Personal job result must be canonically hashable")
  return digest
}

/**
 * Convert only already-inspected local delivery attachments into durable
 * receipts.  We do not turn an unverified snapshot path into an artifact: a
 * result must never claim content integrity without a content digest.
 */
export const artifactsFromAssistant = (
  assistant: SessionMessage.Assistant | undefined,
  sessionID: PersonalJob.Info["sessionID"],
) => {
  const seen = new Set<string>()
  const artifacts: PersonalJob.ResultArtifact[] = []
  for (const attachment of assistant?.delivery?.attachments ?? []) {
    if (seen.has(attachment.sha256)) continue
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) continue
    if (attachment.path.length > 2_048 || attachment.displayName.length > 240 || attachment.mime.length > 160) continue
    const rawReceipt = attachment.artifactRef
    let receipt: AgentRuntime.OpaqueArtifactRef | undefined
    if (rawReceipt !== undefined) {
      try {
        receipt = OpaqueArtifact.validate(rawReceipt)
      } catch {
        continue
      }
      if (
        receipt.owner.scope !== "session" ||
        receipt.owner.id !== sessionID ||
        receipt.digest !== attachment.sha256 ||
        receipt.sizeBytes !== attachment.sizeBytes ||
        receipt.mime !== attachment.mime
      )
        continue
    }
    const id = receipt?.artifactID ?? AgentRuntime.ArtifactID.make(`art_${attachment.sha256.slice(0, 32)}`)
    artifacts.push(
      PersonalJob.ResultArtifact.make({
        id,
        ...(receipt === undefined ? {} : { artifactRef: receipt }),
        kind: "primary_delivery",
        uri: attachment.path,
        name: attachment.displayName,
        mime: attachment.mime,
        sizeBytes: attachment.sizeBytes,
        digest: attachment.sha256,
      }),
    )
    seen.add(attachment.sha256)
    if (artifacts.length >= 32) break
  }
  return artifacts
}

export type StoredExecution = {
  readonly assistant: SessionMessage.Assistant
  readonly usage: PersonalJob.Result["usage"]
}

/** Read-only adapter over the existing Run, Event, Session and billing owners. */
export const readExecutionWith = (
  runtime: {
    readonly db: Database.Interface["db"]
    readonly runs: DurableRun.Interface
    readonly messages: Pick<SessionStore.Interface, "message">
  },
  job: PersonalJob.Info,
): Effect.Effect<StoredExecution | undefined> =>
  Effect.gen(function* () {
    if (!job.occurrence) return undefined
    const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
    const session = yield* runtime.db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(
        and(
          eq(SessionTable.id, job.sessionID),
          eq(SessionTable.tenant_id, principal.tenantID),
          eq(SessionTable.owner_user_id, principal.userID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!session) throw new Error("PersonalJob recovery session does not belong to the current owner.")
    const matches = (yield* runtime.runs
      .list({ sessionID: job.sessionID, limit: Number.MAX_SAFE_INTEGER })
      .pipe(Effect.orDie)).filter(
      ({ run }) =>
        "admission" in run &&
        run.admission?.personalJob?.jobID === job.id &&
        run.admission.personalJob.occurrence.messageID === job.occurrence!.messageID,
    )
    if (matches.length > 1)
      throw new Error("PersonalJob recovery found conflicting original runs; no request was sent.")
    const snapshot = matches[0]
    if (!snapshot) return undefined
    const { run } = snapshot
    if (!("admission" in run)) throw new Error("PersonalJob recovery requires its original session run.")
    if (canonicalHash(run.admission?.personalJob?.occurrence) !== canonicalHash(job.occurrence))
      throw new Error("PersonalJob recovery input identity does not match its original run.")
    if (run.status !== "completed") return undefined
    const originalInput = yield* SessionInput.find(runtime.db, job.occurrence.messageID)
    if (
      !originalInput ||
      originalInput.promotedSeq === undefined ||
      !SessionInput.equivalent(originalInput, {
        sessionID: job.sessionID,
        delivery: "queue",
        prompt: Prompt.make({ text: job.prompt }),
      })
    )
      throw new Error("PersonalJob recovery cannot verify the original consumed input.")
    const query = { sessionID: job.sessionID, runID: run.id }
    const collection = yield* SessionRunnerHistory.collectTerminalHistoryWithSource(
      SessionRunnerHistory.runnerEventRowSourceFromDatabase(runtime.db),
      query,
      { status: "completed", attempt: run.budget.attemptsUsed, requireCheckpoint: true },
    ).pipe(Effect.orDie)
    const rows = yield* collection.source.collect(query).pipe(Effect.orDie)
    const history = SessionRunnerHistory.fromEventRows(rows, query)
    const checkpoint = snapshot.checkpoint && SessionCheckpoint.fromContainer(snapshot.checkpoint.state, job.sessionID)
    if (
      !checkpoint ||
      checkpoint.legacy ||
      checkpoint.kind !== SessionCheckpoint.KIND ||
      checkpoint.needsContinuation ||
      checkpoint.dispatch
    )
      throw new Error("PersonalJob recovery requires the original completed semantic checkpoint.")
    const request = history.formalRequest
    if (!request || request.requestDigest !== checkpoint.lastTurn.requestDigest)
      throw new Error("PersonalJob recovery cannot verify its final prepared request.")
    try {
      const envelope = parseRequestEnvelopeJson(request.envelope)
      if (
        envelope.request_digest !== request.requestDigest ||
        envelope.execution.run_id !== run.id ||
        envelope.execution.turn_step !== request.turnStep
      )
        throw new Error("Request binding mismatch")
    } catch {
      // Legacy/corrupt payloads must not escape through decode error text.
      throw new Error("PersonalJob recovery cannot verify its original request envelope.")
    }
    const decodeRows = <S extends Schema.Decoder<unknown>>(definition: {
      readonly type: string
      readonly durable?: { readonly version: number }
      readonly data: S
    }): Array<{ seq: number; data: S["Type"] }> =>
      rows
        .filter(
          (row) =>
            row.aggregateID === job.sessionID &&
            row.type === EventV2.versionedType(definition.type, definition.durable!.version),
        )
        .map((row) => {
          try {
            return { seq: row.seq, data: Schema.decodeUnknownSync(definition.data)(row.data) }
          } catch {
            throw new Error("PersonalJob recovery found an invalid original assistant event.")
          }
        })
    const starts = decodeRows(SessionEvent.Step.Started).filter(
      ({ data }) => data.runID === run.id && data.requestDigest === request.requestDigest,
    )
    if (starts.length !== 1)
      throw new Error("PersonalJob recovery cannot identify one original assistant for its final request.")
    const start = starts[0]
    const endings = decodeRows(SessionEvent.Step.Ended).filter(
      ({ data }) => data.assistantMessageID === start.data.assistantMessageID,
    )
    const failures = decodeRows(SessionEvent.Step.Failed).filter(
      ({ data }) => data.assistantMessageID === start.data.assistantMessageID,
    )
    if (
      endings.length !== 1 ||
      endings[0].seq <= start.seq ||
      failures.length > 0 ||
      originalInput.promotedSeq >= start.seq
    )
      throw new Error("PersonalJob recovery cannot verify a completed original assistant.")
    const originalMessage = yield* runtime.messages.message(start.data.assistantMessageID)
    const assistant = originalMessage?.sessionID === job.sessionID ? originalMessage.message : undefined
    if (!assistant || assistant.type !== "assistant" || !assistant.time.completed || assistant.error)
      throw new Error("PersonalJob recovery is missing its original completed answer; no replacement request was sent.")
    const usageRows = yield* runtime.db
      .select()
      .from(SessionRunUsageTable)
      .where(
        and(
          eq(SessionRunUsageTable.run_id, run.id),
          eq(SessionRunUsageTable.session_id, job.sessionID),
          eq(SessionRunUsageTable.tenant_id, principal.tenantID),
          eq(SessionRunUsageTable.owner_user_id, principal.userID),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    let costMicros = 0
    if (run.admission?.billing) {
      if (usageRows.length === 0 || usageRows.some((row) => row.billing_receipt === null))
        throw new Error("PersonalJob recovery is missing its original billing receipts.")
      RuntimeBilling.makeRunScope({
        runID: run.id,
        config: { budget: run.admission.billing.budget, resolveCatalog: () => undefined },
        receipts: usageRows,
      })
      const preparedRequests = [
        ...decodeRows(SessionEvent.RequestEnvelopePrepared)
          .filter(({ data }) => data.runID === run.id)
          .map(({ data }) => data),
        ...decodeRows(SessionEvent.Compaction.RequestPrepared).map(({ data }) => data),
      ]
      const settledRequests = new Set<string>()
      for (const row of usageRows) {
        const receipt = RuntimeBilling.decodeReceipt(row.billing_receipt)
        const bound = preparedRequests.some((prepared) => {
          if (prepared.sessionID !== job.sessionID || prepared.requestDigest !== receipt.requestDigest) return false
          try {
            const envelope = parseRequestEnvelopeJson(prepared.envelope)
            return (
              envelope.request_digest === receipt.requestDigest &&
              envelope.execution.run_id === run.id &&
              envelope.request.model.provider_id === receipt.providerID &&
              envelope.request.model.model_id === receipt.modelID
            )
          } catch {
            return false
          }
        })
        if (!bound) throw new Error("PersonalJob recovery cannot bind a billing receipt to its original request.")
        settledRequests.add(receipt.requestDigest)
        costMicros += receipt.charge.amountMinor * 10 ** (6 - receipt.catalog.minorUnit)
      }
      // A valid prefix (for example, only the summary charge) cannot prove
      // complete spending when the final provider settlement has disappeared.
      if (!settledRequests.has(request.requestDigest))
        throw new Error("PersonalJob recovery is missing the billing receipt for its final completed request.")
    } else if (usageRows.some((row) => row.billing_receipt !== null)) {
      throw new Error("PersonalJob recovery found billing receipts without their original budget policy.")
    }
    const durationMs = history.attempts.reduce((total, attempt) => total + attempt.durationMs, 0)
    if (![durationMs, costMicros].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error("PersonalJob recovery usage is outside the supported accounting range.")
    return { assistant, usage: { durationMs, costMicros } }
  })

/** The same canonical result is used for normal completion and durable recovery. */
export const storedResult = (
  job: PersonalJob.Info,
  stored: StoredExecution,
): Omit<PersonalJob.Result, "recordedAt"> => {
  const artifacts = artifactsFromAssistant(stored.assistant, job.sessionID)
  const remainingDuration = Math.max(0, job.budget.maxDurationMs - job.budget.durationMsUsed)
  const overBudget =
    stored.usage.durationMs > remainingDuration ||
    stored.usage.costMicros > job.budget.maxCostMicros - job.budget.costMicrosUsed
  const result = {
    status: overBudget ? ("failed" as const) : ("completed" as const),
    summary: overBudget
      ? "The original execution exceeded the job budget."
      : truncateSummary(summaryFromAssistant(stored.assistant), "The background job completed without a text summary."),
    artifactRefs: artifacts.map((artifact) => artifact.id),
    ...(artifacts.length ? { artifacts } : {}),
    usage: { ...stored.usage, durationMs: Math.min(stored.usage.durationMs, remainingDuration) },
  }
  return { ...result, digest: resultDigest(result) }
}
