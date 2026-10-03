import { describe, expect, mock, test } from "bun:test"
import { batch, createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionMessageInfo } from "@arforge-ai/client/promise"
import type { Part, SessionStatus } from "@arforge-ai/sdk/v2"
import { normalizeSessionMessages } from "@/utils/session-message"

// Exercise browser reactivity with `bun --conditions=browser test`.
mock.module("@arforge-ai/session-ui/message-part", () => ({
  renderable: (part: Part, showReasoning: boolean) => {
    if (part.type === "reasoning" && !showReasoning) return false
    return part.type !== "text" && part.type !== "reasoning" || part.text.trim().length > 0
  },
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) => refs.map((ref) => ({
    type: "part" as const,
    key: ref.part.id,
    ref: { messageID: ref.messageID, partID: ref.part.id },
  })),
}))

const { createTimelineProjection } = await import("./projection")
const { TimelineRow } = await import("./timeline-row")

function sourceTurns(count: number): SessionMessageInfo[] {
  return Array.from({ length: count }, (_, index) => [
    { id: userID(index), type: "user" as const, text: `Question ${index}`, time: { created: index * 2 + 1 } },
    {
      id: assistantID(index), type: "assistant" as const, agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [{ type: "text" as const, text: `Answer ${index}` }, { type: "reasoning" as const, text: `Reasoning ${index}` }],
      time: { created: index * 2 + 2 },
    },
  ]).flat()
}

const userID = (index: number) => `msg_${String(index).padStart(4, "0")}_user`
const assistantID = (index: number) => `msg_${String(index).padStart(4, "0")}_assistant`

function fixture(count: number) {
  const source = sourceTurns(count)
  const normalized = normalizeSessionMessages("ses_projection", source)
  const [state, setState] = createStore({
    source,
    messages: normalized.messages,
    parts: Object.fromEntries(normalized.parts) as Record<string, Part[]>,
    status: { type: "busy" } as SessionStatus,
    showReasoning: true,
    inlineComments: true,
  })
  const [revision, setRevision] = createSignal(0)
  const reads = new Set<string>()
  const projection = createTimelineProjection({
    messages: () => state.messages,
    userMessages: () => state.messages.filter((message) => message.role === "user"),
    sessionMessages: () => { revision(); return state.source },
    parts: (messageID) => { reads.add(messageID); return state.parts[messageID] ?? [] },
    status: () => state.status,
    showReasoningSummaries: () => state.showReasoning,
    inlineComments: () => state.inlineComments,
  })
  const updateText = (messageID: string, text: string) => setState("parts", messageID, (parts) =>
    parts.map((part, index) => index === 0 && part.type === "text" ? { ...part, text } : part),
  )
  return { state, setState, reads, projection, updateText, refresh: () => setRevision((value) => value + 1) }
}

function withFixture(count: number, run: (value: ReturnType<typeof fixture>) => void) {
  createRoot((dispose) => {
    try { run(fixture(count)) } finally { dispose() }
  })
}

