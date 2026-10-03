import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@arforge-ai/sdk/v2"
import { delegatedTaskDetails, requiresHumanConfirmation } from "./session-permission-dock"

describe("SessionPermissionDock request details", () => {
  test("recognizes the backend-owned fresh-confirmation bit rather than inferring it from command text", () => {
    const request = {
      id: "per_trusted",
      sessionID: "ses_test",
      permission: "shell",
      patterns: ["node -e 'process.exit(0)'"],
      metadata: { scope: "opaque-user-shell", cwd: "C:/project", shell: "powershell" },
      always: ["*"],
      requiresHumanConfirmation: true,
    } as PermissionRequest & { requiresHumanConfirmation: boolean }

    expect(requiresHumanConfirmation(request)).toBe(true)
    const untrusted = { ...request, requiresHumanConfirmation: false } as typeof request
    expect(requiresHumanConfirmation(untrusted)).toBe(false)
  })

  test("parses bounded delegated task capabilities for progressive disclosure", () => {
    const request = {
      id: "per_task",
      sessionID: "ses_test",
      permission: "task",
      patterns: ["general"],
      metadata: {
        capability_mode: "explicit",
        capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
        budget_mode: "durable",
        budget: { maxAttempts: 2, maxDurationMs: 900_000, maxCostMicros: 1_000_000, maxTokens: 250_000 },
      },
      always: ["*"],
    } as PermissionRequest

    expect(delegatedTaskDetails(request)).toEqual({
      mode: "explicit",
      capabilities: [{ action: "edit", resources: ["workspace"], access: "write" }],
      writeCapable: true,
      budgetMode: "durable",
      budget: { maxAttempts: 2, maxDurationMs: 900_000, maxCostMicros: 1_000_000, maxTokens: 250_000 },
    })
    expect(
      delegatedTaskDetails({
        ...request,
        metadata: { capability_mode: "explicit", capabilities: [{ action: "edit", resources: [], access: "write" }] },
      }),
    ).toBeUndefined()
    expect(
      delegatedTaskDetails({
        ...request,
        metadata: {
          ...request.metadata,
          budget: { maxAttempts: 0, maxDurationMs: 900_000, maxCostMicros: 1_000_000, maxTokens: 250_000 },
        },
      }),
    ).toBeUndefined()
    expect(
      delegatedTaskDetails({
        ...request,
        metadata: {
          capability_mode: "default-read-only",
          capabilities: [{ action: "*", resources: ["*"], access: "read" }],
          budget_mode: "legacy-unmetered",
        },
      }),
    ).toMatchObject({ budgetMode: "legacy-unmetered", budget: undefined })
  })
})
