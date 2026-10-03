import { describe, expect, test } from "bun:test"
import { artifactOwnerContext } from "./handlers/artifact"

const principal = {
  userID: "usr_test",
  tenantID: "ten_test",
  email: "member@example.invalid",
  sessionID: "ses_test",
} as const

describe("artifact owner context", () => {
  test.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ] as const)("derives tenant readability for %s", (role, tenantReadable) => {
    const context = artifactOwnerContext({ ...principal, role })

    expect(context).toEqual({
      profile: { scope: "profile", id: "usr_test" },
      tenant: { scope: "tenant", id: "ten_test" },
      tenantReadable,
    })
    expect(JSON.stringify(context)).not.toContain("path")
    expect(JSON.stringify(context)).not.toContain("secret")
  })

  test("does not allow a caller-supplied owner scope to replace the principal", () => {
    const context = artifactOwnerContext({ ...principal, role: "member" })

    expect(context.profile.id).toBe(principal.userID)
    expect(context.tenant.id).toBe(principal.tenantID)
    expect(context.tenantReadable).toBe(false)
  })
})
