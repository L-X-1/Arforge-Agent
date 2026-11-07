type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

type VariantInput = {
  variants: string[]
  selected: string | null | undefined
  configured: string | undefined
}

/** Restore an unselected preset when editing its existing queued model. */
export function queuedVariantRestore(input: {
  queued: AgentModel & { variant?: string }
  current: AgentModel | undefined
  currentVariant: string | undefined
  supported: readonly string[]
  explicit: boolean
}): { status: "unchanged" } | { status: "restore" | "retain"; variant: string } {
  if (
    !input.queued.variant ||
    input.current?.providerID !== input.queued.providerID ||
    input.current.modelID !== input.queued.modelID ||
    input.currentVariant !== undefined ||
    input.explicit
  )
    return { status: "unchanged" }
  if (!input.supported.includes(input.queued.variant)) return { status: "retain", variant: input.queued.variant }
  return { status: "restore", variant: input.queued.variant }
}

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  if (!(input.agent.variant in input.model.variants)) return undefined
  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (input.selected === null) return undefined
  if (input.selected && input.variants.includes(input.selected)) return input.selected
  if (input.configured && input.variants.includes(input.configured)) return input.configured
  return undefined
}

export function cycleModelVariant(input: VariantInput) {
  if (input.variants.length === 0) return undefined
  if (input.selected === null) return input.variants[0]
  if (input.selected && input.variants.includes(input.selected)) {
    const index = input.variants.indexOf(input.selected)
    if (index === input.variants.length - 1) return undefined
    return input.variants[index + 1]
  }
  if (input.configured && input.variants.includes(input.configured)) {
    const index = input.variants.indexOf(input.configured)
    if (index === input.variants.length - 1) return input.variants[0]
    return input.variants[index + 1]
  }
  return input.variants[0]
}
