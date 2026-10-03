import { expect, test } from "bun:test"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { DateTime, Schema } from "effect"
import { CoreMessageCompat } from "@/session/core-message-compat"

const created = DateTime.makeUnsafe("2026-08-30T01:00:00.000Z")
const completed = DateTime.makeUnsafe("2026-08-30T01:00:01.000Z")
const sessionID = SessionV2.ID.make("ses_core_compat")
const parentID = SessionV1.MessageID.make("msg_core_parent")

test("projects one terminal Core assistant into a deterministic schema-valid V1 DTO", () => {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_core_assistant"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model-a"), providerID: ProviderV2.ID.make("provider-a") },
    content: [
      { type: "text", id: "text-1", text: "Completed the review." },
      {
        type: "reasoning",
        id: "reasoning-1",
        text: "Checked the relevant files.",
        providerMetadata: { provider: { trace: "redacted" } },
        time: { created, completed },
      },
      {
        type: "tool",
        id: "call-1",
        name: "read",
        provider: { executed: false },
        state: {
          status: "completed",
          input: { filePath: "README.md" },
          structured: { title: "README", lines: 3 },
          content: [
            { type: "text", text: "file contents" },
            { type: "file", uri: "data:text/plain;base64,b2s=", mime: "text/plain", name: "result.txt" },
          ],
        },
        time: { created, ran: created, completed },
      },
    ],
    structured: { answer: "ok" },
    finish: "stop",
    cost: 0.25,
    tokens: { input: 4, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
    time: { created, completed },
  })
  const input = { message, sessionID, parentID, path: { cwd: "C:/project", root: "C:/project" } }
  const first = CoreMessageCompat.projectAssistant(input)
  const second = CoreMessageCompat.projectAssistant(input)

  expect(Schema.decodeUnknownSync(SessionV1.WithParts)(first)).toEqual(first)
  expect(second).toEqual(first)
  expect(first.info).toMatchObject({
    id: "msg_core_assistant",
    parentID,
    role: "assistant",
    agent: "build",
    modelID: "model-a",
    providerID: "provider-a",
    finish: "stop",
    structured: { answer: "ok" },
    path: { cwd: "C:/project", root: "C:/project" },
    tokens: { total: 12 },
  })
  expect(first.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Completed the review." }),
      expect.objectContaining({ type: "reasoning", text: "Checked the relevant files." }),
      expect.objectContaining({
        type: "tool",
        callID: "call-1",
        state: expect.objectContaining({
          status: "completed",
          title: "README",
          output: "file contents",
          attachments: [expect.objectContaining({ filename: "result.txt", mime: "text/plain" })],
        }),
      }),
      expect.objectContaining({ type: "step-finish", reason: "stop" }),
    ]),
  )
})

test("projects pending, running, and failed Core tools without inventing success", () => {
  const message = SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_core_tool_states"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model-a"), providerID: ProviderV2.ID.make("provider-a") },
    content: [
      {
        type: "tool",
        id: "pending",
        name: "read",
        state: { status: "pending", input: '{"filePath":"README.md"}' },
        time: { created },
      },
      {
        type: "tool",
        id: "running",
        name: "task",
        state: { status: "running", input: { agent: "reviewer" }, structured: { title: "Reviewing" }, content: [] },
        time: { created, ran: created },
      },
      {
        type: "tool",
        id: "failed",
        name: "write",
        state: {
          status: "error",
          input: { filePath: "README.md" },
          structured: { phase: "preflight" },
          content: [],
          error: { type: "unknown", message: "Permission denied" },
        },
        time: { created, ran: created, completed },
      },
    ],
    finish: "error",
    error: { type: "unknown", message: "One tool failed" },
    time: { created, completed },
  })
  const projected = CoreMessageCompat.projectAssistant({
    message,
    sessionID,
    parentID,
    path: { cwd: "C:/project", root: "C:/project" },
  })

  expect(Schema.decodeUnknownSync(SessionV1.WithParts)(projected)).toEqual(projected)
  expect(projected.info.role === "assistant" ? projected.info.error : undefined).toMatchObject({
    name: "UnknownError",
    data: { message: "One tool failed" },
  })
  expect(projected.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual([
    "pending",
    "running",
    "error",
  ])
})
