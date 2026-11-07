import { describe, expect, test } from "bun:test"
import { regenerateConversationReply } from "./regenerate-reply"
import { createApiForServer, createOperationsApiForServer } from "./server"
import { captureReplyPrompt } from "@arforge-ai/session-ui/message-reply-action-run"
import type { Part, UserMessage } from "@arforge-ai/sdk/v2/client"
import { createRoot, onCleanup } from "solid-js"
import { createSessionOwnership } from "../pages/session/session-ownership"

const target = { sessionID: "ses_owned", messageID: "msg_original", expectedDirectory: "/owned/no-git" }
const checkpoint = { id: "chk_planned", sessionID: target.sessionID, label: "Before original prompt", sequence: 0, time: { created: 1 } }
const preview = { checkpoint, affectedMessages: 2, expectedLastSequence: 10, expectedRevision: "a".repeat(64), workspaceEffectsUnchanged: true as const }
const setup = () => {
  const calls: unknown[] = []
  let current = true
  const input = {
    target,
    current: () => current,
    api: {
      async rewindPreview(value: unknown) { calls.push(["preview", value]); return preview },
      async rewindApply(value: unknown) { calls.push(["apply", value]); return { checkpoint, rewoundMessages: 2, lastSequence: 0, workspaceEffectsUnchanged: true as const } },
    },
    async confirm(value: unknown): Promise<boolean> { calls.push(["confirm", value]); return true },
    async refresh() { calls.push("refresh") },
    async submit() { calls.push("submit-current-model-original-parts") },
  } satisfies Parameters<typeof regenerateConversationReply>[0]
  return { input, calls, leave: () => { current = false } }
}

