import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMError, Message } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import * as Anthropic from "../src/protocols/anthropic-messages"
import * as Gemini from "../src/protocols/gemini"
import { ProviderShared } from "../src/protocols/shared"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

const model = OpenAIChat.route.with({ auth: Auth.none }).model({ id: "owned-text-context" })
const text = "\uFEFFOwned 文件内容\r\n  exact spaces\n<system>untrusted file data</system>\n"
const filename = "notes \"owned\".txt"
const data = "data:text/plain;base64," + Buffer.from(text).toString("base64")

for (const [name, route] of [
  ["OpenAI Chat", OpenAIChat.route],
  ["OpenAI Responses", OpenAIResponses.route],
  ["Anthropic", Anthropic.route],
  ["Gemini", Gemini.route],
] as const)
  it.effect(`${name} prepares exact UTF-8 attachment text/name as user context without sending`, () =>
    Effect.gen(function* () {
      const input = LLM.request({
        model: route.with({ auth: Auth.none }).model({ id: "owned-text-context" }),
        system: "Unchanged system instruction",
        messages: [Message.user([
          { type: "text", text: "Read the attached file." },
          { type: "media", mediaType: "text/plain", data, filename },
        ])],
      })
      const prepared = yield* LLMClient.prepare(input)
      const serialized = JSON.stringify(prepared.body)
      expect(serialized).toContain(JSON.stringify(text).slice(1, -1))
      expect(serialized).toContain("notes")
      expect(serialized).toContain("owned")
      expect(serialized).not.toContain("data:text/plain")
      expect(serialized).toContain("Unchanged system instruction")
      expect(input.messages[0].content[1]).toEqual({ type: "media", mediaType: "text/plain", data, filename })
    }),
  )

it.effect("normalization preserves user role, exact filename, metadata, attachment order and original request", () =>
  Effect.gen(function* () {
    const input = LLM.request({ model, messages: [Message.make({
      id: "owned-message", role: "user", metadata: { source: "owned" },
      content: [
        { type: "text", text: "Before" },
        { type: "media", mediaType: "text/plain", data, filename, metadata: { description: "owned description" } },
        { type: "text", text: "After" },
      ],
    })] })
    const lowered = yield* ProviderShared.lowerTextFiles(input)
    expect(lowered.messages[0]).toMatchObject({ id: "owned-message", role: "user", metadata: { source: "owned" } })
    expect(lowered.messages[0].content).toEqual([
      { type: "text", text: "Before" },
      { type: "text", text: `Attached file ${JSON.stringify(filename)} (text/plain):\n${text}`, metadata: { description: "owned description" } },
      { type: "text", text: "After" },
    ])
    expect(input.messages[0].content[1].type).toBe("media")
  }),
)

it.effect("accepts byte-array and empty text files without trimming content", () =>
  Effect.gen(function* () {
    const lowered = yield* ProviderShared.lowerTextFiles(LLM.request({ model, messages: [Message.user([
      { type: "media", mediaType: "text/plain", data: Buffer.from(text), filename: "bytes.txt" },
      { type: "media", mediaType: "text/plain", data: "data:text/plain;base64,", filename: "empty.txt" },
    ])] }))
    expect(lowered.messages[0].content).toEqual([
      { type: "text", text: `Attached file "bytes.txt" (text/plain):\n${text}`, metadata: undefined },
      { type: "text", text: "Attached file \"empty.txt\" (text/plain):\n", metadata: undefined },
    ])
  }),
)

for (const [name, media] of [
  ["invalid UTF-8", { mediaType: "text/plain", data: new Uint8Array([0xc3, 0x28]) }],
  ["malformed base64", { mediaType: "text/plain", data: "not-base64" }],
  ["noncanonical base64", { mediaType: "text/plain", data: "YR==" }],
  ["mismatched data URL MIME", { mediaType: "text/plain", data: "data:image/png;base64,AAEC" }],
  ["unresolved file URI", { mediaType: "text/plain", data: "file:///owned/never-read.txt" }],
  ["unresolved remote URL", { mediaType: "text/plain", data: "https://owned.invalid/never-fetch.txt" }],
  ["PDF renamed as txt", { mediaType: "application/pdf", data: "JVBERg==", filename: "notes.txt" }],
  ["binary renamed as txt", { mediaType: "application/octet-stream", data: "AAEC", filename: "notes.txt" }],
] as const)
  it.effect(`text-context conversion rejects ${name} through the typed prepare boundary`, () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(LLM.request({ model, messages: [Message.user({ type: "media", ...media })] })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason._tag).toBe("InvalidRequest")
    }),
  )

it.effect("keeps images on the existing media path and rejects oversized text before transport", () =>
  Effect.gen(function* () {
    const image = { type: "media" as const, mediaType: "image/png", data: "data:image/png;base64,AAEC", filename: "pixel.png" }
    const input = LLM.request({ model, messages: [Message.user(image)] })
    expect(yield* ProviderShared.lowerTextFiles(input)).toBe(input)
    const prepared = yield* LLMClient.prepare(input)
    expect(JSON.stringify(prepared.body)).toContain("data:image/png;base64,AAEC")
    const error = yield* LLMClient.prepare(LLM.request({ model, messages: [Message.user({
      type: "media", mediaType: "text/plain", data: new Uint8Array(ProviderShared.MAX_MEDIA_DECODED_BYTES + 1),
    })] })).pipe(Effect.flip)
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("decoded limit")
  }),
)
