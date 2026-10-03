import { describe, expect, test } from "bun:test"
import { buildInitialStreamEvent, buildStreamDeltaEvents } from "../timeline/session-timeline-benchmark.fixture"

describe("timeline benchmark stream events", () => {
  test("routes every delta to the session and part introduced by the initial event", () => {
    const initial = buildInitialStreamEvent(8)
    const part = (initial.payload.properties as { part: { sessionID: string; messageID: string; id: string } }).part
    const deltas = buildStreamDeltaEvents(8)
    expect(deltas).toHaveLength(8)
    for (const event of deltas) {
      expect(event.directory).toBe(initial.directory)
      expect(event.payload).toMatchObject({
        type: "message.part.delta",
        properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "text" },
      })
    }
    expect((deltas.at(-1)!.payload.properties as { delta: string }).delta).toContain("benchmark-complete")
  })
})
