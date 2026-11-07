import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo, SessionMessageUser as LegacyUser } from "@arforge-ai/client/promise"
import type { SessionMessageUser as CanonicalUser } from "@arforge-ai/sdk/v2/client"
import { captureReplyPrompt } from "@arforge-ai/session-ui/message-reply-action-run"
import { normalizeSessionMessages } from "./session-message"
import { createApiForServer } from "./server"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII="
// The canonical session_message data persisted by actual Native/Web14,
// queue-media-Jep7SH/exact-media-system-readonly.json (id/type are row columns).
const original = {
  id: "msg_18d2437b300121ZjUAuv7VoLbG",
  type: "user",
  time: { created: 1793369323444 },
  text: "OWNED_QUEUE_MEDIA_mvv1sfjr @owned-1px.png EDITED_ONCE",
  files: [
    {
      uri: `data:image/png;base64,${png}`,
      mime: "image/png",
      name: "owned-1px.png",
      source: { start: 27, end: 41, text: "@owned-1px.png" },
    },
  ],
  system: { text: "Owned media request: do not execute tools.", source: "request", scope: "turn" },
  route: { agent: "build", model: { id: "image-a", providerID: "media-owned", variant: "pinned-v1" } },
} satisfies CanonicalUser

function project(user: CanonicalUser | LegacyUser) {
  const context = [
    { id: "msg_agent", type: "agent-switched", agent: "build", time: { created: 1 } },
    {
      id: "msg_model",
      type: "model-switched",
      model: { id: "image-a", providerID: "media-owned", variant: "pinned-v1" },
      time: { created: 2 },
    },
  ] satisfies SessionMessageInfo[]
  const normalized = normalizeSessionMessages("ses_owned", [...context, user])
  const message = normalized.messages.find((item) => item.id === user.id)
  if (message?.role !== "user") throw new Error("Original user projection missing")
  return { message, parts: normalized.parts.get(user.id) ?? [] }
}

