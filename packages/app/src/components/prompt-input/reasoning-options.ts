import { chooserVariantGroups } from "../dialog-select-model-presentation"
import { chooserVariantLabel } from "../dialog-select-model-copy"

export type ReasoningControlOption = {
  id: string
  value: string | undefined
  label: string
}

export function reasoningControlKey(value: string | undefined) {
  return value === undefined ? "reset" : JSON.stringify(["variant", value])
}

export function reasoningControlOptions(
  variants: readonly string[],
  metadata?: Record<string, unknown>,
  locale = "en",
): ReasoningControlOption[] {
  const groups = chooserVariantGroups(variants, metadata)
  return [groups.reset, ...groups.reasoning, ...groups.other].map((item) => ({
    id: item.key,
    value: item.value,
    label: chooserVariantLabel(
      item.value,
      locale,
      groups.reasoning.some((entry) => entry.key === item.key),
      item.value === undefined ? undefined : metadata?.[item.value],
    ),
  }))
}

export function deprecatedReasoningVariant(variant: string | undefined, supported: readonly string[] = []) {
  if (!variant) return false
  return !supported.includes(variant) && /^(?:none|off|low|medium|med|minimal)$/i.test(variant.trim())
}
