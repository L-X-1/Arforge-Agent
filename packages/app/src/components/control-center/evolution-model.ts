export type EvolutionStatus = "proposed" | "evaluated" | "approved" | "rejected" | "canary" | "promoted" | "rolled_back"

export type EvolutionAction = "evaluate" | "approve" | "reject" | "startCanary" | "promote" | "rollback"

export function evolutionActions(
  status: EvolutionStatus,
  gatePassed: boolean,
  canaryGatePassed: boolean,
): readonly EvolutionAction[] {
  if (status === "proposed") return ["evaluate", "reject"] as const
  if (status === "evaluated")
    return gatePassed ? (["evaluate", "approve", "reject"] as const) : (["evaluate", "reject"] as const)
  if (status === "approved") return ["reject", "startCanary"] as const
  if (status === "canary") return canaryGatePassed ? (["promote", "rollback"] as const) : (["rollback"] as const)
  if (status === "promoted") return ["rollback"] as const
  return [] as const
}

export const evolutionActionRequiresReason = (action: EvolutionAction) => action !== "evaluate"

export function evolutionEvidenceRefs(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

const uiFallbackError = "Web UI unavailable: build the embedded UI or configure ARFORGE_UI_UPSTREAM_URL."

export function readableEvolutionError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error)
  if (!message) return "Unknown error"
  try {
    const decoded = JSON.parse(message) as unknown
    if (decoded && typeof decoded === "object" && "error" in decoded && typeof decoded.error === "string") {
      return decoded.error
    }
  } catch {
    // The transport may already provide a human-readable message.
  }
  return message
}

export function evolutionRefreshError(errors: readonly unknown[], unavailableMessage: string): string {
  const messages = errors
    .map(readableEvolutionError)
    .map((message) => (message.includes(uiFallbackError) ? unavailableMessage : message))
  return [...new Set(messages)].join("\n")
}
