import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model"
import { FileAttachment, Prompt, RequestSystem } from "../src/prompt"
import { PromptInput } from "../src/prompt-input"
import { Provider } from "../src/provider"

describe("Prompt request-scoped system contract", () => {
  test("structurally preserves both resource targets while Core owns semantic equality", () => {
    const input = {
      text: "@manual",
      files: [
        { uri: "evidence://displayed/manual", resource: { server: "server-B", uri: "evidence://other/private" } },
      ],
    }
    expect(Schema.decodeUnknownSync(PromptInput.Prompt)(input)).toEqual(input)
  })
  test("resource references survive input, constructors and history-compatible JSON without changing media", () => {
    const uri = "evidence://shared/manual"
    const files = ["server-A", "server-B"].map((server) =>
      FileAttachment.create({ uri, mime: "text/plain", resource: { server, uri } }),
    )
    files.push(FileAttachment.create({ uri: "data:image/png;base64,AAAA", mime: "image/png", name: "image.png" }))
    const prompt = Prompt.make({ text: "review", files, system: RequestSystem.create("Keep this turn instruction.") })
    const encoded = Schema.encodeSync(Prompt)(prompt)
    expect(Schema.decodeUnknownSync(PromptInput.Prompt)(encoded).files).toEqual(files)
    expect(Schema.decodeUnknownSync(Prompt)(JSON.parse(JSON.stringify(encoded))).files).toEqual(files)
    expect(Prompt.fromUserMessage(prompt)).toEqual(prompt)
    expect(encoded.files?.[2]).not.toHaveProperty("resource")
  })
  test("round-trips one explicit request/turn instruction", () => {
    const prompt = Prompt.make({
      text: "inspect the workspace",
      system: RequestSystem.create("Use the request-specific review policy."),
    })
    const encoded = Schema.encodeSync(Prompt)(prompt)

    expect(encoded).toEqual({
      text: "inspect the workspace",
      system: {
        text: "Use the request-specific review policy.",
        source: "request",
        scope: "turn",
      },
    })
    expect(Schema.decodeUnknownSync(Prompt)(encoded)).toEqual(prompt)
    expect(Prompt.fromUserMessage(prompt)).toEqual(prompt)
  })

  test("rejects an ambiguous bare system string", () => {
    expect(() => Schema.decodeUnknownSync(Prompt)({ text: "inspect", system: "ambiguous" })).toThrow()
  })

  test("round-trips scheduled task identity without executable payloads", () => {
    const prompt = Prompt.make({
      text: "inspect and summarize",
      scheduledTasks: [
        {
          id: "prt_scheduled_review",
          prompt: "inspect the workspace",
          description: "Workspace review",
          agent: "reviewer",
          model: { id: Model.ID.make("model-review"), providerID: Provider.ID.make("provider-review") },
          command: "review",
        },
      ],
    })
    const encoded = Schema.encodeSync(Prompt)(prompt)

    expect(encoded).toEqual({
      text: "inspect and summarize",
      scheduledTasks: [
        {
          id: "prt_scheduled_review",
          prompt: "inspect the workspace",
          description: "Workspace review",
          agent: "reviewer",
          model: { id: "model-review", providerID: "provider-review" },
          command: "review",
        },
      ],
    })
    expect(Schema.decodeUnknownSync(Prompt)(encoded)).toEqual(prompt)
    expect(Prompt.fromUserMessage(prompt)).toEqual(prompt)
    expect(JSON.stringify(encoded)).not.toContain("execute")
  })
})
