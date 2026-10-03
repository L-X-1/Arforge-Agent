import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("arforge permissions compatibility entry (TS Core owner)", () => {
  cliIt.concurrent(
    "lists saved Core rules and rejects legacy mutations without a second profile",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const json = yield* arforge.spawn(["permissions", "list", "--workspace", home, "--json"])
        arforge.expectExit(json, 0, "permissions list JSON")
        expect(json.stderr).toBe("")
        const payload = JSON.parse(json.stdout) as {
          schema_version: number
          count: number
          items: Array<{ id: string; projectID: string; action: string; resource: string }>
        }
        expect(payload.schema_version).toBe(1)
        expect(payload.count).toBe(payload.items.length)
        expect(payload.items).toEqual([])

        const human = yield* arforge.spawn(["permissions", "--workspace", home])
        arforge.expectExit(human, 0, "permissions human")
        expect(human.stdout).toContain("Permission rules")
        expect(human.stdout).toContain("没有已保存规则")
        expect(human.stdout).toContain("TypeScript/Core")

        const auditJson = yield* arforge.spawn(["permissions", "--contract-audit", "--workspace", home, "--json"])
        arforge.expectExit(auditJson, 0, "permissions contract audit JSON")
        expect(auditJson.stderr).toBe("")
        const audit = JSON.parse(auditJson.stdout) as {
          workspace: string
          execution_mode: string
          status: string
          ready: boolean
          side_effects: string
          writes: number
          missing_requirements: string[]
          caveat: string
        }
        expect(audit.workspace).toBe(home)
        expect(audit.execution_mode).toBe("read-only-permission-policy-contract-audit")
        expect(audit.status).toBe("not_ready")
        expect(audit.ready).toBe(false)
        expect(audit.side_effects).toBe("none")
        expect(audit.writes).toBe(0)
        expect(audit.missing_requirements).toContain("optimistic_revision")
        expect(audit.caveat).toContain("permission_rules.json")

        const auditHuman = yield* arforge.spawn(["permissions", "--contract-audit", "--workspace", home])
        arforge.expectExit(auditHuman, 0, "permissions contract audit human")
        expect(auditHuman.stdout).toContain("权限策略合同审计（只读）")
        expect(auditHuman.stdout).toContain("permission_rules.json")

        const conflictingAudit = yield* arforge.spawn([
          "permissions",
          "add",
          "shell",
          "command",
          "allow",
          "--contract-audit",
          "--workspace",
          home,
        ])
        arforge.expectExit(conflictingAudit, 1, "permissions contract audit conflict")
        expect(conflictingAudit.stdout).toBe("")
        expect(conflictingAudit.stderr).toContain("仅适用于")

        for (const args of [
          ["permissions", "add", "shell", "command", "allow", "--workspace", home],
          ["permissions", "revoke", "perm_missing", "--workspace", home],
        ]) {
          const blocked = yield* arforge.spawn(args)
          arforge.expectExit(blocked, 2, `permissions ${args[1]}`)
          expect(blocked.stdout).toBe("")
          expect(blocked.stderr).toContain("fail-closed")
          expect(blocked.stderr).toContain("permissions list")
        }
      }),
    180_000,
  )
})
