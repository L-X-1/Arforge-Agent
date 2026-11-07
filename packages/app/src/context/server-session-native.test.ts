import { describe, expect, test } from "bun:test"
import type { ArforgeEvent } from "@arforge-ai/client/promise"
import type { ArforgeClient, Session } from "@arforge-ai/sdk/v2/client"
import { Schema } from "effect"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { unwrap } from "solid-js/store"
import { captureReplyPrompt } from "@arforge-ai/session-ui/message-reply-action-run"
import { createApiForServer } from "@/utils/server"
import { adaptLegacyServerEvent, adaptServerEvent, coalesceServerEvents } from "./server-sdk"
import type { CurrentServerEvent, NativeRunStateEvent } from "./server-session-native-reducer"
import { createServerSession } from "./server-session"

const sessionID = "ses_native_live"
const model = { id: "good", providerID: "isolated-loopback" }
const location = { directory: "/isolated" }
const native = (type: string, data: object) => {
  const timestamp = type === "session.next.prompted" ? 1000 : type === "session.next.step.ended" ? 1003 : 1001
  const event = {
    id: `evt_${type}_${JSON.stringify(data).length}`,
    type,
    location,
    data: { sessionID, timestamp, ...data },
  }
  // Validate the fixture against the real wire contract, including timestamp and content IDs.
  Schema.decodeUnknownSync(SessionEvent.All)(event)
  return event as unknown as ArforgeEvent
}
function setup() {
  const requests: string[] = []
  const client = {
    session: {
      get: async () => {
        requests.push("get")
        throw new Error("No refresh allowed")
      },
    },
  } as unknown as ArforgeClient
  const store = createServerSession(client)
  store.remember({
    id: sessionID,
    slug: "native",
    title: "Native live",
    directory: location.directory,
    projectID: "project",
    version: "1",
    time: { created: 1, updated: 1 },
  } as Session)
  const apply = (...events: CurrentServerEvent[]) => {
    for (const { payload } of coalesceServerEvents(
      events.map((event) => ({ directory: location.directory, payload: adaptServerEvent(event) })),
    )) {
      if (payload.current) store.applyV2(payload.current)
      store.apply(payload)
    }
  }
  return { store, requests, apply }
}

