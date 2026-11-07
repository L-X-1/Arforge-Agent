import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { PersonalWorkspace } from "@arforge-ai/schema/personal-workspace"
import { historyPresentationEvent, projectRunHistory, readSessionHistory, type SessionHistoryEvent, type RunHistorySummary } from "./execution-run-history-model"

const sessionID = "ses_history_owned"
function event(value: SessionHistoryEvent): SessionHistoryEvent {
  Schema.decodeUnknownSync(SessionEvent.Durable)(value)
  return value
}
const eventBase = (seq: number) => ({ id: `evt_history_${seq}`, durable: { aggregateID: sessionID, seq, version: 1 }, location: { directory: "/owned" } })
const eventData = (seq: number) => ({ sessionID, timestamp: 1000 + seq })
const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
function turn(start: number, runID: string | undefined, suffix: string) {
  const assistantMessageID = `msg_assistant_${suffix}`
  return [
    event({ ...eventBase(start), type: "session.next.prompted", data: { ...eventData(start), messageID: `msg_user_${suffix}`, prompt: { text: `Prompt ${suffix}` }, delivery: "steer" } }),
    event({ ...eventBase(start + 1), type: "session.next.step.started", data: { ...eventData(start + 1), assistantMessageID, ...(runID ? { runID } : {}), agent: "build", model: { providerID: "fixture", id: suffix } } }),
    event({ ...eventBase(start + 2), type: "session.next.text.started", data: { ...eventData(start + 2), assistantMessageID, textID: `text_${suffix}` } }),
    event({ ...eventBase(start + 3), type: "session.next.text.ended", data: { ...eventData(start + 3), assistantMessageID, textID: `text_${suffix}`, text: `Exact original answer ${suffix}\r\nEND 😀` } }),
    event({ ...eventBase(start + 4), type: "session.next.step.ended", data: { ...eventData(start + 4), assistantMessageID, finish: "stop", cost: 0, tokens } }),
  ]
}
const currentSource = Schema.decodeUnknownSync(PersonalWorkspace.RunSource)({ inspectability: "current", projectID: "project", directory: "/owned" })
const summary = (runID: string): RunHistorySummary => ({ runID, sessionID, status: "completed", source: currentSource, createdAt: 1000, updatedAt: 2000 })