describe("incremental timeline projection", () => {
  test("a streaming delta does not read 320 historical turns", () => withFixture(321, (value) => {
    const before = value.projection.rows()
    value.reads.clear()
    value.updateText(assistantID(320), "Updated streaming answer")
    expect(value.projection.rows()).toBe(before)
    expect([...value.reads].sort()).toEqual([userID(320), assistantID(320)].sort())
    expect(value.projection.activeMessageID()).toBe(userID(320))
  }))

  test("membership refreshes keep unchanged turn calculations and row identities", () => withFixture(3, (value) => {
    const before = value.projection.rows()
    value.reads.clear()
    value.refresh()
    expect(value.projection.rows()).toBe(before)
    expect(value.reads.size).toBe(0)
  }))

  test("editing a historical turn only recalculates that turn", () => withFixture(3, (value) => {
    const before = value.projection.rows()
    value.reads.clear()
    value.updateText(assistantID(0), "Updated historical answer")
    expect(value.projection.rows()).toBe(before)
    expect([...value.reads].sort()).toEqual([userID(0), assistantID(0)].sort())
  }))

  test("empty and restored text changes row membership without stale lookup indexes", () => withFixture(3, (value) => {
    const id = assistantID(2)
    const partID = value.state.parts[id]![0]!.id
    const key = `assistant-part:${userID(2)}:${partID}`
    const previousFirst = value.projection.rows()[0]
    value.updateText(id, "")
    expect(value.projection.rowByKey().has(key)).toBe(false)
    value.updateText(id, "Restored answer")
    expect(value.projection.rowByKey().has(key)).toBe(true)
    expect(value.projection.rows()[0]).toBe(previousFirst)
    expect(value.projection.messageRowIndex().get(userID(0))).toBe(0)
    expect(value.projection.messageLastRowIndex().get(userID(2))).toBe(value.projection.rows().length - 1)
  }))

  test("reasoning and layout preferences still invalidate the required turns", () => withFixture(3, (value) => {
    const beforeCount = value.projection.rows().length
    value.setState("showReasoning", false)
    const rows = value.projection.rows()
    expect(rows.length).toBe(beforeCount - 3 + 1)
    expect(rows.filter((row) => row._tag === "Thinking").map((row) => row.userMessageID)).toEqual([userID(2)])
    value.reads.clear()
    value.setState("inlineComments", false)
    value.projection.rows()
    expect(value.reads.size).toBe(6)
    value.setState("showReasoning", true)
    expect(value.projection.rows().length).toBe(beforeCount)
  }))

  test("busy, retry and idle states update the active turn", () => withFixture(2, (value) => {
    value.setState("showReasoning", false)
    expect(value.projection.rows().some((row) => row._tag === "Thinking")).toBe(true)
    value.setState("status", { type: "retry", attempt: 1, message: "Retrying", next: 1 })
    expect(value.projection.rows().filter((row) => row._tag === "Retry").map((row) => row.userMessageID)).toEqual([userID(1)])
    expect(value.projection.rows().some((row) => row._tag === "Thinking")).toBe(false)
    value.setState("status", { type: "idle" })
    expect(value.projection.rows().some((row) => row._tag === "Thinking" || row._tag === "Retry")).toBe(false)
  }))

  test("an appended user turn transfers active state without losing historical rows", () => withFixture(2, (value) => {
    value.setState("showReasoning", false)
    const oldUserRow = value.projection.rowByKey().get(`user-message:${userID(0)}`)
    const source = { id: userID(2), type: "user" as const, text: "Next question", time: { created: 10 } }
    const normalized = normalizeSessionMessages("ses_projection", [source])
    batch(() => {
      value.setState("source", (messages) => [...messages, source])
      value.setState("messages", (messages) => [...messages, ...normalized.messages])
      value.setState("parts", userID(2), normalized.parts.get(userID(2)) ?? [])
    })
    expect(value.projection.activeMessageID()).toBe(userID(2))
    expect(value.projection.rows().filter((row) => row._tag === "Thinking").map((row) => row.userMessageID)).toEqual([userID(2)])
    expect(value.projection.rowByKey().get(`user-message:${userID(0)}`)).toBe(oldUserRow)
  }))

  test("reordering turns updates active state, turn gaps and navigation indexes", () => withFixture(3, (value) => {
    const source = [...value.state.source]
    value.setState("source", [...source.slice(4), ...source.slice(0, 4)])
    expect(value.projection.activeMessageID()).toBe(userID(1))
    expect(value.projection.rows()[0]?._tag).toBe("UserMessage")
    expect(value.projection.rows()[0]?.userMessageID).toBe(userID(2))
    expect(value.projection.messageRowIndex().get(userID(2))).toBe(0)
    expect(new Set(value.projection.rows().map(TimelineRow.key)).size).toBe(value.projection.rows().length)
  }))

  test("removed turns release their reactive part subscriptions", () => withFixture(3, (value) => {
    batch(() => {
      value.setState("source", (messages) => messages.filter((message) => message.id !== userID(0) && message.id !== assistantID(0)))
      value.setState("messages", (messages) => messages.filter((message) => message.id !== userID(0) && message.id !== assistantID(0)))
    })
    expect(value.projection.rows().some((row) => row.userMessageID === userID(0))).toBe(false)
    expect(value.projection.messageRowIndex().get(userID(1))).toBe(0)
    value.reads.clear()
    value.updateText(assistantID(0), "Removed turn update")
    value.projection.rows()
    expect(value.reads.size).toBe(0)
  }))

  test("disposing the projection releases every turn owner", () => {
    let value!: ReturnType<typeof fixture>
    const dispose = createRoot((dispose) => { value = fixture(3); value.projection.rows(); return dispose })
    dispose()
    value.reads.clear()
    value.updateText(assistantID(2), "Update after disposal")
    expect(value.reads.size).toBe(0)
  })
})
