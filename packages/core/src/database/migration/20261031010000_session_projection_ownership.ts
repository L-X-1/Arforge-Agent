import { sql, type SQL } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Event } from "@arforge-ai/schema/event"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { Prompt } from "@arforge-ai/schema/prompt"
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "../../identity/sql"
import { SessionMessageUpdater } from "../../session/message-updater"
import type { DatabaseMigration } from "../migration"

type Owner = { id: string; tenant_id: string; owner_user_id: string; seq: number }
type StoredEvent = { id: string; aggregate_id: string; seq: number; type: string; data: string; tenant_id: string; owner_user_id: string }
type Input = { id: string; session_id: string; admitted_seq: number; promoted_seq: number | null; delivery: string; time_created: number; prompt: string }
type Message = { id: string; session_id: string; type: string; seq: number; data: string }
type Origin = { stored: StoredEvent; event: SessionEvent.DurableEvent }

// Reuse the existing immutable manifest and pure append semantics. No runtime
// services, event replay, model calls or second projection registry are created.
const definitions = Event.durable(SessionEvent.DurableDefinitions)
const decodeEvent = Schema.decodeUnknownOption(SessionEvent.Durable)
const decodePrompt = Schema.decodeUnknownOption(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return undefined } }
const samePrompt = (a: unknown, b: Prompt) => {
  const decoded = decodePrompt(a)
  return Option.isSome(decoded) && JSON.stringify(encodePrompt(decoded.value)) === JSON.stringify(encodePrompt(b))
}
const decode = (stored: StoredEvent): Origin | undefined => {
  const definition = definitions.get(stored.type)
  if (!definition?.durable) return
  const data = parse(stored.data)
  const event = decodeEvent({ id: stored.id, type: definition.type, data, durable: { aggregateID: stored.aggregate_id, seq: stored.seq, version: definition.durable.version } })
  return Option.isSome(event) && event.value.data.sessionID === stored.aggregate_id ? { stored, event: event.value } : undefined
}
const owned = (owner: Owner, origin: Origin) => origin.stored.tenant_id === owner.tenant_id && origin.stored.owner_user_id === owner.owner_user_id
const proof = (origin: Origin) => sql`EXISTS (
  SELECT 1 FROM event WHERE id = ${origin.stored.id} AND aggregate_id = ${origin.stored.aggregate_id}
    AND seq = ${origin.stored.seq} AND type = ${origin.stored.type} AND data = ${origin.stored.data}
    AND tenant_id = ${origin.stored.tenant_id} AND owner_user_id = ${origin.stored.owner_user_id}
)`
const sessionProof = (owner: Owner) => sql`EXISTS (
  SELECT 1 FROM session s JOIN event_sequence q ON q.aggregate_id = s.id
  WHERE s.id = ${owner.id} AND s.tenant_id = ${owner.tenant_id} AND s.owner_user_id = ${owner.owner_user_id}
    AND q.tenant_id = s.tenant_id AND q.owner_user_id = s.owner_user_id AND q.seq = ${owner.seq}
)`

function inputProofs(owner: Owner, input: Input, admissions: Origin[], promotions: Origin[], changes: Origin[]): Origin[] | undefined {
  const admission = admissions.length === 1 ? admissions[0] : admissions.length === 0 && input.promoted_seq === input.admitted_seq && promotions.length === 1 ? promotions[0] : undefined
  const promotion = promotions.length === 1 ? promotions[0] : undefined
  if (!admission || !owned(owner, admission) || admission.stored.seq !== input.admitted_seq) return
  if (admission.event.type !== SessionEvent.PromptAdmitted.type && admission.event.type !== SessionEvent.Prompted.type) return
  if (admission.event.data.delivery !== input.delivery || DateTime.toEpochMillis(admission.event.data.timestamp) !== input.time_created) return
  if (input.promoted_seq === null ? promotions.length !== 0 : !promotion || !owned(owner, promotion) || promotion.stored.seq !== input.promoted_seq) return
  let prompt = admission.event.data.prompt
  const origins = [admission]
  for (const change of changes) {
    if (!owned(owner, change) || change.stored.seq <= input.admitted_seq || (input.promoted_seq !== null && change.stored.seq >= input.promoted_seq)) return
    if (change.event.type !== SessionEvent.PromptQueueUpdated.type || input.delivery !== "queue" || change.event.data.expectedAdmittedSeq !== input.admitted_seq || change.event.data.delivery !== input.delivery) return
    prompt = change.event.data.prompt
    origins.push(change)
  }
  if (promotion) {
    if (promotion.event.type !== SessionEvent.Prompted.type || promotion.event.data.delivery !== input.delivery || !samePrompt(promotion.event.data.prompt, prompt)) return
    origins.push(promotion)
  }
  return samePrompt(parse(input.prompt), prompt) ? origins : undefined
}

