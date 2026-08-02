import type { SessionPermissionMode } from "@/context/permission-mode"

export type NativeExecutionAgent = "build" | "plan"

export function canUnifyAgentAndPermissionMode(options: readonly string[]) {
  return options.length === 2 && options.includes("build") && options.includes("plan")
}

export function agentForPermissionMode(mode: SessionPermissionMode): NativeExecutionAgent {
  return mode === "plan" ? "plan" : "build"
}

export function permissionModeForAgent(
  agent: NativeExecutionAgent,
  current: SessionPermissionMode,
): SessionPermissionMode {
  if (agent === "plan") return "plan"
  return current === "plan" ? "acceptEdits" : current
}
