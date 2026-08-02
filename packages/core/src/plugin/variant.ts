export * as VariantPlugin from "./variant"

import type { ModelV2Info } from "@arforge-ai/sdk/v2/types"
import { Effect } from "effect"
import { define } from "./definition"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            Object.assign(draft.request.body, defaults(draft))
            const generated = generate(draft)
            if (generated.length === 0) return

            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

const DEEPSEEK_V4_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"])

function isDeepSeekV4(model: ModelV2Info) {
  return (
    model.api.type === "aisdk" &&
    model.api.package === "@ai-sdk/openai-compatible" &&
    DEEPSEEK_V4_MODELS.has(model.api.id.toLowerCase())
  )
}

export function defaults(model: ModelV2Info): Record<string, unknown> {
  if (!isDeepSeekV4(model)) return {}
  return {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  }
}

export function generate(model: ModelV2Info): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk" || model.api.package !== "@ai-sdk/openai-compatible") return []
  if (isDeepSeekV4(model)) {
    return [
      { id: "none", headers: {}, body: { thinking: { type: "disabled" } } },
      {
        id: "high",
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      },
      {
        id: "max",
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      },
    ]
  }
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id,
    headers: {},
    body: { reasoning_effort: id },
  }))
}
