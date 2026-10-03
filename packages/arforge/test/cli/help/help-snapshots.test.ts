// Help-text snapshots for every CLI command + key subcommand. Catches
// accidental flag removals, renames, and reordering in a single sweep —
// any change to the user-visible CLI surface shows up here as a diff.
//
// This is the broad coverage layer that makes the future Effect CLI
// migration (yargs → effect-smol/cli) safe to attempt: if a refactor
// preserves the surface, the snapshots stay green; if it doesn't, the
// diff tells you exactly which command(s) changed.
//
// Snapshots are taken at COLUMNS=120 so wrapping is stable across
// terminal sizes. The default arforge tui command is excluded —
// `arforge --help` includes an ASCII banner that pulls in the install
// version (changes per release), so we'd snapshot a moving target.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { normalizeForSnapshot, PATH_SEP } from "../../lib/snapshot"

// Composes `normalizeForSnapshot` (CRLF + tmpdir) with two help-specific
// rules:
//
//   1. The harness's `oc-cli-XXX` subdir under TMPDIR collapses to `<HOME>`.
//      `PATH_SEP` matches `/` and `\\` so the rule works on POSIX + Windows.
//
//   2. yargs wraps the `[string] [default: "..."]` clause based on the
//      pre-normalized default's character length, so different random home
//      path widths produce different leading-whitespace counts (or even
//      line-wraps onto a fresh line on Windows). `\s+` matches both forms.
function normalize(text: string): string {
  const normalized = normalizeForSnapshot(text, {
    pathReplacements: [
      // Mixed-case [A-Za-z0-9] because node's mkdtemp suffix is mixed-case
      // (the harness now uses FileSystem.makeTempDirectoryScoped under the
      // hood). A `[a-z0-9]+` regex would leave uppercase chars trailing.
      [new RegExp(`<TMPDIR>${PATH_SEP}oc-cli-[A-Za-z0-9]+`, "g"), "<HOME>"],
      [/\s+\[string\] \[default: "<HOME>"\]/g, ' [string] [default: "<HOME>"]'],
      [/^[ \t]+\[string\] \[default: "arforge\.local"\]/gm, '      [string] [default: "arforge.local"]'],
    ],
  })
  // yargs calculates its right-aligned metadata column from process-local
  // terminal measurements. On Windows, otherwise identical child processes
  // can differ by one padding cell even with a fixed COLUMNS value. Preserve
  // every semantic token while collapsing only that presentation padding.
  return normalized.replace(/[ \t]{2,}(?=\[(?:aliases|boolean|string|number|array|choices|default)\b)/g, " ")
}

// Top-level commands. Order matches what `arforge --help` prints today;
// keep it in that order so the snapshot file reads as a table of contents.
// `completion` is intentionally excluded — it's a yargs built-in that emits
// top-level help on `--help` and exits 1; not a real arforge command.
const TOP_LEVEL = [
  "acp",
  "mcp",
  "attach",
  "run",
  "ask",
  "print",
  "chat",
  "debug",
  "config",
  "providers", // aliased to `auth`
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "capabilities",
  "quality",
  "repo-scale",
  "run-history",
  "replay", // historical Python spelling; same TypeScript/Core owner
  "goal",
  "task",
  "subagent-control",
  "prompt-queue",
  "workflow",
  "memory",
  "learning",
  "feedback",
  "agent-metrics",
  "multimodal-diagnose",
  "features",
  "permissions",
  "skill",
  "skills", // historical Python plural spelling; same TS command owner
  "plugin-manager",
  "plugins", // historical Python plural spelling; same TS command owner
  "stats",
  "export",
  "import",
  "session",
  "plugin",
  "db",
] as const

// Subcommands worth pinning. Not exhaustive — the goal is one snapshot per
// distinct argv shape, not every leaf. Add new entries when a subcommand
// gains user-visible flags that we want to lock in.
const SUBCOMMANDS = [
  ["mcp", "list"],
  ["mcp", "health"],
  ["mcp", "capabilities"],
  ["mcp", "add"],
  ["mcp", "auth"],
  ["mcp", "logout"],
  ["providers", "list"],
  ["providers", "login"],
  ["providers", "logout"],
  ["agent", "create"],
  ["agent", "list"],
  ["session", "list"],
  ["session", "delete"],
  ["capabilities", "test"],
  ["capabilities", "evaluate"],
  ["memory", "status"],
  ["memory", "list"],
  ["memory", "search"],
  ["memory", "write-stats"],
  ["memory", "recovery"],
  ["memory", "feedback"],
  ["memory", "create"],
  ["learning", "status"],
  ["learning", "record"],
  ["learning", "undo"],
  ["learning", "sync-dogfood"],
  ["feedback", "summary"],
  ["feedback", "list"],
  ["feedback", "submit"],
  ["feedback", "delete"],
  ["agent-metrics", "history"],
  ["agent-metrics", "record"],
  ["skill", "route"],
  ["skills", "route"],
  ["plugins", "install"],
  ["db", "path"],
  ["db", "current"],
] as const

// Fixed wrap width so a developer's terminal doesn't affect snapshots.
// yargs honors COLUMNS; CI runners typically default to 80 which produces
// different wraps from a 200-col local terminal.
const SNAPSHOT_ENV = { COLUMNS: "120" }

describe("arforge CLI help-text snapshots", () => {
  // Single test, parallel spawns. Each command's help fires under
  // `concurrency: 8` — wall-clock stays under ~10s even for ~35 commands,
  // versus ~1 minute if we serialized.
  cliIt.live(
    "every documented command emits stable help text",
    ({ arforge }) =>
      Effect.gen(function* () {
        const topLevel = yield* arforge.spawn(["--help"], { env: SNAPSHOT_ENV })
        if (topLevel.exitCode !== 0) {
          throw new Error(`arforge --help exited ${topLevel.exitCode}:\n${topLevel.stderr || topLevel.stdout}`)
        }
        expect(topLevel.exitCode).toBe(0)
        expect(topLevel.stderr.endsWith("\n")).toBe(true)
        expect(topLevel.stderr).toContain("--mini")
        expect(topLevel.stderr).not.toContain("--thinking")
        expect(topLevel.stderr).not.toContain("--variant")
        expect(topLevel.stderr).not.toContain("--demo")

        const argvs: Array<readonly string[]> = [...TOP_LEVEL.map((c) => [c] as const), ...SUBCOMMANDS]

        // Spawn in parallel, then assert in argv order so snapshot output is
        // deterministic and per-command failures don't abort the rest of
        // the sweep. `Effect.partition` is the canonical "run all, separate
        // failures from successes" primitive — no mutable accumulator needed.
        const [failures, results] = yield* Effect.partition(
          argvs,
          (argv) =>
            Effect.gen(function* () {
              const result = yield* arforge.spawn([...argv, "--help"], { env: SNAPSHOT_ENV })
              if (result.exitCode !== 0) {
                return yield* Effect.fail(`arforge ${argv.join(" ")}: exit ${result.exitCode}`)
              }
              return { argv, result }
            }),
          { concurrency: 8 },
        )

        for (const { argv, result } of results) {
          // yargs writes --help to stderr, not stdout. Snapshotting stderr
          // means our test catches the help body; stdout for these commands
          // is expected to be empty.
          expect(normalize(result.stderr)).toMatchSnapshot(`arforge ${argv.join(" ")} --help`)
        }
        if (failures.length > 0) {
          throw new Error(`Help text failed for:\n  ${failures.join("\n  ")}`)
        }

        // A common legacy invocation must fail before TTY probing so users get
        // the actionable argument error instead of a generic interactive error.
        const invalidChat = yield* arforge.spawn(["chat", "--no-replay"], { env: SNAPSHOT_ENV })
        expect(invalidChat.exitCode).toBe(1)
        expect(invalidChat.stderr).toContain("--no-replay requires --mini")

        // Python-era print spellings now resolve to the same TS run owner;
        // they must expose the real print contract instead of a second parser.
        const legacyPrint = yield* arforge.spawn(["print", "--help"], { env: SNAPSHOT_ENV })
        expect(legacyPrint.exitCode).toBe(0)
        expect(legacyPrint.stderr).toContain("--input-format")
        expect(legacyPrint.stderr).not.toContain("Python")

        const legacyPrintFlag = yield* arforge.spawn(["--print", "--help"], { env: SNAPSHOT_ENV })
        expect(legacyPrintFlag.exitCode).toBe(0)
        expect(legacyPrintFlag.stderr).toContain("--final-message-only")
        expect(legacyPrintFlag.stderr).not.toContain("Python")
      }),
    180_000,
  )
})
