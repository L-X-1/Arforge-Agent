import { expect, test } from "bun:test"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { durablePromptFromMatureMessage } from "../../src/session/prompt"

test("legacy-compatible prompt freezing keeps unresolved MCP identity and request route", () => {
  const uri = "evidence://shared/manual"
  const message: SessionV1.WithParts = {
    info: {
      id: MessageID.make("msg_resource"),
      sessionID: SessionID.make("ses_resource"),
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: {
        providerID: ProviderV2.ID.make("owned"),
        modelID: ModelV2.ID.make("current"),
        variant: ModelV2.VariantID.make("high"),
      },
      system: "Keep request instruction.",
    },
    parts: ["server-A", "server-B"].map((clientName, index) => ({
      id: PartID.make("prt_resource_" + index),
      sessionID: SessionID.make("ses_resource"),
      messageID: MessageID.make("msg_resource"),
      type: "file",
      url: uri,
      mime: "text/plain",
      filename: "manual",
      source: { type: "resource", clientName, uri, text: { value: "@manual", start: index * 8, end: index * 8 + 7 } },
    })),
  }
  const prompt = durablePromptFromMatureMessage(message)
  expect(prompt.files?.map((file) => file.resource)).toEqual([
    { server: "server-A", uri },
    { server: "server-B", uri },
  ])
  expect(prompt.route?.model).toEqual({
    providerID: ProviderV2.ID.make("owned"),
    id: ModelV2.ID.make("current"),
    variant: ModelV2.VariantID.make("high"),
  })
  expect(prompt.system?.text).toBe("Keep request instruction.")
})

test("already expanded mature directory retains text/UI parts while only its media projection is removed", () => {
  const sessionID = SessionID.make("ses_directory"), messageID = MessageID.make("msg_directory")
  const message: SessionV1.WithParts = {
    info: { id: messageID, sessionID, role: "user", time: { created: 1 }, agent: "build",
      model: { providerID: ProviderV2.ID.make("owned"), modelID: ModelV2.ID.make("current") } },
    parts: [
      { id: PartID.make("prt_listing"), sessionID, messageID, type: "text", synthetic: true, text: "Bounded directory listing: first.txt (1 entry)" },
      { id: PartID.make("prt_dir"), sessionID, messageID, type: "file", url: "file:///owned/folder", mime: "application/x-directory", filename: "folder" },
      { id: PartID.make("prt_image"), sessionID, messageID, type: "file", url: "data:image/png;base64,AAEC", mime: "image/png", filename: "image.png" },
      { id: PartID.make("prt_pdf"), sessionID, messageID, type: "file", url: "data:application/pdf;base64,AAEC", mime: "application/pdf", filename: "document.pdf" },
      { id: PartID.make("prt_mcp_dir"), sessionID, messageID, type: "file", url: "evidence://owned/folder", mime: "application/x-directory", filename: "MCP folder",
        source: { type: "resource", clientName: "owned", uri: "evidence://owned/folder", text: { value: "@folder", start: 0, end: 7 } } },
    ],
  }
  const original = structuredClone(message)
  const prompt = durablePromptFromMatureMessage(message)
  expect(prompt.text).toBe("Bounded directory listing: first.txt (1 entry)")
  expect(prompt.files?.map(file => file.mime)).toEqual(["image/png", "application/pdf", "application/x-directory"])
  expect(prompt.files?.at(-1)?.resource).toEqual({ server: "owned", uri: "evidence://owned/folder" })
  expect(prompt.files?.some(file => file.uri === "file:///owned/folder")).toBe(false)
  expect(message).toEqual(original)
})
