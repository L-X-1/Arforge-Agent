import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, type Model } from "../src"
import * as AmazonBedrock from "../src/providers/amazon-bedrock"
import * as Anthropic from "../src/providers/anthropic"
import * as Azure from "../src/providers/azure"
import { CloudflareAIGateway, CloudflareWorkersAI } from "../src/providers/cloudflare"
import * as Google from "../src/providers/google"
import * as OpenAI from "../src/providers/openai"
import * as OpenAICompatible from "../src/providers/openai-compatible"
import * as OpenRouter from "../src/providers/openrouter"
import * as XAI from "../src/providers/xai"
import { it } from "./lib/effect"

type OfflineProviderCase = Readonly<{
  readonly name: string
  readonly model: Model
  readonly expectedProvider: string
}>

const openai = OpenAI.configure({ apiKey: "fixture", baseURL: "https://openai.fixture/v1" })
const azure = Azure.configure({ apiKey: "fixture", baseURL: "https://azure.fixture/openai/v1" })
const anthropic = Anthropic.configure({ apiKey: "fixture", baseURL: "https://anthropic.fixture/v1" })
const google = Google.configure({ apiKey: "fixture", baseURL: "https://google.fixture/v1beta" })
const xai = XAI.configure({ apiKey: "fixture", baseURL: "https://xai.fixture/v1" })
const openrouter = OpenRouter.configure({ apiKey: "fixture", baseURL: "https://openrouter.fixture/v1" })
const bedrock = AmazonBedrock.configure({ apiKey: "fixture", baseURL: "https://bedrock.fixture" })
const gateway = CloudflareAIGateway.configure({ baseURL: "https://cloudflare-gateway.fixture/v1", gatewayApiKey: "fixture" })
const workers = CloudflareWorkersAI.configure({ baseURL: "https://cloudflare-workers.fixture/v1", apiKey: "fixture" })

const compatible: ReadonlyArray<OfflineProviderCase> = [
  {
    name: "openai-compatible/baseten",
    model: OpenAICompatible.baseten.configure({ apiKey: "fixture" }).model("baseten-fixture"),
    expectedProvider: "baseten",
  },
  {
    name: "openai-compatible/cerebras",
    model: OpenAICompatible.cerebras.configure({ apiKey: "fixture" }).model("cerebras-fixture"),
    expectedProvider: "cerebras",
  },
  {
    name: "openai-compatible/deepinfra",
    model: OpenAICompatible.deepinfra.configure({ apiKey: "fixture" }).model("deepinfra-fixture"),
    expectedProvider: "deepinfra",
  },
  {
    name: "openai-compatible/deepseek",
    model: OpenAICompatible.deepseek.configure({ apiKey: "fixture" }).model("deepseek-fixture"),
    expectedProvider: "deepseek",
  },
  {
    name: "openai-compatible/fireworks",
    model: OpenAICompatible.fireworks.configure({ apiKey: "fixture" }).model("fireworks-fixture"),
    expectedProvider: "fireworks",
  },
  {
    name: "openai-compatible/groq",
    model: OpenAICompatible.groq.configure({ apiKey: "fixture" }).model("groq-fixture"),
    expectedProvider: "groq",
  },
  {
    name: "openai-compatible/togetherai",
    model: OpenAICompatible.togetherai.configure({ apiKey: "fixture" }).model("togetherai-fixture"),
    expectedProvider: "togetherai",
  },
]

const cases: ReadonlyArray<OfflineProviderCase> = [
  { name: "openai/chat", model: openai.chat("gpt-fixture"), expectedProvider: "openai" },
  { name: "openai/responses", model: openai.responses("gpt-fixture"), expectedProvider: "openai" },
  { name: "openai/responses-websocket", model: openai.responsesWebSocket("gpt-fixture"), expectedProvider: "openai" },
  { name: "anthropic/messages", model: anthropic.model("claude-fixture"), expectedProvider: "anthropic" },
  { name: "google/gemini", model: google.model("gemini-fixture"), expectedProvider: "google" },
  { name: "xai/chat", model: xai.chat("grok-fixture"), expectedProvider: "xai" },
  { name: "xai/responses", model: xai.responses("grok-fixture"), expectedProvider: "xai" },
  { name: "openrouter/chat", model: openrouter.model("openai/fixture"), expectedProvider: "openrouter" },
  { name: "azure/chat", model: azure.chat("gpt-fixture"), expectedProvider: "azure" },
  { name: "azure/responses", model: azure.responses("gpt-fixture"), expectedProvider: "azure" },
  { name: "amazon-bedrock/converse", model: bedrock.model("anthropic.claude-fixture"), expectedProvider: "amazon-bedrock" },
  { name: "cloudflare/ai-gateway", model: gateway.model("workers-ai/fixture"), expectedProvider: "cloudflare-ai-gateway" },
  { name: "cloudflare/workers-ai", model: workers.model("@cf/fixture"), expectedProvider: "cloudflare-workers-ai" },
  ...compatible,
]

describe("offline provider contract", () => {
  it.effect("prepares every enabled provider route without network access", () =>
    Effect.gen(function* () {
      for (const input of cases) {
        const prepared = yield* LLMClient.prepare(
          LLM.request({ model: input.model, system: "fixture system", prompt: "OK", generation: { maxTokens: 4 } }),
        )
        expect(String(prepared.model.provider), input.name).toBe(input.expectedProvider)
        expect(prepared.body, input.name).toBeDefined()
        expect(prepared.body).not.toHaveProperty("apiKey")
      }
      expect(cases).toHaveLength(20)
    }),
  )
})
