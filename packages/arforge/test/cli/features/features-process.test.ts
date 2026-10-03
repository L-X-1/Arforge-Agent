import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge features compatibility entry (TS Core owner)", () => {
  cliIt.concurrent(
    "lists the native feature policy and rejects legacy writes without side effects",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const json = yield* arforge.spawn(["features", "list", "--workspace", home, "--json"])
        arforge.expectExit(json, 0, "features list JSON")
        expect(json.stderr).toBe("")
        const policy = JSON.parse(json.stdout) as {
          schema_version: number
          source: string
          items: Array<{ flag_id: string; enabled: boolean; source: string }>
        }
        expect(policy.schema_version).toBe(1)
        expect(policy.source).toBe("typescript-core")
        expect(policy.items.length).toBeGreaterThan(0)
        expect(policy.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ flag_id: "file_history", enabled: true, source: "typescript-core" }),
            expect.objectContaining({ flag_id: "multimodal_diagnosis", enabled: true, source: "typescript-core" }),
          ]),
        )

        const human = yield* arforge.spawn(["features", "--workspace", home])
        arforge.expectExit(human, 0, "features human")
        expect(human.stdout).toContain("Feature policy")
        expect(human.stdout).toContain("file_history")
        expect(human.stdout).toContain("typescript-core")

        const auditJson = yield* arforge.spawn(["features", "--contract-audit", "--workspace", home, "--json"])
        arforge.expectExit(auditJson, 0, "features contract audit JSON")
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
        expect(audit.execution_mode).toBe("read-only-feature-policy-contract-audit")
        expect(audit.status).toBe("not_ready")
        expect(audit.ready).toBe(false)
        expect(audit.side_effects).toBe("none")
        expect(audit.writes).toBe(0)
        expect(audit.missing_requirements).toContain("transactional_update")
        expect(audit.caveat).toContain("feature_flags.json")

        const auditHuman = yield* arforge.spawn(["features", "--contract-audit", "--workspace", home])
        arforge.expectExit(auditHuman, 0, "features contract audit human")
        expect(auditHuman.stdout).toContain("功能策略合同审计（只读）")
        expect(auditHuman.stdout).toContain("feature_flags.json")

        const conflictingAudit = yield* arforge.spawn([
          "features",
          "set",
          "file_history",
          "off",
          "--contract-audit",
          "--workspace",
          home,
        ])
        arforge.expectExit(conflictingAudit, 1, "features contract audit conflict")
        expect(conflictingAudit.stdout).toBe("")
        expect(conflictingAudit.stderr).toContain("仅适用于")

        for (const args of [
          ["features", "set", "file_history", "off", "--workspace", home, "--json"],
          ["features", "clear", "file_history", "--workspace", home],
          ["features", "refresh", "--workspace", home],
        ]) {
          const blocked = yield* arforge.spawn(args)
          arforge.expectExit(blocked, 2, `features ${args[1]}`)
          expect(blocked.stdout).toBe("")
          expect(blocked.stderr).toContain("fail-closed")
          expect(blocked.stderr).toContain("features list")
        }

        expect(yield* Effect.promise(() => Bun.file(join(home, "feature_flags.json")).exists())).toBe(false)
      }),
    180_000,
  )
})
