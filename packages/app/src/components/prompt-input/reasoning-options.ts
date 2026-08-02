import { reasoningLevel } from "@arforge-ai/core/reasoning-profile"

export type ReasoningControlOption = {
  id: string
  level: "default" | "high" | "max"
  label: string
}

export function reasoningControlOptions(variants: readonly string[]): ReasoningControlOption[] {
  const pick = (level: "high" | "max") => variants.find((variant) => reasoningLevel(variant) === level)
  const high = pick("high")
  const max = pick("max")
  return [option("default", "default"), ...(high ? [option(high, "high")] : []), ...(max ? [option(max, "max")] : [])]
}

export function deprecatedReasoningVariant(variant: string | undefined) {
  if (!variant) return false
  return /^(?:none|off|low|medium|med|minimal)$/i.test(variant.trim())
}

function option(id: string, level: ReasoningControlOption["level"]): ReasoningControlOption {
  const name = level === "default" ? "Default" : level === "high" ? "High" : "Max"
  return { id, level, label: name }
}
