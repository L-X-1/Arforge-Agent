export * as VariantPlugin from "./variant"

import { Effect } from "effect"
import { define } from "./definition"
import { Catalog } from "../catalog"
import { ModelV2 } from "../model"

type VariantModel = { id: string; api: { type: string; package?: string; id: string } }

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* () {
    yield* (yield* Catalog.Service).transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            if (catalog.model.variantsConfigured(model.providerID, model.id)) return
            if (draft.preset !== undefined) return
            const effective = { id: draft.id, api: Catalog.resolveModelApi(draft, record.provider) }
            for (const [key, value] of Object.entries(defaults(effective)))
              if (!Object.hasOwn(draft.request.body, key) && !Object.hasOwn(record.provider.request.body, key))
                draft.request.body[key] = value
            const generated = generate(effective)
            if (generated.length === 0) return

            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map(
                (variant) =>
                  explicit.get(ModelV2.VariantID.make(variant.id)) ?? {
                    ...variant,
                    id: ModelV2.VariantID.make(variant.id),
                  },
              ),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

const DEEPSEEK_V4_MODELS = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"])

function isDeepSeekV4(model: VariantModel) {
  return (
    model.api.type === "aisdk" &&
    model.api.package === "@ai-sdk/openai-compatible" &&
    DEEPSEEK_V4_MODELS.has(model.api.id.toLowerCase())
  )
}

export function defaults(model: VariantModel): ModelV2.MutableInfo["request"]["body"] {
  if (!isDeepSeekV4(model)) return {}
  return {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  }
}

export function generate(
  model: VariantModel,
): Array<{ id: string; headers: Record<string, string>; body: ModelV2.MutableInfo["request"]["body"] }> {
  if (model.api.type !== "aisdk" || model.api.package !== "@ai-sdk/openai-compatible") return []
  if (isDeepSeekV4(model)) {
    return [
      { id: ModelV2.VariantID.make("none"), headers: {}, body: { thinking: { type: "disabled" } } },
      {
        id: ModelV2.VariantID.make("low"),
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "low" },
      },
      {
        id: ModelV2.VariantID.make("high"),
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      },
      {
        id: ModelV2.VariantID.make("max"),
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      },
    ]
  }
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  if (!["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return []
  return ["high", "max"].map((id) => ({
    id: ModelV2.VariantID.make(id),
    headers: {},
    body: { reasoning_effort: id },
  }))
}