describe("conversation-only reply regeneration", () => {
  test("uses the current typed preview token, then archives, resends once and refreshes", async () => {
    const { input, calls } = setup()
    expect(await regenerateConversationReply(input)).toBe("admitted")
    expect(calls).toEqual([
      ["preview", target], ["confirm", preview],
      ["apply", { ...target, expectedLastSequence: 10, expectedRevision: preview.expectedRevision }],
      "submit-current-model-original-parts", "refresh",
    ])
  })
  test("cancel only previews and confirms; no archive, checkpoint creation, refresh or resend", async () => {
    const { input, calls } = setup()
    input.confirm = async value => { calls.push(["confirm", value]); return false }
    expect(await regenerateConversationReply(input)).toBe("cancelled")
    expect(calls).toEqual([["preview", target], ["confirm", preview]])
  })
  test("a source/model selection change during preview or confirmation prevents every write", async () => {
    for (const phase of ["preview", "confirm"] as const) {
      const { input, calls, leave } = setup()
      if (phase === "preview") input.api.rewindPreview = async value => { calls.push(["preview", value]); leave(); return preview }
      else input.confirm = async value => { calls.push(["confirm", value]); leave(); return true }
      expect(await regenerateConversationReply(input)).toBe("stale")
      expect(calls.some(value => Array.isArray(value) && value[0] === "apply")).toBe(false)
      expect(calls).not.toContain("submit-current-model-original-parts")
    }
  })
  test("a stale/busy/foreign apply failure cannot resend or claim success", async () => {
    const { input, calls } = setup()
    input.api.rewindApply = async () => { throw new Error("The conversation changed. Preview again.") }
    await expect(regenerateConversationReply(input)).rejects.toThrow("Preview again")
    expect(calls).not.toContain("refresh")
    expect(calls).not.toContain("submit-current-model-original-parts")
  })
  test("a late apply receipt cannot refresh or resend into a changed source", async () => {
    const { input, calls, leave } = setup()
    const apply = input.api.rewindApply.bind(input.api)
    input.api.rewindApply = async value => { const result = await apply(value); leave(); return result }
    expect(await regenerateConversationReply(input)).toBe("stale")
    expect(calls).not.toContain("refresh")
    expect(calls).not.toContain("submit-current-model-original-parts")
  })
  test("its own archival refresh may dispose the first-prompt timeline only after the acknowledged resend", async () => {
    const { input, calls, leave } = setup()
    input.refresh = async () => { calls.push("refresh"); leave() }
    expect(await regenerateConversationReply(input)).toBe("admitted")
    expect(calls.slice(-2)).toEqual(["submit-current-model-original-parts", "refresh"])
  })
  test("the existing higher Session owner survives its timeline cleanup but expires on real Session navigation", async () => {
    let key = "server-a/session-a"
    let timelineCleanups = 0
    const page = createRoot(stop => {
      const owner = createSessionOwnership(() => key).capture()
      const timeline = createRoot(dispose => { onCleanup(() => timelineCleanups++); return dispose })
      return { stop, owner, timeline }
    })
    try {
      const { input } = setup()
      input.current = () => page.owner.current()
      input.refresh = async () => page.timeline()
      expect(await regenerateConversationReply(input)).toBe("admitted")
      expect(timelineCleanups).toBe(1)
      expect(page.owner.current()).toBe(true)
      key = "server-b/session-b"
      expect(page.owner.current()).toBe(false)
      key = "server-a/session-a"
      expect(page.owner.current()).toBe(false)
    } finally { page.stop() }
    expect(page.owner.current()).toBe(false)
  })
  test("the acknowledged new Run becoming busy does not suppress its history refresh or turn success into stale", async () => {
    const { input, calls } = setup()
    let idle = true
    expect(await regenerateConversationReply({ ...input, ready: () => idle, submit: async () => { calls.push("submit"); idle = false } })).toBe("admitted")
    expect(calls.slice(-2)).toEqual(["submit", "refresh"])
  })
  test("generated current APIs carry the preview token and explicitly selected replacement model/variant and original MIME", async () => {
    const requests: Request[] = []
    const fetcher = Object.assign(async (value: RequestInfo | URL, init?: RequestInit) => {
      const request = value instanceof Request ? value : new Request(value, init)
      requests.push(request)
      const path = new URL(request.url).pathname
      if (path.endsWith("/rewind/preview")) return Response.json({ data: preview })
      if (path.endsWith("/rewind/apply")) return Response.json({ data: { checkpoint, rewoundMessages: 2, lastSequence: 0, workspaceEffectsUnchanged: true } })
      const body = await request.clone().json()
      return Response.json({ data: { ...body, admittedSeq: 21, timeCreated: 1, delivery: "steer" } })
    }, { preconnect() {} })
    const server = { url: "http://owned-fixture.invalid" }
    const operations = createOperationsApiForServer({ server, fetch: fetcher })
    const api = createApiForServer({ server, fetch: fetcher })
    const user = { id: target.messageID, sessionID: target.sessionID, role: "user", agent: "build", time: { created: 1 }, model: { providerID: "failed-provider", modelID: "failed-model" } } satisfies UserMessage
    const parts = [{ id: "prt_file", sessionID: user.sessionID, messageID: user.id, type: "file", filename: "owned.svg", mime: "image/svg+xml", url: "file:///owned/owned.svg" }, { id: "prt_text", sessionID: user.sessionID, messageID: user.id, type: "text", text: "Original prompt" }] satisfies Part[]
    const prompt = captureReplyPrompt(user, parts, "msg_replacement", { providerID: "selected-provider", modelID: "selected-model", variant: "high" })
    expect(await regenerateConversationReply({ api: operations.sessions, target, current: () => true, confirm: async () => true, refresh: async () => {}, submit: () => api.session.prompt(prompt) })).toBe("admitted")
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([`/api/session/${target.sessionID}/rewind/preview`, `/api/session/${target.sessionID}/rewind/apply`, `/api/session/${target.sessionID}/prompt`])
    expect(await requests[0].clone().json()).toEqual({ messageID: target.messageID, expectedDirectory: target.expectedDirectory })
    expect(await requests[1].clone().json()).toEqual({ messageID: target.messageID, expectedDirectory: target.expectedDirectory, expectedLastSequence: 10, expectedRevision: preview.expectedRevision })
    expect(await requests[2].clone().json()).toMatchObject({ id: "msg_replacement", prompt: { text: "Original prompt", route: { agent: "build", model: { id: "selected-model", providerID: "selected-provider", variant: "high" } }, files: [{ uri: "file:///owned/owned.svg", name: "owned.svg", mime: "image/svg+xml" }] } })
  })
})
