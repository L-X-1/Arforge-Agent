/** Trusted, read-only provenance producer for terminal Session Memory candidates. */
import { createHash } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { usesPostgres } from "./database/dialect"
import { extractCandidates } from "./memory-extraction"
import { makeLocationNode } from "./effect/app-node"
import { EventTable } from "./event/sql"
import { EventV2 } from "./event"
import { ExperienceEvidenceTable } from "./experience-store/sql"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { FSUtil } from "./fs-util"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { AbsolutePath } from "./schema"
import { DurableAction } from "./runtime/durable-action"
import { DurableRun } from "./runtime/durable-run"
import { freezeVerifierInput, VerifierRegistry } from "./runtime/verifier"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./session/sql"
import { PromptSystem } from "./session/prompt-system"
import { parseRequestEnvelopeJson } from "./session/request-envelope"
import { canonicalHash } from "./util/canonical-hash"

const MAX_BYTES = 50 * 1024
const issued = new WeakSet<object>()
// Readonly types are not a runtime authority boundary. Seal the complete
// returned receipt graph, including nested Evidence and copied identity.
const seal = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) seal(Reflect.get(value, key))
    Object.freeze(value)
  }
  return value
}
export interface Settlement {
  readonly identity: Database.Principal
  readonly directory: string
  readonly projectID: string
  readonly runID: AgentRuntime.RunID
  readonly runStatus: AgentRuntime.RunStatus
  readonly prompts: ReadonlyArray<{
    readonly messageID: SessionMessage.ID
    readonly text: string
    readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  }>
  readonly evidence: ReadonlyArray<AgentRuntime.Evidence>
}
export const isIssued = (value: Settlement) => issued.has(value)

export class Service extends Context.Service<
  Service,
  {
    readonly collect: (runID: AgentRuntime.RunID) => Effect.Effect<Settlement | undefined>
  }
