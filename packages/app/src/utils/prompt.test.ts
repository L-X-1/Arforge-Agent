import { describe, expect, test } from "bun:test"
import type { Part } from "@arforge-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("removing mention text does not remove the still-attached MCP source", () => {
    const uri = "evidence://shared/manual"
    for (const text of ["Review revised text", ""]) {
      const restored = extractPromptFromParts([
        { id: "text", sessionID: "session", messageID: "message", type: "text", text },
        {
          id: "resource",
          sessionID: "session",
          messageID: "message",
          type: "file",
          filename: "manual",
          mime: "text/plain",
          url: uri,
          source: { type: "resource", clientName: "server-B", uri, text: { value: "@manual", start: 0, end: 7 } },
        },
      ])
      expect(restored.map((part) => ("content" in part ? part.content : "")).join("")).toBe(text)
      expect(restored.find((part) => part.type === "file")).toMatchObject({
        type: "file",
        content: "",
        start: 0,
        end: 0,
        mime: "text/plain",
        url: uri,
        source: { type: "resource", clientName: "server-B", uri, text: { value: "", start: 0, end: 0 } },
      })
    }
  })

  test("restores unmentioned MCP attachments without adding text or mention spans", () => {
    const uri = "evidence://shared/manual"
    const files = ["server-A", "server-B"].map((clientName, index) => ({
      id: `resource_${index}`,
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "file" as const,
      mime: "text/plain",
      filename: "manual",
      url: uri,
      source: {
        type: "resource" as const,
        clientName,
        uri,
        text: { value: "", start: 0, end: 0 },
      },
    }))
    const attachments = files.map((file) => ({
      type: "file" as const,
      path: uri,
      content: "",
      start: 0,
      end: 0,
      mime: file.mime,
      filename: file.filename,
      url: uri,
      source: file.source,
      selection: undefined,
    }))
    expect(
      extractPromptFromParts([
        { id: "text", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Review these" },
        ...files,
      ]),
    ).toEqual([...attachments, { type: "text" as const, content: "Review these", start: 0, end: 12 }])
    expect(extractPromptFromParts(files)).toEqual(attachments)
  })

  test("restores resource server identity and MIME into an editable history draft", () => {
    const uri = "evidence://shared/manual"
    const source = {
      type: "resource" as const,
      clientName: "server-B",
      uri,
      text: { value: "@manual", start: 0, end: 7 },
    }
    const result = extractPromptFromParts([
      { id: "text", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "@manual" },
      {
        id: "resource",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "file",
        mime: "text/plain",
        filename: "manual",
        url: uri,
        source,
      },
    ])
    expect(result).toEqual([
      {
        type: "file",
        path: uri,
        content: "@manual",
        start: 0,
        end: 7,
        mime: "text/plain",
        filename: "manual",
        url: uri,
        source,
        selection: undefined,
      },
    ])
  })

  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })
})
