import { describe, expect, test } from "bun:test"
import { LLM, LLMError, LLMResponse, Message, Probe, ToolChoice, ToolDefinition } from "@arforge-ai/llm"
import * as OpenAICompatible from "@arforge-ai/llm/providers/openai-compatible"
import { Auth, LLMClient, RequestExecutor } from "@arforge-ai/llm/route"
import type { Adapter as ProbeAdapter } from "@arforge-ai/llm/probe"
import type { LLMClientService } from "@arforge-ai/llm/route"
import { Billing } from "@arforge-ai/schema/billing"
import { DateTime, Effect, Layer, Stream } from "effect"
import { ModelProbe } from "../src/model-probe"
import * as RuntimeBilling from "../src/runtime/billing"

const fixedPrompt = Probe.FIXED_PROMPT
const liveEnabled =
  process.env.ARFORGE_RUN_LIVE_PROBE === "true" &&
  Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY")

const model = OpenAICompatible.deepseek
  .configure({ auth: Auth.bearer(Auth.config("ANTHROPIC_API_KEY")) })
  .model("deepseek-v4-flash")

const priceCatalog = Billing.PriceCatalog.make({
  revision: "deepseek-v4-flash-official-2026-04-24",
  currency: "CNY",
  minorUnit: 2,
  unit: "1m-tokens",
  effectiveFrom: DateTime.makeUnsafe("2026-04-24T00:00:00.000Z"),
  source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  rates: {
    cacheReadInput: { amountMinor: 2 },
    unknownInput: { amountMinor: 100 },
    textOutput: { amountMinor: 200 },
  },
})

const tool = ToolDefinition.make({
  name: "arforge_probe_tool",
  description: "Return the probe acknowledgement.",
  inputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
})

const request = (patch: Parameters<typeof LLM.updateRequest>[1] = {}) =>
  LLM.updateRequest(
    LLM.request({
      model,
      prompt: fixedPrompt,
      generation: { maxTokens: 32, temperature: 0 },
    }),
    patch,
  )

const liveLayer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))

describe("DeepSeek capability probe (live)", () => {
  const liveTest = liveEnabled ? test : test.skip

  liveTest("runs only the explicitly authorized fixed-prompt probe", async () => {
    const reservation = Billing.Reservation.make({ id: "deepseek-probe-v1", currency: "CNY", estimatedMinor: 500 })
    let budgetState = RuntimeBilling.openBudget(Billing.Budget.make({ currency: "CNY", limitMinor: 500 }))
    budgetState = RuntimeBilling.reserve(budgetState, reservation)
    let spentMinor = 0
    let stoppedForBudget = false

    const usageCharge = (response: LLMResponse) => {
      const usage = RuntimeBilling.measureUsage({
        providerUsage: response.usage,
        estimator: RuntimeBilling.CharacterEstimator,
        estimateInput: { inputText: fixedPrompt, outputText: response.text },
      })
      return RuntimeBilling.charge(usage, priceCatalog)
    }

    const adapter: ProbeAdapter<LLMClientService> = {
      id: "deepseek-v4-flash/openai-compatible-chat",
      execute: (input) =>
        Effect.gen(function* () {
          if (stoppedForBudget)
            return yield* new Probe.ProbeFailure({
              capability: input.capability,
              code: "quota",
              retryable: false,
            })
          const started = Date.now()
          let response: LLMResponse
          switch (input.capability) {
            case "text-generation":
              response = yield* LLMClient.generate(request())
              break
            case "streaming": {
              const events = yield* LLMClient.stream(request()).pipe(Stream.runCollect)
              response =
                LLMResponse.fromEvents(Array.from(events)) ??
                new LLMResponse({ message: Message.assistant([]), events: [], finishReason: "unknown" })
              break
            }
            case "tool-calling":
              response = yield* LLMClient.generate(request({ tools: [tool], toolChoice: ToolChoice.named(tool.name) }))
              break
            case "structured-output": {
              const object = yield* LLM.generateObject({
                model,
                prompt: fixedPrompt,
                jsonSchema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                  additionalProperties: false,
                },
                generation: { maxTokens: 32, temperature: 0 },
              })
              response = object.response
              break
            }
            default:
              return yield* new Probe.ProbeFailure({
                capability: input.capability,
                code: "adapter",
                retryable: false,
              })
          }
          const charge = usageCharge(response)
          if (charge.unpricedCategories.length > 0) {
            return yield* new Probe.ProbeFailure({
              capability: input.capability,
              code: "invalid-output",
              retryable: false,
            })
          }
          if (spentMinor + charge.amountMinor > 500) {
            stoppedForBudget = true
            return yield* new Probe.ProbeFailure({
              capability: input.capability,
              code: "quota",
              retryable: false,
            })
          }
          spentMinor += charge.amountMinor
          const supported =
            input.capability === "text-generation"
              ? Probe.responseSupports.text(response)
              : input.capability === "streaming"
                ? Probe.responseSupports.streaming(response)
                : input.capability === "tool-calling"
                  ? Probe.responseSupports.toolCalling(response)
                  : response.toolCalls.length > 0
          return new Probe.AdapterResult({
            outcome: supported ? "supported" : "unsupported",
            latencyMs: Math.max(0, Date.now() - started),
          })
        }).pipe(
          Effect.catch((error) =>
            error instanceof LLMError
              ? Effect.fail(Probe.fromLLMError(input.capability, error))
              : Effect.fail(
                  new Probe.ProbeFailure({
                    capability: input.capability,
                    code: "adapter",
                    retryable: false,
                  }),
                ),
          ),
        ),
    }

    const result = await Effect.runPromise(
      ModelProbe.run({
        providerID: "deepseek",
        modelID: "deepseek-v4-flash",
        adapter,
        policy: new ModelProbe.Policy({
          source: "live",
          liveAuthorized: true,
          providerAllowlist: ["deepseek"],
          modelAllowlist: ["deepseek-v4-flash"],
          budgetCurrency: "CNY",
          budgetMinor: 500,
        }),
      }).pipe(Effect.provide(liveLayer)),
    )
    const settlement = RuntimeBilling.settle(budgetState, reservation, spentMinor)

    expect(settlement.overBudget).toBe(false)
    expect(result.report.adapter).toBe("deepseek-v4-flash/openai-compatible-chat")
    expect(result.observations).toHaveLength(4)
    expect(result.observations.every((observation) => observation.source === "live")).toBe(true)
  })
})