describe("canonical request projection for reply regeneration", () => {
  test("restores the admitted model, strength and agent before an assistant exists", () => {
    const normalized = normalizeSessionMessages("ses_owned", [original])
    expect(normalized.messages[0]).toMatchObject({
      agent: original.route.agent,
      model: { providerID: "media-owned", modelID: "image-a", variant: "pinned-v1" },
    })
  })

  test("assistant wire aliases and later fallback steps cannot replace a user's admitted route", () => {
    const source = [
      original,
      {
        id: "msg_answer",
        type: "assistant",
        agent: "worker",
        model: { providerID: "relay", id: "wire-image-alias", variant: "wire-only" },
        content: [{ type: "text", text: "First step" }],
        time: { created: 3 },
      },
      {
        id: "msg_fallback",
        type: "assistant",
        agent: "fallback-worker",
        model: { providerID: "fallback", id: "fallback-wire" },
        content: [{ type: "text", text: "Fallback step" }],
        time: { created: 4, completed: 5 },
      },
    ] satisfies (SessionMessageInfo | CanonicalUser)[]
    const before = JSON.stringify(source)
    const normalized = normalizeSessionMessages("ses_owned", source)
    expect(normalized.messages[0]).toMatchObject({
      agent: "build",
      model: { providerID: "media-owned", modelID: "image-a", variant: "pinned-v1" },
    })
    expect(normalized.messages[1]).toMatchObject({ agent: "worker", providerID: "relay", modelID: "wire-image-alias" })
    expect(normalized.messages[2]).toMatchObject({
      agent: "fallback-worker",
      providerID: "fallback",
      modelID: "fallback-wire",
    })
    expect(JSON.stringify(source)).toBe(before)
  })

  test("partial routes preserve independent agent/model intent and legacy inference on each following turn", () => {
    for (const route of [
      { agent: "review" },
      { model: { providerID: "owned", id: "configured", variant: "off" } },
      { model: { providerID: "owned", id: "configured" } },
    ]) {
      const source = [
        { ...original, route },
        {
          id: "msg_answer",
          type: "assistant",
          agent: "worker",
          model: { providerID: "wire", id: "alias", variant: "high" },
          content: [],
          time: { created: 3 },
        },
        { id: "msg_legacy", type: "user", text: "Legacy request", time: { created: 4 } },
        {
          id: "msg_legacy_answer",
          type: "assistant",
          agent: "legacy-agent",
          model: { providerID: "legacy", id: "legacy-model", variant: "auto" },
          content: [],
          time: { created: 5 },
        },
      ] satisfies (SessionMessageInfo | CanonicalUser)[]
      const normalized = normalizeSessionMessages("ses_owned", source)
      expect(normalized.messages[0]).toMatchObject({
        agent: route.agent ?? "worker",
        model: route.model
          ? { providerID: "owned", modelID: "configured", variant: route.model.variant }
          : { providerID: "wire", modelID: "alias", variant: "high" },
      })
      expect(normalized.messages[2]).toMatchObject({
        agent: "legacy-agent",
        model: { providerID: "legacy", modelID: "legacy-model", variant: "auto" },
      })
    }
  })

  test("resource identity without an at-mention remains a resource on retry", async () => {
    const uri = "evidence://shared/manual"
    const files = [{ uri, mime: "text/plain", name: "manual", resource: { server: "server-B", uri } }]
    const { message, parts } = project({ ...original, files })
    const captured = captureReplyPrompt(message, parts, "msg_no_mention")
    const requests: Request[] = []
    const fetcher = Object.assign(
      async (value: RequestInfo | URL, init?: RequestInit) => {
        const request = value instanceof Request ? value : new Request(value, init)
        requests.push(request)
        return Response.json({
          data: { ...(await request.clone().json()), admittedSeq: 1, timeCreated: 1, delivery: "steer" },
        })
      },
      { preconnect() {} },
    )
    await createApiForServer({ server: { url: "http://owned-resource-unit.invalid" }, fetch: fetcher }).session.prompt(
      captured,
    )
    expect((await requests[0].clone().json()).prompt.files).toEqual(files)
  })

  test("MCP resource identity survives canonical history and Regenerate with a different current model", async () => {
    const uri = "evidence://shared/manual"
    const files = ["server-A", "server-B"].map((server, index) => ({
      uri,
      mime: "text/plain",
      name: "manual",
      resource: { server, uri },
      source: { start: index * 8, end: index * 8 + 7, text: "@manual" },
    }))
    const user = { ...original, text: "@manual @manual", files }
    const before = JSON.stringify(user)
    const { message, parts } = project(user)
    const captured = captureReplyPrompt(message, parts, "msg_resource_retry", {
      providerID: "owned",
      modelID: "new-current",
      variant: "high",
    })
    const requests: Request[] = []
    const fetcher = Object.assign(
      async (value: RequestInfo | URL, init?: RequestInit) => {
        const request = value instanceof Request ? value : new Request(value, init)
        requests.push(request)
        return Response.json({
          data: { ...(await request.clone().json()), admittedSeq: 15, timeCreated: 2, delivery: "steer" },
        })
      },
      { preconnect() {} },
    )
    await createApiForServer({ server: { url: "http://owned-resource-unit.invalid" }, fetch: fetcher }).session.prompt(
      captured,
    )
    const body = await requests[0].clone().json()
    expect(body.prompt.files).toEqual(files)
    expect(body.prompt.system).toEqual(original.system)
    expect(body.prompt.route.model).toEqual({ id: "new-current", providerID: "owned", variant: "high" })
    expect(JSON.stringify(user)).toBe(before)
  })

  test("persisted PNG survives projection, capture and typed request serialization with the newly selected route", async () => {
    const before = JSON.stringify(original)
    const { message, parts } = project(original)
    const captured = captureReplyPrompt(message, parts, "msg_retry", {
      providerID: "media-owned",
      modelID: "other-b",
      variant: "high",
    })
    const requests: Request[] = []
    const fetcher = Object.assign(
      async (value: RequestInfo | URL, init?: RequestInit) => {
        const request = value instanceof Request ? value : new Request(value, init)
        requests.push(request)
        const body = await request.clone().json()
        return Response.json({ data: { ...body, admittedSeq: 13, timeCreated: 2, delivery: "steer" } })
      },
      { preconnect() {} },
    )
    const api = createApiForServer({ server: { url: "http://owned-projection-unit.invalid" }, fetch: fetcher })
    await api.session.prompt(captured)
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_owned/prompt")
    const body = await requests[0].clone().json()
    expect(body).toMatchObject({
      id: "msg_retry",
      prompt: {
        text: original.text,
        files: original.files,
        system: original.system,
        route: { agent: "build", model: { id: "other-b", providerID: "media-owned", variant: "high" } },
      },
    })
    expect(body.prompt.files).toEqual(original.files)
    expect(Buffer.from(body.prompt.files[0].uri.split(",")[1], "base64")).toEqual(Buffer.from(png, "base64"))
    expect(JSON.stringify(original)).toBe(before)
  })

  test("canonical attachments without mentions retain exact URIs; agent mentions round-trip", () => {
    const user = {
      ...original,
      files: [{ uri: "file:///owned/one.png?exact=1#bytes", mime: "image/png", name: "one.png" }],
      agents: [{ name: "review", source: { text: "@review", start: 0, end: 7 } }],
    } satisfies CanonicalUser
    const { message, parts } = project(user)
    const prompt = captureReplyPrompt(message, parts, "msg_retry")
    expect(prompt.files).toEqual([{ uri: user.files[0].uri, name: "one.png", mention: undefined }])
    expect(prompt.agents).toEqual([{ name: "review", mention: user.agents[0].source }])
    expect(prompt.system).toBe(original.system.text)
  })

  test("legacy inline/URI attachments and agent mentions remain supported", () => {
    const user = {
      id: "msg_legacy",
      type: "user",
      text: "legacy",
      time: { created: 1 },
      files: [
        { mime: "image/png", name: "inline.png", data: png, source: { type: "inline" } },
        {
          mime: "text/plain",
          name: "source.txt",
          data: "",
          source: { type: "uri", uri: "file:///owned/source.txt" },
          mention: { text: "@source.txt", start: 0, end: 11 },
        },
      ],
      agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
    } satisfies LegacyUser
    const { message, parts } = project(user)
    const prompt = captureReplyPrompt(message, parts, "msg_retry")
    expect(prompt.files).toEqual([
      { uri: `data:image/png;base64,${png}`, name: "inline.png", mention: undefined },
      { uri: "file:///owned/source.txt", name: "source.txt", mention: user.files[1].mention },
    ])
    expect(prompt.agents).toEqual([{ name: "review", mention: user.agents[0].mention }])
    expect(prompt.system).toBeUndefined()
  })

  test("only explicit request/turn system text is replayable, including an intentional empty instruction", () => {
    for (const system of [
      undefined,
      "unscoped runtime text",
      { text: "runtime", source: "runtime", scope: "turn" },
      { text: "project", source: "request", scope: "session" },
      { text: 1, source: "request", scope: "turn" },
      { text: "missing scope", source: "request" },
    ]) {
      const user: LegacyUser & { system?: unknown } = {
        id: "msg_runtime",
        type: "user",
        text: "original",
        time: { created: 1 },
        system,
        metadata: { system: original.system, runtimeContext: "injected" },
      }
      expect(project(user).message.system).toBeUndefined()
    }
    expect(project({ ...original, system: { ...original.system, text: "" } }).message.system).toBe("")
  })
})
