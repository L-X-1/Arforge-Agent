import { describe, expect, test } from "bun:test"
import { Prompt, RequestSystem } from "@arforge-ai/schema/prompt"
import { PromptSystem } from "@arforge-ai/core/session/prompt-system"

describe("PromptSystem", () => {
  test("binds request system identity, digest, scope and authority without storing a second prompt", () => {
    const prompt = Prompt.make({
      text: "inspect",
      system: RequestSystem.create("Use the request-specific review policy."),
    })
    const layer = PromptSystem.layer({ messageID: "msg_prompt_system", system: prompt.system })

    expect(layer).toMatchObject({
      layer: "L6",
      name: "requestSystem",
      text: "Use the request-specific review policy.",
      origin: "request",
      contextLayer: "current_request",
      authority: "runtime-input",
      trust: "trusted",
      mandatory: true,
      priority: 100,
      unitID: "request-system:msg_prompt_system",
      instructionAllowed: true,
    })
    expect(layer?.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(PromptSystem.promptDigest(prompt)).toMatch(/^[0-9a-f]{64}$/)
    expect(PromptSystem.layer({ messageID: "msg_without_system", system: undefined })).toBeUndefined()
  })
})
