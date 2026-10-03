import { describe, expect, test } from "bun:test"
import { LLM, LLMEvent, LLMResponse, Probe } from "@arforge-ai/llm"
import * as OpenAICompatible from "@arforge-ai/llm/providers/openai-compatible"
import { Auth, LLMClient, RequestExecutor } from "@arforge-ai/llm/route"
import { Billing } from "@arforge-ai/schema/billing"
import { DateTime, Effect, Layer, Stream } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as RuntimeBilling from "../src/runtime/billing"

const liveEnabled =
  process.env.ARFORGE_RUN_LIVE_PROBE === "true" &&
  Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY")

const providerID = "deepseek"
const modelID = "deepseek-v4-flash"
const fixedPrompt = Probe.FIXED_PROMPT
const maxNetworkRequests = 3
const budgetLimitMinor = 500

const model = OpenAICompatible.deepseek
  .configure({ auth: Auth.bearer(Auth.config("ANTHROPIC_API_KEY")) })
  .model(modelID)

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

const request = () =>
  LLM.request({
    model,
    prompt: fixedPrompt,
    generation: { maxTokens: 8, temperature: 0 },
  })

const liveLayer = LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))
const root = resolve(import.meta.dir, "../../..")
const auditPath = join(root, "artifacts", "phase-3-12-deepseek-live-fault-recovery-20260812.json")

type StageAudit = {
  readonly stage: "baseline" | "controlled-stream-abort" | "recovery"
  readonly outcome: "supported" | "fault" | "recovered"
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly chargeMinor: number
  readonly terminalObserved?: boolean
  readonly eventsObserved?: number
}

const usageFor = (response: LLMResponse) =>
  RuntimeBilling.measureUsage({
    providerUsage: response.usage,
    estimator: RuntimeBilling.CharacterEstimator,
    estimateInput: { inputText: fixedPrompt, outputText: response.text },
  })

const stageFromResponse = (
  stage: "baseline" | "recovery",
  outcome: "supported" | "recovered",
  response: LLMResponse,
  chargeMinor: number,
): StageAudit => ({
  stage,
  outcome,
  inputTokens: response.usage?.inputTokens,
  outputTokens: response.usage?.outputTokens,
  totalTokens: response.usage?.totalTokens,
  chargeMinor,
  terminalObserved: response.finishReason !== undefined,
})

describe("DeepSeek live fault/recovery probe", () => {
  const liveTest = liveEnabled ? test : test.skip

  liveTest("keeps a three-request live budget while recovering a controlled stream abort", async () => {
    let networkRequests = 0
    let budgetState = RuntimeBilling.openBudget(Billing.Budget.make({ currency: "CNY", limitMinor: budgetLimitMinor }))
    const stages: StageAudit[] = []

    const callBudget = (reservationID: string) => {
      if (networkRequests >= maxNetworkRequests) throw new Error("live request limit reached before provider call")
      const estimatedUsage = RuntimeBilling.estimateCallUsage({
        inputText: fixedPrompt,
        outputTokens: 8,
      })
      const estimatedCharge = RuntimeBilling.charge(estimatedUsage, priceCatalog)
      const reservation = Billing.Reservation.make({
        id: reservationID,
        currency: "CNY",
        estimatedMinor: estimatedCharge.amountMinor,
      })
      budgetState = RuntimeBilling.reserve(budgetState, reservation)
      networkRequests += 1
      return { estimatedUsage, reservation }
    }

    const runGenerate = async (reservationID: string) => {
      const prepared = callBudget(reservationID)
      const response = await Effect.runPromise(LLMClient.generate(request()).pipe(Effect.provide(liveLayer)))
      const usage = usageFor(response)
      const settlement = RuntimeBilling.settle(budgetState, prepared.reservation, RuntimeBilling.charge(usage, priceCatalog).amountMinor)
      budgetState = settlement.state
      return { response, chargeMinor: settlement.actualMinor }
    }

    const baseline = await runGenerate("deepseek-live-baseline")
    stages.push(stageFromResponse("baseline", "supported", baseline.response, baseline.chargeMinor))

    const interrupted = callBudget("deepseek-live-controlled-abort")
    const partialEvents = await Effect.runPromise(
      LLMClient.stream(request()).pipe(Stream.take(1), Stream.runCollect, Effect.provide(liveLayer)),
    )
    const terminalObserved = Array.from(partialEvents).some(LLMEvent.is.finish)
    if (partialEvents.length !== 1 || terminalObserved)
      throw new Error("controlled stream abort did not stop before a terminal provider event")
    const interruptedSettlement = RuntimeBilling.settle(
      budgetState,
      interrupted.reservation,
      RuntimeBilling.charge(interrupted.estimatedUsage, priceCatalog).amountMinor,
    )
    budgetState = interruptedSettlement.state
    stages.push({
      stage: "controlled-stream-abort",
      outcome: "fault",
      chargeMinor: interruptedSettlement.actualMinor,
      terminalObserved,
      eventsObserved: partialEvents.length,
    })

    const recovery = await runGenerate("deepseek-live-recovery")
    stages.push(stageFromResponse("recovery", "recovered", recovery.response, recovery.chargeMinor))

    const audit = {
      schemaVersion: 1,
      provider: providerID,
      model: modelID,
      source: "live",
      promptPolicy: "fixed-probe-only",
      contentPersisted: false,
      secretsPersisted: false,
      maxNetworkRequests,
      networkRequests,
      budget: {
        currency: "CNY",
        limitMinor: budgetLimitMinor,
        settledMinor: budgetState.settledMinor,
        overBudget: budgetState.settledMinor > budgetLimitMinor,
      },
      stages,
    }
    await mkdir(join(root, "artifacts"), { recursive: true })
    await writeFile(auditPath, JSON.stringify(audit, null, 2))

    expect(networkRequests).toBe(3)
    expect(budgetState.settledMinor).toBeLessThanOrEqual(budgetLimitMinor)
    expect(stages.map((stage) => stage.outcome)).toEqual(["supported", "fault", "recovered"])
    expect(stages.every((stage) => stage.chargeMinor >= 0)).toBe(true)
  })
})
