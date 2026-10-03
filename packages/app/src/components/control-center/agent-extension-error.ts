type PublicErrorShape = {
  kind?: unknown
  message?: unknown
  body?: unknown
  cause?: unknown
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function shape(value: unknown): PublicErrorShape | undefined {
  const parsed = parse(value)
  if (!parsed || typeof parsed !== "object") return
  return parsed as PublicErrorShape
}

export function isRetiredAgentCapabilityError(error: unknown): boolean {
  const current = shape(error instanceof Error ? error.message : error)
  if (!current) return false
  if (current.kind === "agent-capability-retired") return true
  return isRetiredAgentCapabilityError(current.body) || isRetiredAgentCapabilityError(current.cause)
}

export function agentExtensionPublicError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message && !shape(error.message)) return error.message
  if (typeof error === "string" && !shape(error)) return error
  const current = shape(error instanceof Error ? error.message : error)
  if (typeof current?.message === "string" && current.message.trim()) return current.message
  return fallback
}
