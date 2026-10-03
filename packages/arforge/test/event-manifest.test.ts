import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { EventManifest as SchemaEventManifest } from "@arforge-ai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(160)
    expect(EventManifest.Durable.get("authorizer.control.asked.1")).toBe(AgentRuntime.ControlEvent.Asked)
    expect(EventManifest.Durable.get("authorizer.control.replied.1")).toBe(AgentRuntime.ControlEvent.Replied)
    expect(EventManifest.Durable.get("agent.action.mutation-intent-recorded.1")).toBe(
      AgentRuntime.Event.ActionMutationIntentRecorded,
    )
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