export default {
  id: "20261031010000_session_projection_ownership",
  up(tx) {
    return Effect.gen(function* () {
      // Only SQLite's known two-column default defect is eligible. The parent
      // and sequence must already agree on a nonlocal owner, without a caller.
      const owners = yield* tx.all<Owner>(sql`
        SELECT s.id, s.tenant_id, s.owner_user_id, q.seq
        FROM session s JOIN event_sequence q ON q.aggregate_id = s.id
        WHERE (s.tenant_id <> ${LOCAL_TENANT_ID} OR s.owner_user_id <> ${LOCAL_USER_ID})
          AND q.tenant_id = s.tenant_id AND q.owner_user_id = s.owner_user_id
          AND (EXISTS (SELECT 1 FROM session_input i WHERE i.session_id = s.id AND i.tenant_id = ${LOCAL_TENANT_ID} AND i.owner_user_id = ${LOCAL_USER_ID})
            OR EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id AND m.tenant_id = ${LOCAL_TENANT_ID} AND m.owner_user_id = ${LOCAL_USER_ID}))
      `)
      for (const owner of owners) {
        // Do not partially repair a Session with a foreign-stamped child.
        const foreign = yield* tx.get(sql`SELECT 1 FROM (
          SELECT tenant_id, owner_user_id FROM session_input WHERE session_id = ${owner.id}
          UNION ALL SELECT tenant_id, owner_user_id FROM session_message WHERE session_id = ${owner.id}
        ) WHERE NOT ((tenant_id = ${LOCAL_TENANT_ID} AND owner_user_id = ${LOCAL_USER_ID})
          OR (tenant_id = ${owner.tenant_id} AND owner_user_id = ${owner.owner_user_id})) LIMIT 1`)
        if (foreign) continue
        const stored = yield* tx.all<StoredEvent>(sql`SELECT * FROM event WHERE aggregate_id = ${owner.id} ORDER BY seq`)
        if (stored.at(-1)?.seq !== owner.seq) continue
        const admissions = new Map<string, Origin[]>()
        const promotions = new Map<string, Origin[]>()
        const changes = new Map<string, Origin[]>()
        const appends = new Map<string, { origin: Origin; type: string }[]>()
        let invalid = false
        for (const row of stored) {
          const origin = decode(row)
          if (!origin) { if (definitions.has(row.type)) invalid = true; continue }
          if (origin.event.type === SessionEvent.PromptAdmitted.type || origin.event.type === SessionEvent.Prompted.type) {
            const index = origin.event.type === SessionEvent.PromptAdmitted.type ? admissions : promotions
            const id = origin.event.data.messageID
            index.set(id, [...(index.get(id) ?? []), origin])
          }
          if (origin.event.type === SessionEvent.PromptQueueUpdated.type || origin.event.type === SessionEvent.PromptQueueRemoved.type) {
            const id = origin.event.data.messageID
            changes.set(id, [...(changes.get(id) ?? []), origin])
          }
          const state: SessionMessageUpdater.MemoryState = { messages: [] }
          yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(state), origin.event)
          for (const message of state.messages) appends.set(message.id, [...(appends.get(message.id) ?? []), { origin, type: message.type }])
        }

        const plans: { update: SQL; origins: Origin[] }[] = []
        const inputs = yield* tx.all<Input>(sql`SELECT * FROM session_input WHERE session_id = ${owner.id} AND tenant_id = ${LOCAL_TENANT_ID} AND owner_user_id = ${LOCAL_USER_ID}`)
        for (const input of inputs) {
          const origins = inputProofs(owner, input, admissions.get(input.id) ?? [], promotions.get(input.id) ?? [], changes.get(input.id) ?? [])
          if (!origins) { invalid = true; continue }
          plans.push({ origins, update: sql`UPDATE session_input SET tenant_id = ${owner.tenant_id}, owner_user_id = ${owner.owner_user_id}
            WHERE id = ${input.id} AND session_id = ${owner.id} AND tenant_id = ${LOCAL_TENANT_ID} AND owner_user_id = ${LOCAL_USER_ID}
              AND admitted_seq = ${input.admitted_seq} AND promoted_seq IS ${input.promoted_seq}
              AND delivery = ${input.delivery} AND time_created = ${input.time_created} AND prompt = ${input.prompt}
              AND ${sessionProof(owner)} AND ${sql.join(origins.map(proof), sql` AND `)} RETURNING id` })
        }

        const messages = yield* tx.all<Message>(sql`SELECT * FROM session_message WHERE session_id = ${owner.id} AND tenant_id = ${LOCAL_TENANT_ID} AND owner_user_id = ${LOCAL_USER_ID}`)
        for (const message of messages) {
          const origins = appends.get(message.id) ?? []
          const origin = origins.length === 1 ? origins[0] : undefined
          if (!origin || !owned(owner, origin.origin) || origin.type !== message.type || origin.origin.stored.seq !== message.seq) { invalid = true; continue }
          plans.push({ origins: [origin.origin], update: sql`UPDATE session_message SET tenant_id = ${owner.tenant_id}, owner_user_id = ${owner.owner_user_id}
            WHERE id = ${message.id} AND session_id = ${owner.id} AND type = ${message.type} AND seq = ${message.seq} AND data = ${message.data}
              AND tenant_id = ${LOCAL_TENANT_ID} AND owner_user_id = ${LOCAL_USER_ID}
              AND ${sessionProof(owner)} AND ${proof(origin.origin)} RETURNING id` })
        }
        if (invalid) continue
        for (const plan of plans) {
          if (!(yield* tx.get(plan.update))) return yield* Effect.die(new Error("Session projection authority changed during migration"))
        }
        for (const origin of plans.flatMap(plan => plan.origins)) {
          if (!(yield* tx.get(sql`SELECT 1 WHERE ${sessionProof(owner)} AND ${proof(origin)}`))) return yield* Effect.die(new Error("Session projection authority changed during migration"))
        }
      }
    })
  },
} satisfies DatabaseMigration.Migration
