/** Browsing is presentation state; connection IDs and committed model identity stay authoritative. */
export function chooserProvider(
  providers: readonly { id: string }[],
  preferred: string | undefined,
  committed: string | undefined,
) {
  return [preferred, committed, providers[0]?.id].find(
    (id) => id !== undefined && providers.some((item) => item.id === id),
  )
}

export function chooserCapabilityBadges(model: {
  capabilities?: { reasoning?: boolean; input?: Partial<Record<"image" | "audio" | "video" | "pdf", boolean>> }
  modalities?: { input?: readonly string[] }
  reasoning?: boolean
}) {
  const input = model.capabilities?.input
  const supported = (kind: "image" | "audio" | "video" | "pdf") =>
    input ? input[kind] === true : model.modalities?.input?.includes(kind) === true
  return [
    ...(supported("image") ? ["vision" as const] : []),
    ...(supported("audio") ? ["audio" as const] : []),
    ...(supported("video") ? ["video" as const] : []),
    ...(supported("pdf") ? ["pdf" as const] : []),
    ...((model.capabilities ? model.capabilities.reasoning : model.reasoning) === true ? ["reasoning" as const] : []),
  ]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reasoningRequest(value: unknown, matches: (value: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (!record(value) || depth > 3) return false
  if (matches(value)) return true
  for (const key of ["body", "settings", "request", "providerOptions"]) {
    const nested = value[key]
    if (reasoningRequest(nested, matches, depth + 1)) return true
    if (
      key === "providerOptions" &&
      record(nested) &&
      Object.values(nested).some((item) => reasoningRequest(item, matches, depth + 1))
    )
      return true
  }
  return false
}

/** Generic Provider.Request presets are not necessarily reasoning presets. Never inspect headers. */
export function chooserReasoningVariant(value: unknown): boolean {
  return reasoningRequest(
    value,
    (body) =>
      typeof body.reasoningEffort === "string" ||
      typeof body.reasoning_effort === "string" ||
      typeof body.enable_thinking === "boolean" ||
      (record(body.output_config) && typeof body.output_config.effort === "string") ||
      (record(body.reasoning) &&
        (typeof body.reasoning.effort === "string" || typeof body.reasoning.enabled === "boolean")) ||
      (record(body.thinking) &&
        (typeof body.thinking.type === "string" || typeof body.thinking.budget_tokens === "number")) ||
      (record(body.thinkingConfig) &&
        (typeof body.thinkingConfig.thinkingBudget === "number" ||
          typeof body.thinkingConfig.thinkingLevel === "string")),
  )
}

export function chooserReasoningOff(value: unknown): boolean {
  const off = (effort: unknown) => effort === "none" || effort === "off"
  return reasoningRequest(
    value,
    (body) =>
      off(body.reasoningEffort) ||
      off(body.reasoning_effort) ||
      body.enable_thinking === false ||
      (record(body.reasoning) && (body.reasoning.enabled === false || off(body.reasoning.effort))) ||
      (record(body.thinking) && body.thinking.type === "disabled") ||
      (record(body.thinkingConfig) && body.thinkingConfig.thinkingBudget === 0),
  )
}

export type ChooserVariant = { key: string; value: string | undefined; label: string }

export function chooserVariantGroups(supported: readonly string[], metadata: Record<string, unknown> | undefined) {
  const variants = [...new Set(supported)].map((value) => ({
    key: JSON.stringify(["variant", value]),
    value,
    label: value,
  }))
  return {
    reset: { key: "reset", value: undefined, label: "default" } satisfies ChooserVariant,
    reasoning: variants.filter((item) => chooserReasoningVariant(metadata?.[item.value])),
    other: variants.filter((item) => !chooserReasoningVariant(metadata?.[item.value])),
  }
}

/** Order only comparable, explicit request strengths; wire names do not prove a tier. */
export function chooserStrengthOptions(
  groups: ReturnType<typeof chooserVariantGroups>,
  metadata: Record<string, unknown> | undefined,
) {
  const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"]
  const ranked = groups.reasoning.map((option) => {
    const request = option.value === undefined ? undefined : metadata?.[option.value]
    // Named modes stay separate from a session reset and from the ranked tiers.
    if (option.value === "default" || option.value === "auto" || option.value === "automatic") return { option }
    if (chooserReasoningOff(request)) return { option, off: true }
    let rank: { kind: "effort" | "budget"; value: number } | undefined
    reasoningRequest(request, (body) => {
      const effort =
        body.reasoningEffort ??
        body.reasoning_effort ??
        (record(body.reasoning) ? body.reasoning.effort : undefined) ??
        (record(body.output_config) ? body.output_config.effort : undefined) ??
        (record(body.thinkingConfig) ? body.thinkingConfig.thinkingLevel : undefined)
      if (typeof effort === "string" && efforts.includes(effort.toLowerCase())) {
        rank = { kind: "effort", value: efforts.indexOf(effort.toLowerCase()) }
        return true
      }
      const budget =
        (record(body.thinking) ? body.thinking.budget_tokens : undefined) ??
        (record(body.thinkingConfig) ? body.thinkingConfig.thinkingBudget : undefined)
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
        rank = { kind: "budget", value: budget }
        return true
      }
      return false
    })
    return { option, rank }
  })
  const kinds = new Set(ranked.flatMap((item) => (item.rank ? [item.rank.kind] : [])))
  // Effort labels and token budgets cannot be compared on the same numeric scale.
  const ordered =
    kinds.size === 1
      ? ranked
          .filter((item) => item.rank)
          .sort((a, b) => a.rank!.value - b.rank!.value)
      : []
  const disabled = ranked.filter((item) => item.off)
  // Off can anchor the scale only when its recipe is unique and strengths differ.
  const off =
    disabled.length === 1 && new Set(ordered.map((item) => item.rank!.value)).size >= 2
      ? disabled[0].option
      : undefined
  const levels = [...(off ? [off] : []), ...ordered.map((item) => item.option)]
  return {
    off,
    levels,
    modes: [groups.reset, ...groups.reasoning.filter((option) => !levels.includes(option))],
  }
}

/** Native radio-style movement maps only to actual discrete options. */
export function chooserStep(key: string, index: number, length: number) {
  if (length <= 0) return undefined
  if (key === "Home") return 0
  if (key === "End") return length - 1
  if (key === "ArrowRight" || key === "ArrowDown") return (Math.max(index, 0) + 1) % length
  if (key === "ArrowLeft" || key === "ArrowUp") return (Math.max(index, 0) - 1 + length) % length
  return undefined
}

/** A native range index is an option position, never a model strength parameter. */
export function chooserRangeIndex(value: number, length: number) {
  return Number.isInteger(value) && value >= 0 && value < length ? value : undefined
}

export async function commitChooserVariant(input: {
  value: string | undefined
  supported: () => readonly string[]
  current: () => boolean
  write: (value: string | undefined) => void | Promise<void>
}) {
  if (!input.current()) return "stale" as const
  if (input.value !== undefined && !input.supported().includes(input.value)) return "unsupported" as const
  await input.write(input.value)
  return input.current() ? ("acknowledged" as const) : ("stale" as const)
}
