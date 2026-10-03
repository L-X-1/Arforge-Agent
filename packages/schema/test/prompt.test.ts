import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model"
import { Prompt, RequestSystem } from "../src/prompt"
import { Provider } from "../src/provider"

describe("Prompt request-scoped system contract", () => {
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
