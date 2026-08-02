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
// Speed: each test pays ~1.5s for bun startup. 7 tests serialize within this
// file. See script/prebuild-test-cli.ts for an opt-in pre-built binary that
// cuts per-spawn cost when this suite gets bigger.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
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
        expect(r.stdout.trim()).toMatch(/^(:memory:|[/\\].+\.(db|sqlite|sqlite3))$/i)
      }),
    60_000,
  )

  cliIt.live(
    "quality: executes the shared Python quality gate and returns JSON",
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
