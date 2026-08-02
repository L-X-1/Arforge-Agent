export type SessionPermissionMode = "plan" | "acceptEdits" | "fullAccess"

export type SessionPermissionRule = {
  readonly permission: string
  readonly pattern: string
  readonly action: "allow" | "ask" | "deny"
}

const safeReadActions = ["read", "glob", "grep", "list", "lsp", "webfetch", "websearch", "skill", "question"] as const

export function sessionPermissionRules(mode: SessionPermissionMode): SessionPermissionRule[] {
  if (mode === "fullAccess") {
    return [{ permission: "*", pattern: "*", action: "allow" }]
  }

  const base: SessionPermissionRule[] = [
    { permission: "*", pattern: "*", action: "ask" },
    ...safeReadActions.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
  ]

  if (mode === "acceptEdits") {
    return [...base, { permission: "edit", pattern: "*", action: "allow" }]
  }

  return [
    ...base,
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
  ]
}

export function permissionModeAutoRespond(mode: SessionPermissionMode, permission: string) {
  if (mode === "fullAccess") return true
  return mode === "acceptEdits" && permission === "edit"
}

export function permissionModeFromRules(
  rules: ReadonlyArray<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }> | undefined,
): SessionPermissionMode | undefined {
  if (!rules?.length) return
  const wildcard = rules.findLast((rule) => rule.permission === "*" && rule.pattern === "*")
  if (wildcard?.action === "allow") return "fullAccess"
  if (wildcard?.action !== "ask") return

  const action = (permission: string) =>
    rules.findLast((rule) => rule.permission === permission && rule.pattern === "*")?.action
  if (action("edit") === "allow") return "acceptEdits"
  if (action("edit") === "deny" && action("bash") === "deny" && action("task") === "deny") return "plan"
}
