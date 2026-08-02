export type ReasoningLevel = "default" | "high" | "max"

export type ReasoningProfile = {
  readonly level: ReasoningLevel
  readonly mascotForm: 1 | 2 | 3
}

const profiles: Record<ReasoningLevel, ReasoningProfile> = {
  default: { level: "default", mascotForm: 1 },
  high: { level: "high", mascotForm: 2 },
  max: { level: "max", mascotForm: 3 },
}

export function reasoningLevel(variant?: string): ReasoningLevel {
  const value = variant?.trim().toLowerCase()
  if (!value || value === "default" || value === "none" || value === "off") return "default"
  if (/(?:^|[-_.\s])(max|xhigh|ultra)(?:$|[-_.\s])/.test(value) || value === "max") return "max"
  if (/(?:^|[-_.\s])high(?:$|[-_.\s])/.test(value) || value === "high") return "high"
  return "default"
}

export function reasoningProfile(variant?: string): ReasoningProfile {
  return profiles[reasoningLevel(variant)]
}

export function subagentOrchestrationPrompt(input: {
  readonly variant?: string
  readonly background: boolean
  readonly child: boolean
}) {
  if (input.child) {
    return [
      "You are an Arforge subagent working in a child Session controlled by the Main Agent.",
      "The user does not participate in this child conversation.",
      "Work only on the delegated task, report evidence and a concise result to the Main Agent, and do not address the user directly.",
    ].join(" ")
  }

  const profile = reasoningProfile(input.variant)
  if (profile.level === "default") {
    return [
      `Arforge orchestration profile: ${profile.level}.`,
      "Delegate selectively when specialized independent work materially improves correctness; the reasoning mode does not impose a Subagent count quota.",
      "The Main Agent owns the user-facing answer.",
    ].join(" ")
  }

  const posture = profile.level === "max" ? "Aggressively decompose" : "Proactively decompose"
  return [
    `Arforge orchestration profile: ${profile.level}.`,
    `${posture} genuinely independent work with the real task tool whenever useful; scale delegation to the task rather than a fixed Subagent count.`,
    input.background
      ? "Use background tasks for independent work, continue only on non-overlapping work, and integrate returned results before the Main Agent answers."
      : "Issue independent task tool calls together when parallel work is useful, then integrate every returned result before the Main Agent answers.",
    "The Main Agent owns all Subagent conversations and the final user-facing response.",
  ].join(" ")
}
