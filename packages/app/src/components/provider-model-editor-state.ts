import type { ModelPreset } from "@arforge-ai/schema/model-preset"
export type ModelDefaultChoice = { type: "untouched" } | { type: "model-default" } | { type: "variant"; id: string }
export function applyModelDefaultChoice(
  model: ModelPreset.ConfigurationInput,
  choice: ModelDefaultChoice,
  variantIDs: readonly string[],
): ModelPreset.ConfigurationInput {
  if (choice.type === "untouched") return model
  if (choice.type === "model-default") return { ...model, defaultVariant: null }
  if (!variantIDs.includes(choice.id)) throw Error("Unsupported variant")
  return { ...model, defaultVariant: choice.id }
}
/** A retained reset callback cannot touch a detached/new provider editor. */
export function createModelEditorReset(owner: () => string, isCurrent: () => boolean, reset: () => void) {
  const initial = owner()
  return () => {
    if (!isCurrent() || owner() !== initial) return false
    reset()
    return true
  }
}