describe("native live session projection", () => {
  test("renders structured read output from native events without a refresh", () => {
    const { store, requests, apply } = setup()
    const output = "native first line\n".repeat(40) + "native final line"
    apply(
      native("session.next.prompted", { messageID: "msg_1_user", prompt: { text: "read source" }, delivery: "steer" }),
      native("session.next.step.started", { assistantMessageID: "msg_2_assistant", agent: "build", model }),
      native("session.next.tool.input.started", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        name: "read",
      }),
      native("session.next.tool.called", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        tool: "read",
        input: { path: "/isolated/source.txt" },
        provider: { executed: false },
      }),
      native("session.next.tool.success", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        content: [],
        structured: { type: "text-page", content: output, mime: "text/plain", offset: 1, truncated: false },
        provider: { executed: false },
      }),
    )
    expect(unwrap(store.data.part.msg_2_assistant)?.find((part) => part.type === "tool")).toMatchObject({
      id: "call_read",
      state: { status: "completed", output },
    })
    expect(requests).toEqual([])
  })

  test("projects API-admitted native prompt and streaming reply without reconnect or history refresh", () => {
    const { store, requests, apply } = setup()
    apply(
      native("session.next.prompt.admitted", {
        messageID: "msg_1_user",
        prompt: { text: "Native prompt" },
        delivery: "steer",
      }),
    )
    expect(store.data.message[sessionID] ?? []).toEqual([])
    apply(
      native("session.next.model.switched", { messageID: "msg_0_model", model }),
      native("session.next.prompted", {
        messageID: "msg_1_user",
        prompt: { text: "Native prompt" },
        delivery: "steer",
      }),
      native("session.next.step.started", { assistantMessageID: "msg_2_assistant", agent: "build", model }),
      native("session.next.text.started", { assistantMessageID: "msg_2_assistant", textID: "text_a" }),
      native("session.next.text.delta", { assistantMessageID: "msg_2_assistant", textID: "text_a", delta: "Native " }),
      native("session.next.text.delta", { assistantMessageID: "msg_2_assistant", textID: "text_a", delta: "reply" }),
    )
    expect(store.data.message[sessionID]?.map((item) => item.id)).toEqual(["msg_1_user", "msg_2_assistant"])
    expect(
      unwrap(store.data.part.msg_2_assistant)
        ?.filter((item) => item.type === "text")
        .map((item) => item.text),
    ).toEqual(["Native reply"])
    expect(unwrap(store.data.message[sessionID]?.find((item) => item.role === "assistant"))).toMatchObject({
      role: "assistant",
      providerID: model.providerID,
      modelID: model.id,
    })
    expect(store.data.session_status[sessionID]).toEqual({ type: "busy" })
    apply(
      native("session.next.text.ended", {
        assistantMessageID: "msg_2_assistant",
        textID: "text_a",
        text: "Native reply complete",
      }),
      native("session.next.step.ended", {
        assistantMessageID: "msg_2_assistant",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    )
    expect(
      unwrap(store.data.part.msg_2_assistant)
        ?.filter((item) => item.type === "text")
        .map((item) => item.text),
    ).toEqual(["Native reply complete"])
    expect(unwrap(store.data.message[sessionID]?.find((item) => item.role === "assistant"))).toMatchObject({
      time: { completed: 1003 },
    })
    expect(requests).toEqual([])
  })

  test("keeps native text and reasoning identities across interleaved fragments and repeated full-value boundaries", () => {
    const { store, apply } = setup()
    apply(
      native("session.next.prompted", { messageID: "msg_1_user", prompt: { text: "Interleaved" }, delivery: "steer" }),
      native("session.next.step.started", { assistantMessageID: "msg_2_assistant", agent: "build", model }),
      native("session.next.text.started", { assistantMessageID: "msg_2_assistant", textID: "a" }),
      native("session.next.reasoning.started", { assistantMessageID: "msg_2_assistant", reasoningID: "r" }),
      native("session.next.text.started", { assistantMessageID: "msg_2_assistant", textID: "b" }),
      native("session.next.text.delta", { assistantMessageID: "msg_2_assistant", textID: "b", delta: "second" }),
      native("session.next.reasoning.delta", {
        assistantMessageID: "msg_2_assistant",
        reasoningID: "r",
        delta: "reason",
      }),
      native("session.next.text.delta", { assistantMessageID: "msg_2_assistant", textID: "a", delta: "first" }),
      native("session.next.text.ended", {
        assistantMessageID: "msg_2_assistant",
        textID: "b",
        text: "second complete",
      }),
      native("session.next.text.ended", {
        assistantMessageID: "msg_2_assistant",
        textID: "b",
        text: "second complete",
      }),
    )
    const assistant = unwrap(store.data.session_message[sessionID]?.at(-1))
    expect(assistant).toMatchObject({
      type: "assistant",
      content: [
        { type: "text", id: "a", text: "first" },
        { type: "reasoning", id: "r", text: "reason" },
        { type: "text", id: "b", text: "second complete" },
      ],
    })
  })
  test("settles native busy state only for the active run, including pre-step failures", () => {
    const { store } = setup()
    const state = (runID: string, to: NativeRunStateEvent["data"]["to"]) =>
      store.applyV2({
        id: `evt_${runID}_${to}`,
        type: "agent.run.state-changed",
        location,
        data: { sessionID, runID, from: "queued", to, reason: "isolated transition", changedAt: 1000 },
      })
    state("run_old", "running")
    state("run_current", "running")
    state("run_old", "completed")
    expect(store.data.session_status[sessionID]).toEqual({ type: "busy" })
    state("run_current", "failed")
    expect(store.data.session_status[sessionID]).toEqual({ type: "idle" })
    expect(store.data.message[sessionID] ?? []).toEqual([])
  })

  test("a paused current run releases busy presentation while a stale pause cannot settle a newer run", () => {
    const { store, requests, apply } = setup()
    const change = (runID: string, to: NativeRunStateEvent["data"]["to"]): NativeRunStateEvent => ({
      id: `evt_pause_${runID}_${to}`,
      type: "agent.run.state-changed",
      location,
      data: { runID, sessionID, from: "running", to, reason: "Execution state changed", changedAt: 1004 },
    })
    apply(change("run_paused", "running"))
    expect(store.data.session_status[sessionID]).toEqual({ type: "busy" })
    apply(change("run_paused", "paused"))
    expect(store.data.session_status[sessionID]).toEqual({ type: "idle" })
    apply(change("run_newer", "running"))
    apply(change("run_paused", "paused"))
    expect(store.data.session_status[sessionID]).toEqual({ type: "busy" })
    apply(change("run_newer", "paused"))
    expect(store.data.session_status[sessionID]).toEqual({ type: "idle" })
    expect(requests).toEqual([])
  })

  test("adapts the same current event on the retained legacy transport without inventing a message identity", () => {
    const event = native("session.next.prompted", {
      messageID: "msg_1_user",
      prompt: { text: "Legacy transport" },
      delivery: "steer",
    })
    const { store } = setup()
    const adapted = adaptLegacyServerEvent({
      id: event.id,
      type: event.type,
      properties: event.data,
    } as unknown as Parameters<typeof adaptLegacyServerEvent>[0])
    expect(adapted.current).toBeDefined()
    if (adapted.current) store.applyV2(adapted.current)
    expect(store.data.message[sessionID]?.map((item) => item.id)).toEqual(["msg_1_user"])
  })

  test("retains both registered resource owners when regenerating a live queued prompt", async () => {
    const { store, apply, requests } = setup()
    const uri = "evidence://shared/manual"
    const files = [
      {
        uri,
        mime: "text/plain",
        name: "manual A",
        resource: { server: "owned-a", uri },
        source: { start: 0, end: 7, text: "@manual" },
      },
      { uri, mime: "text/plain", name: "manual B", resource: { server: "owned-b", uri } },
    ]
    const id = "msg_1_user"
    apply(
      native("session.next.prompted", {
        messageID: id,
        prompt: { text: "@manual", files, route: { agent: "build", model } },
        delivery: "queue",
      }),
    )
    const user = unwrap(store.data.message[sessionID] ?? []).find((message) => message.id === id)
    if (user?.role !== "user") throw new Error("Live promoted user message missing")
    const retry = captureReplyPrompt(user, unwrap(store.data.part[id] ?? []), "msg_regen", {
      providerID: "current",
      modelID: "selected",
    })
    const sent: unknown[] = []
    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const body = await request.json()
        sent.push(body.prompt)
        return Response.json({ data: { ...body, admittedSeq: 1, timeCreated: 1, delivery: "steer" } })
      },
      { preconnect() {} },
    )
    await createApiForServer({ server: { url: "http://owned-live-retry.invalid" }, fetch: fetcher }).session.prompt(
      retry,
    )
    expect(sent).toMatchObject([{ files, route: { agent: "build", model: { providerID: "current", id: "selected" } } }])
    expect(requests).toEqual([])
  })

  test("preserves native attachment references and tool progress through the presentation adapter", () => {
    const { store, apply } = setup()
    apply(
      native("session.next.prompted", {
        messageID: "msg_1_user",
        prompt: {
          text: "Read @sample.txt",
          files: [
            {
              uri: "file:///isolated/sample.txt",
              mime: "text/plain",
              name: "sample.txt",
              source: { start: 5, end: 16, text: "@sample.txt" },
            },
          ],
        },
        delivery: "steer",
      }),
      native("session.next.step.started", { assistantMessageID: "msg_2_assistant", agent: "build", model }),
      native("session.next.tool.input.started", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        name: "read",
      }),
      native("session.next.tool.called", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        tool: "read",
        input: { path: "/isolated/sample.txt" },
        provider: { executed: false },
      }),
      native("session.next.tool.progress", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        structured: {},
        content: [{ type: "text", text: "Partial output" }],
      }),
    )
    expect(unwrap(store.data.part.msg_1_user)?.find((item) => item.type === "file")).toMatchObject({
      url: "file:///isolated/sample.txt",
      filename: "sample.txt",
      source: { path: "sample.txt" },
    })
    expect(unwrap(store.data.part.msg_2_assistant)?.find((item) => item.type === "tool")).toMatchObject({
      tool: "read",
      state: { status: "running", input: { path: "/isolated/sample.txt" } },
    })
    expect(unwrap(store.data.session_message[sessionID]?.find((item) => item.type === "assistant"))).toMatchObject({
      content: [
        {
          type: "tool",
          id: "call_read",
          state: { status: "running", content: [{ type: "text", text: "Partial output" }] },
        },
      ],
    })
    apply(
      native("session.next.tool.success", {
        assistantMessageID: "msg_2_assistant",
        callID: "call_read",
        structured: {},
        content: [{ type: "text", text: "Complete output" }],
        provider: { executed: false },
      }),
    )
    expect(unwrap(store.data.part.msg_2_assistant)?.find((item) => item.type === "tool")).toMatchObject({
      state: { status: "completed", output: "Complete output" },
    })
  })
})
