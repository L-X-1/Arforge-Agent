// Tier-A smoke tests for read-only commands. Each test asserts only that the
// command exits 0 and produces *some* output in the isolated harness env.
//
// These are not behavioral tests — they're the cheapest possible signal that
// the dependency-layer wiring (config load, DB init, server boot, provider
// resolution) doesn't crash for the broad class of "no inputs, no side
// effects" commands. A regression in any shared layer (an Effect.fail that
// propagates out of a service constructor, a renamed env var, a broken DB
// migration) will fail one or more of these tests.
//
// If a future change should make one of these commands intentionally fail in
// an empty env, update the assertion + add a note explaining the new contract.
//
// Speed: each test pays ~1.5s for bun startup. The smoke tests serialize within this
// file. See script/prebuild-test-cli.ts for an opt-in pre-built binary that
// cuts per-spawn cost when this suite gets bigger.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge read-only commands (smoke)", () => {
  // `mcp list` reads MCP server config and pings each one. With the empty
  // ARFORGE_CONFIG_CONTENT={} we provide, no servers should be configured
  // and the command should report that cleanly.
  cliIt.live(
    "mcp list: exits 0",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["mcp", "list"])
        arforge.expectExit(r, 0, "mcp list")
      }),
    60_000,
  )

  // `providers list` enumerates credentials + env-resolved providers.
  // (Not config-injected ones — those don't appear here by design.) The
  // Credentials header always renders; the Environment header only renders
  // when at least one provider env var is set, which the isolation harness
  // deliberately doesn't guarantee. Assert the always-present marker so the
  // test passes on a clean CI runner without env-var leakage.
  cliIt.live(
    "providers list: exits 0 and prints the credentials section",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["providers", "list"])
        arforge.expectExit(r, 0, "providers list")
        expect(r.stdout).toContain("Credentials")
      }),
    60_000,
  )

  // `models` lists models from configured providers. Our test/test-model
  // should appear because it's wired into the test provider config.
  cliIt.live(
    "models: exits 0 and lists the test model",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["models"])
        arforge.expectExit(r, 0, "models")
        expect(r.stdout).toContain("test/test-model")
      }),
    60_000,
  )

  // `agent list` walks the agent config. Empty config means no agents
  // configured; the command should still exit 0 with a "no agents" line or
  // similar. We don't pin the message — just exit cleanly.
  cliIt.live(
    "agent list: exits 0",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["agent", "list"])
        arforge.expectExit(r, 0, "agent list")
      }),
    60_000,
  )

  // `session list` reads the session DB. Fresh ARFORGE_TEST_HOME means
  // empty DB. Exit 0 with no sessions.
  cliIt.live(
    "session list: exits 0",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["session", "list"])
        arforge.expectExit(r, 0, "session list")
      }),
    60_000,
  )

  // `stats` aggregates token usage from the session DB. Empty DB → all zeros.
  cliIt.live(
    "stats: exits 0",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["stats"])
        arforge.expectExit(r, 0, "stats")
      }),
    60_000,
  )

  // `db path` prints the DB file location. Under harness isolation the DB
  // resolves to SQLite's `:memory:` (no on-disk pollution between tests);
  // in production it'd be a path under ARFORGE_TEST_HOME / XDG_DATA_HOME.
  // Accept either form — both prove the resolver ran without crashing.
  cliIt.live(
    "db path: exits 0 and prints a path or :memory:",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["db", "path"])
        arforge.expectExit(r, 0, "db path")
        expect(r.stdout.trim()).toMatch(/^(:memory:|(?:[A-Za-z]:)?[/\\].+\.(db|sqlite|sqlite3))$/i)
      }),
    60_000,
  )

  cliIt.live(
    "custom-agents status: reads the profile contract without creating state",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["custom-agents", "status", "--json"])
        arforge.expectExit(r, 0, "custom-agents status")
        expect(JSON.parse(r.stdout)).toMatchObject({
          activation: "ARFORGE_ENABLE_CUSTOM_AGENTS=1",
          enabled: false,
          workspace_trusted: false,
        })
      }),
    60_000,
  )

  cliIt.live(
    "custom-agents list: explains admission state without changing JSON parity",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const directory = join(home, ".arforge", "agents")
        const profilePath = join(directory, "review.json")
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        yield* Effect.promise(() =>
          writeFile(
            profilePath,
            JSON.stringify({
              schema_version: 1,
              name: "release-reviewer",
              description: "Reviews release changes.",
              system_prompt: "Review the supplied change carefully and report concrete issues with evidence.",
              tools: ["read_file"],
              capabilities: ["code_review"],
              max_steps: 6,
              max_tokens: 2_048,
              timeout_seconds: 45,
            }),
            "utf8",
          ),
        )

        const notEnabled = yield* arforge.spawn(["custom-agents", "list", "--workspace", home], {
          env: { ARFORGE_ENABLE_CUSTOM_AGENTS: "", ARFORGE_TRUST_WORKSPACE: "" },
        })
        arforge.expectExit(notEnabled, 0, "custom-agents list not enabled")
        expect(notEnabled.stdout).toContain("未启用：需要显式开启 ARFORGE_ENABLE_CUSTOM_AGENTS=1")
        expect(notEnabled.stdout).toContain("证据：阻断（4/4 项检查通过")

        const admitted = yield* arforge.spawn(["custom-agents", "list", "--workspace", home], {
          env: { ARFORGE_ENABLE_CUSTOM_AGENTS: "1", ARFORGE_TRUST_WORKSPACE: "1" },
        })
        arforge.expectExit(admitted, 0, "custom-agents list admitted")
        expect(admitted.stdout).toContain("可准入（TS durable child）")
        expect(admitted.stdout).toContain("证据：准入（4/4 项检查通过")

        const json = yield* arforge.spawn(["custom-agents", "list", "--workspace", home, "--json"], {
          env: { ARFORGE_ENABLE_CUSTOM_AGENTS: "1", ARFORGE_TRUST_WORKSPACE: "1" },
        })
        arforge.expectExit(json, 0, "custom-agents list JSON")
        const payload = JSON.parse(json.stdout) as { profiles: Array<Record<string, unknown>>; errors: unknown[] }
        expect(payload.errors).toEqual([])
        expect(payload.profiles).toHaveLength(1)
        expect(payload.profiles[0]).toMatchObject({
          name: "release-reviewer",
          role: "CustomAgent.release-reviewer",
        })
        expect(payload.profiles[0]).not.toHaveProperty("runtime")
      }),
    60_000,
  )

  cliIt.live(
    "workspace list: reports the primary authorized root without creating state",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["workspace", "list", "--workspace", home, "--json"])
        arforge.expectExit(r, 0, "workspace list")
        expect(JSON.parse(r.stdout)).toEqual({
          primary: home,
          roots: [{ path: home, primary: true, trusted: false }],
        })
        expect(yield* Effect.promise(() => Bun.file(join(home, "workspace_roots.json")).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "workspace contract audit: exposes the canonical owner binding while keeping writes disabled",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["workspace", "--contract-audit", "--workspace", home, "--json"])
        arforge.expectExit(r, 0, "workspace contract audit")
        const report = JSON.parse(r.stdout) as Record<string, unknown>
        expect(report.owner_binding).toMatchObject({
          owner: "typescript-core-workspace-root-writer",
          profile_directory: home,
          enabled: false,
        })
        expect(report.production_owner_evidence).toMatchObject({
          execution_mode: "read-only-workspace-root-production-owner-evidence",
          side_effects: "none",
          owner: "typescript-core-workspace-root-writer",
          binding_status: "complete",
          missing_seams: [],
          writer_enabled: false,
          status: "blocked",
          ready: false,
          decision: "keep-disabled",
        })
        expect(report.execution_boundary).toEqual({
          mode: "read-only",
          writes: false,
          creates_profile_state: false,
          repairs_recovery: false,
          provider_execution_allowed: false,
        })
        expect(report.writer_preflight).toMatchObject({
          execution_mode: "read-only-workspace-root-writer-preflight",
          side_effects: "none",
          status: "clear",
          ready: true,
          blocking_reasons: [],
        })
        expect(report.runtime_invariant).toMatchObject({
          owner: "workspace-root-writer",
          key: "preflight",
          keys: ["preflight", "enable-gate", "production-owner"],
          version: "1",
          status: "available-typed-snapshot-only",
          grants_mutation: false,
        })
        const human = yield* arforge.spawn(["workspace", "--contract-audit", "--workspace", home])
        arforge.expectExit(human, 0, "workspace contract audit (human)")
        expect(human.stdout).toContain("- writer.profile：satisfied")
        expect(human.stdout).toContain("- writer.lock：satisfied")
        expect(human.stdout).toContain(
          "运行时不变量：workspace-root-writer · keys=preflight, enable-gate, production-owner · 仅检查不授权",
        )
        expect(human.stdout).toContain("生产 owner 证据：complete · seams=8/8 · 仅检查不授权")
        expect(human.stdout).toContain("执行边界：read-only · writes=0 · 不创建或修复 profile 状态 · Provider=禁止")
        expect(report).toMatchObject({ status: "not_ready", ready: false, side_effects: "none" })
        expect((report.enable_gate as { decision: string }).decision).toBe("keep-disabled")

        yield* Effect.promise(() => writeFile(join(home, "trusted_workspaces.json"), '{"workspaces":[]}', "utf8"))
        const partial = yield* arforge.spawn(["workspace", "--contract-audit", "--workspace", home, "--json"])
        arforge.expectExit(partial, 0, "workspace contract audit (partial state)")
        const partialReport = JSON.parse(partial.stdout) as Record<string, unknown>
        expect(partialReport.writer_preflight).toMatchObject({ status: "blocked", ready: false })
        expect(partialReport.writer_preflight).toMatchObject({
          checks: expect.arrayContaining([
            expect.objectContaining({
              id: "state",
              status: "blocked",
              observation: "trusted_workspaces.json=present; workspace_roots.json=missing",
              reason: "state_malformed",
            }),
          ]),
        })
        const partialHuman = yield* arforge.spawn(["workspace", "--contract-audit", "--workspace", home])
        arforge.expectExit(partialHuman, 0, "workspace contract audit (partial state human)")
        expect(partialHuman.stdout).toContain(
          "- writer.state：blocked · trusted_workspaces.json=present; workspace_roots.json=missing · reason=state_malformed",
        )
      }),
    60_000,
  )

  cliIt.live(
    "workspace mutation: routes through the TS owner and explains the disabled gate",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const target = join(home, "additional-root")
        yield* Effect.promise(() => mkdir(target, { recursive: true }))
        const r = yield* arforge.spawn(["workspace", "trust", target, "--workspace", home])
        arforge.expectExit(r, 2, "workspace trust")
        expect(r.stderr).toContain("writer=disabled")
        expect(r.stderr).toContain("blocking=durable-state-owner,cas-rollback,recovery-outbox-audit,runtime-invariant")
        expect(r.stderr).toContain("未回退到 Python writer")
        expect(yield* Effect.promise(() => Bun.file(join(home, "trusted_workspaces.json")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(join(home, "workspace_roots.json")).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "sandbox-status: reports the TypeScript/Core policy without running a task",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["sandbox-status", "--profile", "read-only", "--network", "none", "--json"])
        arforge.expectExit(r, 0, "sandbox-status")
        const report = JSON.parse(r.stdout) as Record<string, unknown>
        expect(report).toMatchObject({
          schema_version: 1,
          runtime: "typescript",
          policy: { profile: "read-only", network: "none" },
        })
        expect(String(report.caveat)).toContain("不准备或执行子进程")
      }),
    60_000,
  )

  cliIt.live(
    "settlement-status: reports the fail-closed recovery decision without writing",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["settlement-status", "--json"])
        arforge.expectExit(r, 0, "settlement-status")
        const report = JSON.parse(r.stdout) as Record<string, unknown>
        expect(report).toMatchObject({
          schema_version: 1,
          runtime: "typescript",
          owner: "core-settlement-coordinator",
          mode: "recovery-outbox",
          ready: false,
          decision: "keep-recovery-outbox",
          provider_execution_allowed: false,
          blocking_gate_ids: ["event-v2-shared-transaction"],
          observation: {
            owner: "settlement-coordinator",
            journal: "parent-run-event-v1",
            event_type: "agent.child-run.settlement-observation-recorded.1",
            payload: "metadata-only",
            review_only: true,
            promotion_authorized: false,
          },
          execution_boundary: {
            mode: "read-only",
            writes: false,
            creates_settlement_state: false,
            repairs_recovery: false,
            provider_execution_allowed: false,
          },
        })
        expect(String(report.decision_digest)).toMatch(/^[a-f0-9]{64}$/)
        expect(String(report.caveat)).toContain("不会调用 Provider")
        const human = yield* arforge.spawn(["settlement-status"])
        arforge.expectExit(human, 0, "settlement-status (human)")
        expect(human.stdout).toContain("子任务结算门禁（只读）")
        expect(human.stdout).toContain("生产同事务：未启用")
        expect(human.stdout).toContain("执行边界：只读 · writes=0 · 不创建结算状态、不自动修复 · Provider=禁止")
        expect(human.stdout).toContain("持久观测：parent-run-event-v1")
        expect(human.stdout).toContain("自动晋级=禁止")
        expect(human.stdout).toContain("event-v2-shared-transaction")
      }),
    60_000,
  )

  cliIt.live(
    "settlement-recovery: requires an explicit confirmation and runs the bounded TS sweep",
    ({ arforge }) =>
      Effect.gen(function* () {
        const blocked = yield* arforge.spawn(["settlement-recovery", "--json"])
        arforge.expectExit(blocked, 2, "settlement-recovery without confirmation")
        expect(JSON.parse(blocked.stdout)).toMatchObject({
          schemaVersion: 1,
          runtime: "typescript",
          owner: "core-child-settlement-recovery",
          confirmationRequired: true,
          writes: false,
          providerExecutionAllowed: false,
        })
        const confirmed = yield* arforge.spawn([
          "settlement-recovery",
          "--confirm",
          "recover_settlements",
          "--limit",
          "10",
          "--json",
        ])
        arforge.expectExit(confirmed, 0, "settlement-recovery empty sweep")
        expect(JSON.parse(confirmed.stdout)).toMatchObject({
          schemaVersion: 1,
          runtime: "typescript",
          owner: "core-child-settlement-recovery",
          limit: 10,
          scanned: 0,
          committed: 0,
          pending: 0,
          recoveryRequired: 0,
          failed: 0,
          hasMore: false,
          deterministic: true,
          providerExecutionAllowed: false,
          execution_boundary: {
            mode: "metadata-only-recovery",
            writes: true,
            provider_execution_allowed: false,
            external_retry: false,
          },
        })
      }),
    60_000,
  )

  cliIt.live(
    "quality: executes the shared TypeScript/Core quality gate and returns JSON",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["quality", "--json"])
        arforge.expectExit(r, 0, "quality")
        expect(JSON.parse(r.stdout)).toMatchObject({
          passed: true,
          score: 100,
          files_checked: 0,
        })
      }),
    60_000,
  )

  cliIt.live(
    "repo-scale: executes the bounded repository scanner and returns JSON",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["repo-scale", "--max-files", "50", "--limit", "5", "--json"])
        arforge.expectExit(r, 0, "repo-scale")
        expect(JSON.parse(r.stdout)).toMatchObject({
          schema_version: 1,
          budget: { max_files: 50 },
          scan: { truncated: false },
          search: { query: "", total: 0 },
        })
      }),
    60_000,
  )

  cliIt.live(
    "run-history: lists preserved run records as typed JSON",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["run-history", "--limit", "5", "--json"])
        arforge.expectExit(r, 0, "run-history")
        const data = JSON.parse(r.stdout)
        expect(data).toMatchObject({ schema_version: 1 })
        expect(data.count).toBe(data.items.length)
      }),
    60_000,
  )

  cliIt.live(
    "run-history: reports a missing run without failing the command",
    ({ arforge }) =>
      Effect.gen(function* () {
        const r = yield* arforge.spawn(["run-history", "definitely-missing-run", "--json"])
        arforge.expectExit(r, 0, "run-history missing report")
        expect(JSON.parse(r.stdout)).toMatchObject({
          schema_version: 1,
          found: false,
          run_id: "definitely-missing-run",
          report: null,
        })
      }),
    60_000,
  )
})