>()("@arforge/MemoryRunEvidence") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const reader = yield* ReadToolFileSystem.Service
    const runs = yield* DurableRun.Service
    const actions = yield* DurableAction.Service
    return Service.of({
      collect: (runID) =>
        Effect.gen(function* () {
          const identity = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
          // Durable aggregate readers also serve the local single-owner runtime;
          // explicitly fence their source before loading on behalf of a tenant.
          const owned = yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, runID),
                eq(EventTable.tenant_id, identity.tenantID),
                eq(EventTable.owner_user_id, identity.userID),
              ),
            )
            .limit(1)
            .get()
          if (!owned) return undefined
          const run = (yield* runs.load(runID)).run
          if (
            !("sessionID" in run) ||
            !["completed", "failed", "cancelled"].includes(run.status) ||
            run.location !== location.directory
          )
            return undefined
          const session = yield* db
            .select()
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, run.sessionID),
                eq(SessionTable.tenant_id, identity.tenantID),
                eq(SessionTable.owner_user_id, identity.userID),
              ),
            )
            .get()
          if (!session || session.directory !== location.directory || session.project_id !== run.project)
            return undefined
          // The database owns JSON dialect selection; foreign Run envelopes
          // must never be materialized/decoded in this terminal projection.
          const currentRun = usesPostgres
            ? sql`${EventTable.data}::jsonb ->> 'runID' = ${runID}`
            : sql`json_extract(${EventTable.data}, '$.runID') = ${runID}`
          const requests = yield* db
            .select()
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, run.sessionID),
                eq(EventTable.tenant_id, identity.tenantID),
                eq(EventTable.owner_user_id, identity.userID),
                eq(EventTable.type, EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1)),
                currentRun,
              ),
            )
            .orderBy(asc(EventTable.seq))
            .all()
          const matched = new Map<
            SessionMessage.ID,
            {
              readonly messageID: SessionMessage.ID
              readonly text: string
              readonly admittedSeq: number
              readonly evidenceIDs: AgentRuntime.EvidenceID[]
            }
          >()
          for (const row of requests) {
            const user = yield* db
              .select({ id: SessionMessageTable.id })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, run.sessionID),
                  eq(SessionMessageTable.type, "user"),
                  eq(SessionMessageTable.tenant_id, identity.tenantID),
                  eq(SessionMessageTable.owner_user_id, identity.userID),
                  lt(SessionMessageTable.seq, row.seq),
                ),
              )
              .orderBy(desc(SessionMessageTable.seq))
              .limit(1)
              .get()
            if (!user) continue
            const input = yield* db
              .select({
                id: SessionInputTable.id,
                prompt: SessionInputTable.prompt,
                admittedSeq: SessionInputTable.admitted_seq,
              })
              .from(SessionInputTable)
              .where(
                and(
                  eq(SessionInputTable.id, user.id),
                  eq(SessionInputTable.session_id, run.sessionID),
                  eq(SessionInputTable.tenant_id, identity.tenantID),
                  eq(SessionInputTable.owner_user_id, identity.userID),
                  isNotNull(SessionInputTable.promoted_seq),
                ),
              )
              .limit(1)
              .get()
            // Share the actual writer's extractor, not an independently maintained
            // regex or a caller-supplied semantic verdict. No candidate means no
            // envelope parse, Action replay, or file inspection is needed.
            if (!input || extractCandidates(input.prompt.text).length === 0) continue
            const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(row.data)
            const envelope = parseRequestEnvelopeJson(data.envelope)
            if (
              envelope.execution.run_id !== runID ||
              envelope.request_digest !== data.requestDigest ||
              envelope.execution.prompt_digest !== PromptSystem.promptDigest(input.prompt)
            )
              continue
            matched.set(input.id, {
              messageID: input.id,
              text: input.prompt.text,
              admittedSeq: input.admittedSeq,
              evidenceIDs: [],
            })
          }
          // Admission order remains explicit; promoted_seq is only a promotion
          // receipt and is never treated as message/event sequence equivalence.
          const prompts = [...matched.values()]
            .sort((a, b) => a.admittedSeq - b.admittedSeq)
            .map(({ admittedSeq: _admittedSeq, ...prompt }) => prompt)
          if (!prompts.length) return undefined
          const evidence: AgentRuntime.Evidence[] = []
          // Preserve ordinary unverified extraction for a legacy global-project
          // Session in this exact directory. Verified file provenance also
          // requires the current project binding.
          if (run.status === "completed" && run.project === location.project.id) {
            const settled = yield* actions.list({ runID, limit: 500 })
            for (const item of settled) {
              const proof = yield* Effect.gen(function* () {
                const { action, observation } = item
                if (
                  action.name !== "write" ||
                  action.runID !== runID ||
                  action.status !== "settled" ||
                  !("sessionID" in action) ||
                  action.sessionID !== run.sessionID ||
                  action.subject?.type !== "session" ||
                  action.subject.sessionID !== run.sessionID ||
                  observation?.status !== "succeeded" ||
                  observation.actionID !== action.id ||
                  !action.inputDigest ||
                  !action.intentDigest
                )
                  return undefined
                const ownedAction = yield* db
                  .select({ id: EventTable.id })
                  .from(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, action.id),
                      eq(EventTable.tenant_id, identity.tenantID),
                      eq(EventTable.owner_user_id, identity.userID),
                    ),
                  )
                  .limit(1)
                  .get()
                if (!ownedAction) return undefined
                const source = yield* db
                  .select()
                  .from(SessionMessageTable)
                  .where(
                    and(
                      eq(SessionMessageTable.id, SessionMessage.ID.make(action.subject.assistantMessageID)),
                      eq(SessionMessageTable.session_id, run.sessionID),
                      eq(SessionMessageTable.type, "assistant"),
                      eq(SessionMessageTable.tenant_id, identity.tenantID),
                      eq(SessionMessageTable.owner_user_id, identity.userID),
                    ),
                  )
                  .get()
                if (!source) return undefined
                const user = yield* db
                  .select({ id: SessionMessageTable.id })
                  .from(SessionMessageTable)
                  .where(
                    and(
                      eq(SessionMessageTable.session_id, run.sessionID),
                      eq(SessionMessageTable.type, "user"),
                      lt(SessionMessageTable.seq, source.seq),
                      eq(SessionMessageTable.tenant_id, identity.tenantID),
                      eq(SessionMessageTable.owner_user_id, identity.userID),
                    ),
                  )
                  .orderBy(desc(SessionMessageTable.seq))
                  .limit(1)
                  .get()
                const prompt = prompts.find((value) => value.messageID === user?.id)
                if (!prompt) return undefined
                const assistant = Schema.decodeUnknownSync(SessionMessage.Message)({
                  ...source.data,
                  id: source.id,
                  type: source.type,
                })
                if (assistant.type !== "assistant") return undefined
                const subject = action.subject
                const tool = assistant.content.find((part) => part.type === "tool" && part.id === subject.toolCallID)
                if (
                  tool?.type !== "tool" ||
                  tool.name !== "write" ||
                  tool.state.status !== "completed" ||
                  canonicalHash(tool.state.input) !== action.inputDigest
                )
                  return undefined
                const input = tool.state.input
                if (
                  typeof input.path !== "string" ||
                  typeof input.content !== "string" ||
                  Buffer.byteLength(input.content) > MAX_BYTES ||
                  /\.(xlsx|docx|pptx|pdf)$/i.test(input.path)
                )
                  return undefined
                const intendedContent = input.content
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                if (
                  target.externalDirectory ||
                  !FSUtil.contains(location.directory, target.canonical) ||
                  !action.resources.includes(target.resource)
                )
                  return undefined
                const output = observation.output
                if (output?.encoding !== "json" || observation.outputDigest !== output.digest) return undefined
                if (createHash("sha256").update(JSON.stringify(output.value)).digest("hex") !== output.digest)
                  return undefined
                const { structured } = Schema.decodeUnknownSync(
                  Schema.Struct({
                    structured: Schema.Struct({
                      operation: Schema.Literal("write"),
                      target: Schema.String,
                      resource: Schema.String,
                    }),
                  }),
                )(output.value)
                if (
                  structured.target !== target.canonical ||
                  structured.resource !== target.resource ||
                  structured.operation !== "write"
                )
                  return undefined
                const expected = createHash("sha256").update(input.content).digest("hex")
                const registry = new VerifierRegistry()
                registry.register({
                  actionKind: "memory-owned-text-write",
                  actionVersion: "1",
                  readOnly: true,
                  credentialScope: "independent",
                  verify: async (_frozen, context) => {
                    const check = await Effect.runPromise(
                      Effect.gen(function* () {
                        // Bound before the canonical guarded read. No external URI,
                        // provider text, or arbitrary model-proposed path can authorize IO.
                        const info = yield* fs.stat(target.canonical)
                        if (Number(info.size) > MAX_BYTES || context.signal.aborted) return false
                        const file = yield* reader.read(
                          AbsolutePath.make(target.canonical),
                          target.resource,
                          {},
                          { preserveBOM: true },
                        )
                        if (!("encoding" in file) || file.encoding !== "utf8" || context.signal.aborted) return false
                        const content = Buffer.from(file.content)
                        if (content.length > MAX_BYTES) return false
                        // Ordinary write preserves a pre-existing UTF-8 BOM.
                        const bytes =
                          content[0] === 0xef &&
                          content[1] === 0xbb &&
                          content[2] === 0xbf &&
                          !intendedContent.startsWith("\uFEFF")
                            ? content.subarray(3)
                            : content
                        return createHash("sha256").update(bytes).digest("hex") === expected
                      }),
                      { signal: context.signal },
                    )
                    return [
                      {
                        command:
                          "independent owned file bytes equal committed write input (UTF-8; preserved BOM permitted); not memory-claim semantic validation",
                        exitCode: check ? 0 : 1,
                        output: check ? "postimage matches" : "postimage mismatch or unavailable",
                      },
                    ]
                  },
                })
                const verified = yield* Effect.tryPromise(() =>
                  registry.verify(
                    freezeVerifierInput({
                      frozenIntent: {
                        actionKind: "memory-owned-text-write",
                        actionVersion: "1",
                        intentDigest: action.intentDigest!,
                        payload: {
                          inputDigest: action.inputDigest,
                          resource: target.resource,
                          expectedDigest: expected,
                        },
                      },
                      observation: {
                        status: observation.status,
                        observationDigest: observation.outputDigest!,
                        summary: observation.summary,
                        values: {},
                      },
                      artifactRefs: [{ kind: "file", ref: target.resource, digest: expected }],
                      runID,
                      actionID: action.id,
                      observationID: observation.id,
                    }),
                  ),
                )
                if (!verified.evaluation.passed) return undefined
                // Keep the narrow claim visible to source consumers, not only in a private check.
                const result = AgentRuntime.Evidence.make({
                  ...verified.evidence,
                  summary:
                    "Independent workspace file reread matches committed successful write input; does not verify the semantic truth of the proposed Memory.",
                })
                prompt.evidenceIDs.push(result.id)
                return result
              }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              if (proof) evidence.push(proof)
            }
          }
          const result: Settlement = {
            identity: { tenantID: identity.tenantID, userID: identity.userID },
            directory: location.directory,
            projectID: String(location.project.id),
            runID,
            runStatus: run.status,
            prompts,
            evidence,
          }
          const sealed = seal(result)
          issued.add(sealed)
          return sealed
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Memory Run provenance unavailable", { runID }).pipe(Effect.as(undefined)),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    Location.node,
    LocationMutation.node,
    FSUtil.node,
    ReadToolFileSystem.node,
    DurableRun.globalNode,
    DurableAction.globalNode,
  ],
})

/** Called only inside the Memory candidate transaction with issuer-checked facts. */
export const persist = (tx: Database.Transaction, facts: Settlement, selectedIDs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (!isIssued(facts)) return yield* Effect.die("Unissued Memory settlement provenance")
    for (const evidence of facts.evidence.filter((value) => selectedIDs.includes(value.id))) {
      const record = Schema.encodeSync(AgentRuntime.Evidence)(evidence)
      yield* tx
        .insert(ExperienceEvidenceTable)
        .values({
          tenant_id: facts.identity.tenantID,
          owner_user_id: facts.identity.userID,
          id: evidence.id,
          run_id: facts.runID,
          action_id: evidence.actionID!,
          observation_id: evidence.observationIDs![0],
          record_digest: canonicalHash(record)!,
          record,
        })
        .onConflictDoNothing()
        .run()
    }
    return undefined
  })
