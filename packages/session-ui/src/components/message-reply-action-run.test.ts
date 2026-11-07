import { describe, expect, test } from "bun:test"
import { branchMessageReply, captureReplyPrompt, retryMessageReply } from "./message-reply-action-run"
import { createStore } from "solid-js/store"
import type { Part, UserMessage } from "@arforge-ai/sdk/v2/client"

describe("reply retry admission", () => {
  test("opens the acknowledged branch exactly once", async () => {
    const opened: string[] = []
    expect(await branchMessageReply({current: () => true, fork: async () => ({id:"branch1"}), open: (forked) => opened.push(forked.id)})).toBe("opened")
    expect(opened).toEqual(["branch1"])
  })
  test("late fork receipt cannot replace another draft or navigate after a scope change", async () => {
    let current = true
    let opened = false
    expect(await branchMessageReply({current: () => current,
      fork: async () => { current = false; return {id:"branch1"} },
      open: () => { opened = true },
    })).toBe("stale")
    expect(opened).toBe(false)
  })
  test("submits exactly once after confirmed rollback", async () => {
    const calls: string[] = []
    expect(await retryMessageReply({current: () => true,
      revert: async () => { calls.push("revert"); return {state: "completed"} },
      submit: async () => { calls.push("submit") },
    })).toBe("admitted")
    expect(calls).toEqual(["revert", "submit"])
  })
  test("does not submit on approval, paused or unconfirmed status", async () => {
    for (const phase of ["waiting_for_confirmation", "paused", "failed", "cancelled", "executing"]) {
      let submitted = false
      expect(await retryMessageReply({current: () => true,
        revert: async () => ({state: "status", status: {phase}}),
        submit: async () => { submitted = true },
      })).toBe("pending")
      expect(submitted).toBe(false)
    }
  })
  test("does not continue a late rollback in another session or server", async () => {
    let current = true
    let submitted = false
    expect(await retryMessageReply({current: () => current,
      revert: async () => { current = false; return {state: "completed"} },
      submit: async () => { submitted = true },
    })).toBe("stale")
    expect(submitted).toBe(false)
  })
  test("propagates rollback failure without submitting", async () => {
    let submitted = false
    await expect(retryMessageReply({current: () => true,
      revert: async () => { throw new Error("permission denied") },
      submit: async () => { submitted = true },
    })).rejects.toThrow("permission denied")
    expect(submitted).toBe(false)
  })
  test("does not call either handler when its source is already stale", async () => {
    let calls = 0
    expect(await retryMessageReply({current: () => false,
      revert: async () => { calls++; return {state: "completed"} },
      submit: async () => { calls++ },
    })).toBe("stale")
    expect(calls).toBe(0)
  })
  test("reports admission failure without claiming a completed reply", async () => {
    await expect(retryMessageReply({current: () => true,
      revert: async () => ({state: "completed"}),
      submit: async () => { throw new Error("model unavailable") },
    })).rejects.toThrow("model unavailable")
  })
  test("captures reactive original model, system, files and references without injected text", () => {
    const user = { id: "user1", sessionID: "session1", role: "user", time: {created: 1}, agent: "plan",
      model: {providerID: "provider1", modelID: "model1", variant: "high"}, system: "original system" } satisfies UserMessage
    const source = {type: "file", path: "notes.md", text: {value: "@notes.md", start: 0, end: 9}}
    const [state, setState] = createStore({ parts: [
      {type: "text", text: "@notes.md explain"},
      {type: "text", text: "injected", synthetic: true},
      {type: "text", text: "ignored", ignored: true},
      {type: "file", filename: "notes.md", mime: "text/markdown", url: "file:///notes.md", source},
      {type: "file", filename: "image.png", mime: "image/png", url: "data:image/png;base64,AAA"},
      {type: "agent", name: "reviewer", source: {value: "@reviewer", start: 10, end: 19}},
    ] as Part[] })
    const captured = captureReplyPrompt(user, state.parts, "retry1")
    setState("parts", 3, {filename: "changed.md"})
    user.model.modelID = "model2"
    expect(captured.sessionID).toBe("session1")
    expect(captured.text).toBe("@notes.md explain")
    expect(captured.model.modelID).toBe("model1")
    expect(captured.variant).toBe("high")
    expect(captured.agent).toBe("plan")
    expect(captured.system).toBe("original system")
    expect(captured.files[0]).toMatchObject({name: "notes.md", mention: {start:0,end:9,text:"@notes.md"}})
    expect(captured.files[1]?.uri).toBe("data:image/png;base64,AAA")
    expect(captured.agents[0]?.mention?.text).toBe("@reviewer")
    expect(captured.legacyParts).toHaveLength(4)
  })
  test("an explicit current model and variant replace the failed route while retaining original attachments and text", () => {
    const user = { id: "user1", sessionID: "session1", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "failed-provider", modelID: "failed-model", variant: "old" } } satisfies UserMessage
    const model = { providerID: "selected-provider", modelID: "selected-model", variant: "high" }
    const parts = [{ id: "prt_text", sessionID: user.sessionID, messageID: user.id, type: "text", text: "original prompt" }, { id: "prt_file", sessionID: user.sessionID, messageID: user.id, type: "file", filename: "owned.png", mime: "image/png", url: "data:image/png;base64,AAA" }] satisfies Part[]
    const captured = captureReplyPrompt(user, parts, "retry-current", model)
    model.modelID = "later-change"
    expect(captured.model).toEqual({ providerID: "selected-provider", modelID: "selected-model", variant: "high" })
    expect(captured.variant).toBe("high")
    expect(captured.text).toBe("original prompt")
    expect(captured.legacyParts).toEqual([{ type: "text", text: "original prompt" }, { type: "file", filename: "owned.png", mime: "image/png", url: "data:image/png;base64,AAA", source: undefined }])
    expect(captured.files).toMatchObject([{ uri: "data:image/png;base64,AAA", name: "owned.png" }])
    expect(user.model.modelID).toBe("failed-model")
  })
})
