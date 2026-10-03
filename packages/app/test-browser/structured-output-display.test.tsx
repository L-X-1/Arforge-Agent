import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@arforge-ai/client/promise"
import { marked } from "marked"
import { normalizeSessionMessages } from "@/utils/session-message"

describe("structured output display", () => {
  test("projects a structured-only completion into a visible JSON code block", async () => {
    const source = [
      { id: "msg_user", type: "user", text: "return JSON", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        structured: { answer: 42, status: "ok" },
        time: { created: 2, completed: 3 },
      },
    ] as unknown as SessionMessageInfo[]
    const part = normalizeSessionMessages("ses_1", source)
      .parts.get("msg_assistant")
      ?.find((item) => item.type === "text")
    if (!part || part.type !== "text") throw new Error("Structured completion was not projected as text")

    const host = document.createElement("div")
    host.innerHTML = await marked.parse(part.text)

    const code = host.querySelector("pre code")
    if (!code) throw new Error("Structured output did not become visible")
    expect(code.classList.contains("language-json")).toBe(true)
    expect(code.textContent).toContain('"answer": 42')
    expect(code.textContent).toContain('"status": "ok"')
  })
})