describe("durable session run history", () => {
  test("normalizes only nullable retryCount at the presentation boundary without changing raw evidence or JSON nulls", () => {
    const raw = {
      id: "evt_history_nullable", type: "session.next.prompted" as const,
      durable: { aggregateID: sessionID, seq: 1, version: 1 }, location: { directory: "/owned" },
      metadata: { evidence: { nullable: null, nested: [null, "kept"] } },
      data: { sessionID, timestamp: 1001, messageID: "msg_nullable_user", delivery: "steer" as const,
        prompt: { text: "Original nullable format", system: { text: "Keep original fields", source: "request" as const, scope: "turn" as const }, route: { agent: "build", model: { providerID: "fixture", id: "original" } },
          format: { type: "json_schema" as const, schema: { type: "object", properties: { nullable: { default: null, type: ["string", "null"] } } }, retryCount: null } },
      },
    }
    const original = JSON.stringify(raw)
    const presented = historyPresentationEvent(raw)
    if (presented.type !== "session.next.prompted") throw new Error("Wrong event type")
    expect(presented.data.prompt.format).toEqual({ type: "json_schema", schema: raw.data.prompt.format.schema })
    expect(presented.data.prompt.system).toBe(raw.data.prompt.system)
    expect(presented.data.prompt.route).toEqual(raw.data.prompt.route)
    expect(presented.metadata).toEqual(raw.metadata)
    expect(presented.durable).toEqual(raw.durable)
    expect(JSON.stringify(raw)).toBe(original)
    Schema.decodeUnknownSync(SessionEvent.Durable)(presented)
    expect(historyPresentationEvent({ ...raw, data: { ...raw.data, prompt: { ...raw.data.prompt, format: { ...raw.data.prompt.format, retryCount: 0 } } } }).data).toEqual({ ...raw.data, prompt: { ...raw.data.prompt, format: { ...raw.data.prompt.format, retryCount: 0 } } })
    const queued: Extract<SessionHistoryEvent, { type: "session.next.prompt.admitted" | "session.next.prompt.queue.updated" }>[] = [
      { ...raw, type: "session.next.prompt.admitted" },
      { ...raw, type: "session.next.prompt.queue.updated", data: { ...raw.data, expectedAdmittedSeq: 1 } },
    ]
    for (const record of queued) {
      const evidence = JSON.stringify(record)
      const normalized = historyPresentationEvent(record)
      if (normalized.type !== "session.next.prompt.admitted" && normalized.type !== "session.next.prompt.queue.updated") throw new Error("Wrong queue event type")
      expect(normalized.type).toBe(record.type)
      expect(normalized.data.prompt.format).toEqual({ type: "json_schema", schema: raw.data.prompt.format.schema })
      if (normalized.type === "session.next.prompt.queue.updated") expect(normalized.data.expectedAdmittedSeq).toBe(1)
      Schema.decodeUnknownSync(SessionEvent.Durable)(normalized)
      expect(JSON.stringify(record)).toBe(evidence)
    }
  })
  test("joins two actual runs by exact assistant identity without mixing their model or output", () => {
    const history = projectRunHistory(sessionID, [...turn(1, "run_old", "old-model"), ...turn(6, "run_new", "new-model")], [summary("run_old"), summary("run_new")])
    expect(history.runs.find(run => run.runID === "run_old")?.models).toEqual(["fixture/old-model"])
    expect(history.runs.find(run => run.runID === "run_new")?.assistantIDs).toEqual(["msg_assistant_new-model"])
    expect(history.steps("run_old").flatMap(step => step.sections?.map(section => section.content) ?? [])).toEqual(["Exact original answer old-model\r\nEND 😀"])
    expect(history.steps("run_new").flatMap(step => step.sections?.map(section => section.content) ?? [])).toEqual(["Exact original answer new-model\r\nEND 😀"])
  })
  test("two queued turns can belong to the same actual run", () => {
    const history = projectRunHistory(sessionID, [...turn(1, "run_shared", "first"), ...turn(6, "run_shared", "second")], [summary("run_shared")])
    expect(history.runs).toHaveLength(1)
    expect(history.runs[0]!.assistantIDs).toHaveLength(2)
    expect(history.steps("run_shared").flatMap(step => step.sections?.map(section => section.content) ?? [])).toEqual(["Exact original answer first\r\nEND 😀", "Exact original answer second\r\nEND 😀"])
  })
  test("legacy missing run bindings remain separate and never join the nearest run", () => {
    const history = projectRunHistory(sessionID, [...turn(1, "run_real", "bound"), ...turn(6, undefined, "legacy")], [summary("run_real")])
    expect(history.unboundAssistantIDs).toEqual(["msg_assistant_legacy"])
    expect(history.runs[0]!.assistantIDs).toEqual(["msg_assistant_bound"])
    expect(history.steps("run_real")).toHaveLength(1)
  })
  test("keeps pre-step failed runs and missing summary/source honest", () => {
    const history = projectRunHistory(sessionID, turn(1, "run_not_in_snapshot", "old"), [{ ...summary("run_failed"), status: "failed" }])
    expect(history.runs.find(run => run.runID === "run_failed")?.assistantIDs).toEqual([])
    expect(history.steps("run_failed")).toEqual([])
    expect(history.runs.find(run => run.runID === "run_not_in_snapshot")?.summary).toBeUndefined()
  })
  test("preserves cross-source records and excludes foreign-session summaries", () => {
    const foreign = { ...summary("run_elsewhere"), source: Schema.decodeUnknownSync(PersonalWorkspace.RunSource)({ inspectability: "requires-navigation", projectID: "global", directory: "/other" }) }
    const history = projectRunHistory(sessionID, [], [foreign, { ...summary("run_other_session"), sessionID: "ses_other" }])
    expect(history.runs.map(run => run.runID)).toEqual(["run_elsewhere"])
    expect(history.runs[0]!.summary?.source).toEqual(foreign.source)
  })
  test("paginates by aggregate sequence and deduplicates overlap", async () => {
    const events = turn(1, "run_real", "model"), calls: number[] = []
    const result = await readSessionHistory(sessionID, async input => {
      calls.push(input.after)
      return input.after === 0 ? { data: events.slice(0, 3), hasMore: true } : { data: events.slice(2), hasMore: false }
    }, new AbortController().signal)
    expect(calls).toEqual([0, 3])
    expect(result.map(item => item.durable?.seq)).toEqual([1, 2, 3, 4, 5])
  })
  test("rejects a non-advancing cursor and ignores aborted late pages", async () => {
    await expect(readSessionHistory(sessionID, async () => ({ data: [], hasMore: true }), new AbortController().signal)).rejects.toThrow("did not advance")
    const controller = new AbortController()
    await expect(readSessionHistory(sessionID, async () => { controller.abort(new Error("source changed")); return { data: turn(1, "run_old", "old"), hasMore: false } }, controller.signal)).rejects.toThrow("source changed")
  })
})
