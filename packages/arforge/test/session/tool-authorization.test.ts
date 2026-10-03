import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ScopeEscalationError, evaluateLeafAuthorization } from "@/session/tool-authorization"

const active = (requests: ReadonlyArray<{ action: string; resources: ReadonlyArray<string> }>) => ({
  actionID: AgentRuntime.ActionID.create(),
  plan: { requests },
})

describe("mature leaf authorization", () => {
  test("reuses only an identical or wildcard scope for the same permission", () => {
    expect(
      evaluateLeafAuthorization(active([{ action: "edit", resources: ["src/a.ts"] }]), {
        permission: "edit",
        patterns: ["src\\a.ts"],
      }),
    ).toBe("authorized")
    expect(
      evaluateLeafAuthorization(active([{ action: "plugin", resources: ["*"] }]), {
        permission: "plugin",
        patterns: ["external-service"],
      }),
    ).toBe("authorized")
  })

  test("authorizes a leaf against any canonical request of the same permission", () => {
    expect(
      evaluateLeafAuthorization(
        active([
          { action: "edit", resources: ["src/a.ts"] },
          { action: "external_directory", resources: ["C:/outside/*"] },
        ]),
        {
          permission: "external_directory",
          patterns: ["C:/outside/*"],
        },
      ),
    ).toBe("authorized")
  })

  test("fails closed when a leaf expands a preauthorized resource", () => {
    const result = evaluateLeafAuthorization(active([{ action: "edit", resources: ["src/a.ts"] }]), {
      permission: "edit",
      patterns: ["src/b.ts"],
    })

    expect(result).toBeInstanceOf(ScopeEscalationError)
    expect(result).toMatchObject({
      granted: [{ action: "edit", resources: ["src/a.ts"] }],
      requested: { permission: "edit", patterns: ["src/b.ts"] },
    })
  })

  test("fails closed when a leaf requests an external-directory scope the preflight did not bind", () => {
    const result = evaluateLeafAuthorization(
      active([
        { action: "edit", resources: ["src/a.ts"] },
        { action: "external_directory", resources: [] },
      ]),
      {
        permission: "external_directory",
        patterns: ["C:/outside/*"],
      },
    )

    expect(result).toBeInstanceOf(ScopeEscalationError)
  })

  test("does not treat a different permission as covered by the active grant", () => {
    const result = evaluateLeafAuthorization(active([{ action: "edit", resources: ["src/a.ts"] }]), {
      permission: "external_directory",
      patterns: ["C:/outside/*"],
    })

    expect(result).toBeInstanceOf(ScopeEscalationError)
    expect(result).toMatchObject({
      granted: [{ action: "edit", resources: ["src/a.ts"] }],
      requested: { permission: "external_directory", patterns: ["C:/outside/*"] },
    })
  })

  test("does not widen a fresh L3 shell approval to parser-derived fragments", () => {
    const result = evaluateLeafAuthorization(active([{ action: "bash", resources: ["npm test && git status"] }]), {
      permission: "bash",
      patterns: ["npm test", "git status"],
    })

    expect(result).toBeInstanceOf(ScopeEscalationError)
  })

  test("falls back to the legacy interactive gate only when there is no active preflight", () => {
    expect(
      evaluateLeafAuthorization(undefined, {
        permission: "read",
        patterns: ["src/a.ts"],
      }),
    ).toBe("legacy")
  })
})
