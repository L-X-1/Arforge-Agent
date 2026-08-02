---
title: Arforge Agent Acceptance Review and Roadmap 2026-06-15
category: synthesis
summary: Strict reviewer-style acceptance matrix for current Arforge Agent state, focused on user-facing usability, evidence, blockers, and next development priorities.
tags: [arforge, acceptance, roadmap, ship-gate, user-facing]
sources: 3
updated: 2026-06-15
---

# Arforge Agent Acceptance Review and Roadmap 2026-06-15

## Overall verdict
Recovery baseline: PASS.

User-facing product readiness: FAIL.

Ship-gate verdict: DO NOT SHIP as a real user-facing agent yet.

Reason: the source tree is maintainable and the smoke baseline is healthy, but the product still exposes placeholder chat/export flows, has tool routing bugs, weak capability routing, packaging contamination, dependency audit findings in the active Python environment, and incomplete public API surfaces for several promised architecture layers.

## Evidence collected
- `python -m pytest`: 58/58 passed.
- `python -m ruff check arforge tests\test_*.py main.py config.py --statistics`: passed with no output.
- Loader/skeleton scan: 0 `Recovered loader stub`, 0 `marshal.loads`, 0 `source_skeleton` in maintained `arforge/` and `arforge/` source.
- `arforge --version`: PASS.
- `arforge doctor`: PASS, 14 OK / 1 WARN / 0 FAIL at that historical checkpoint.
- `arforge privacy`: PARTIAL, prints static summary only.
- `arforge export`: FAIL for CLI usability, prints "Data export will be rebuilt".
- `arforge`: FAIL for real chat, prints "Interactive chat source is still under module-by-module reconstruction."
- `node bin\arforge.js --version` and `--help`: PASS for basic wrapper output.
- `npm audit --json`: PASS, zero npm vulnerabilities.
- `python -m pip_audit --local --desc off`: FAIL for current environment, 44 known vulnerabilities across 8 installed packages; some may be dev-only, but production runtime has not been isolated.
- `npm pack --dry-run --json`: FAIL, npm package includes `.recovery_pyc` artifacts and bytecode files.
- `python -m build --sdist --wheel`: PARTIAL, build succeeds, but artifacts are polluted.
- Wheel content check: FAIL, wheel contains 201 `arforge_corrupt_backup_*` files.
- sdist content check: FAIL, sdist contains 124 `.recovery_pyc` entries, 123 `.pyc` files, and 218 backup entries.

## Acceptance matrix

| Area | Requirement source | Evidence | Result | Verdict |
| --- | --- | --- | --- | --- |
| Source restoration | Status sections 22.19-22.21 | Tests pass, Ruff pass, loader/skeleton scan clean | Maintained source no longer depends on loader stubs | PASS |
| Brand identity | Identity requirement and README/package metadata | README title and Python package use Arforge Agent; `bin/install.js` contained corrupted Chinese text and duplicate-command copy | Mostly migrated at this checkpoint | PARTIAL |
| CLI startup | README quick start and user-facing command requirement | `arforge --version`, `arforge --version`, `arforge doctor` pass | Basic startup works | PASS |
| Interactive chat | Core product promise: local model capability enhancement agent | `arforge` prints reconstruction notice; `ArforgeAgent.call_model()` returns placeholder text | No real user-facing chat loop | FAIL |
| Model adapter | DeepSeek model API support | `DeepSeekAdapter().client is not None`; adapter can construct client | Adapter exists, but core agent does not call it | PARTIAL |
| Tool execution | Tools must be actionable | `calculate 2+2` works; `what time is it` raises TypeError due zero-arg tool receiving input | Tool registry has real execution bug | FAIL |
| Memory | Memory and persistent learning requirement | `save_memory_v2` and `query_memories` probe passed; probe data was cleaned | Basic SQLite memory works | PASS |
| Learning | Continuous learning requirement | Learning modules import, but no real user-facing learning loop or measurable improvement evidence | Structural only | PARTIAL |
| Safe file modification | Verification/recovery requirement | `safe_modify_file` probe compiled Python and passed | Basic safe write and compile verification work | PASS |
| Planning | Planning/orchestration requirement | `plan task` routes to planning capability and returns a simple checklist | Basic deterministic planning works | PARTIAL |
| Capability enhancement | Capability routing/fusion requirement | Only 3 default capabilities; `review security` and `analyze code` route to no capabilities | Too shallow for promised enhancement system | FAIL |
| Code intelligence | Code indexing/retrieval/context requirement | Import probes pass for indexers and retrievers | Basic static search/indexing exists, quality not fully benchmarked | PARTIAL |
| Multimodal adaptation | Product intro promises multimodal adapters | Image/document adapters exist under `arforge.capability.multimodal`; no top-level `arforge.multimodal`; no audio adapter | Incomplete and not user-facing | FAIL |
| Privacy | Privacy-oriented local data requirement | `arforge privacy` prints summary; no full inventory/export/consent workflow | Informational only | PARTIAL |
| Export | User data export requirement | Real `arforge.export_cli.export_data()` exists, but CLI command prints rebuild notice | Module works but user command fails product expectation | FAIL |
| Slash commands | README command table | Dispatcher only registers `/status` and `/help`; main CLI does not expose slash interaction | README promises more than implementation exposes | FAIL |
| Packaging | PyPI/npm install readiness | `npm pack` and Python build include recovery/backup artifacts | Release artifacts not acceptable | FAIL |
| Security | Ship-gate SEC/AI checks | `.env` ignored and no `.env` history hit; Node wrapper uses `shell: true`; no rate limiting or prompt-injection controls | Not production-ready | FAIL |
| Dependencies | Ship-gate DEP checks | npm audit clean; pip-audit environment not clean; dependencies not pinned exactly | Not release-ready | FAIL |
| Observability | Ship-gate OBS checks | Basic Python logging exists; no Sentry/alerting/uptime/manual evidence | Not production-ready | PARTIAL |
| Documentation | User-facing truthfulness | README still says emergency bytecode loader runtime | Out of date and misleading | FAIL |

## Blocking issues before user-facing release
1. Replace placeholder `ArforgeAgent.call_model()` and CLI chat path with a real DeepSeek-backed conversation loop.
2. Fix tool registry argument dispatch so zero-arg tools, parsed-arg tools, and raw-input tools all work reliably.
3. Wire slash commands and README command promises into the actual interactive CLI.
4. Remove `.recovery_pyc`, backup directories, `__pycache__`, and build artifacts from npm, sdist, and wheel outputs.
5. Update README development status so it no longer claims the runtime uses recovered bytecode loaders.
6. Fix `bin/install.js` identity text and duplicate-command message.
7. Remove `shell: true` from `bin/arforge.js` process spawning unless a documented Windows compatibility reason and argument escaping strategy exist.
8. Isolate runtime dependencies and rerun pip audit against a clean production environment.
9. Add capability routes for code review, security review, file modification, testing, explanation, planning, memory, and learning workflows.
10. Preserve superseded local data in an explicit archive during path consolidation.

## Roadmap

### Phase 1: Make the CLI honestly usable
- Implement `ArforgeAgent.call_model()` through `create_model_adapter("deepseek")`.
- Add non-interactive smoke commands such as `arforge ask "..."` and keep interactive mode for later polish.
- Wire `/review`, `/fix`, `/test`, `/explain`, `/plan`, `/learn status`, `/capability status`, `/doctor`, and `/help`.
- Make `arforge export` call the real export module.
- Add tests that assert user-facing CLI output is not placeholder text.

### Phase 2: Make tools and agent loop dependable
- Fix `ToolRegistry.execute()` argument dispatch.
- Add typed tool schemas or per-tool input adapters.
- Add tool-call tests for every registered tool.
- Connect tool execution results into model follow-up synthesis instead of appending raw output to a placeholder answer.
- Add retry and failure events to `AgentLoopV2.stream()`.

### Phase 3: Make capability enhancement real
- Expand default capabilities for code review, code search, security audit, safe modify, planning, memory search, learning injection, multimodal inspection, and command execution.
- Add route coverage tests for common user intents.
- Add confidence/evidence quality rules so empty capability results do not look successful.

### Phase 4: Make code intelligence useful
- Benchmark symbol search, import graph, call graph, reference search, and impact analysis on this repository.
- Add golden tests for code retrieval relevance.
- Produce a compact context package for model calls with file paths, line numbers, and risk notes.

### Phase 5: Make learning measurable
- Define learning data schema for task, context, decision, outcome, failure, fix, and regression.
- Convert dogfood sessions into searchable lessons.
- Add before/after metrics: task success, tool success, failed retries, hallucinated file paths, and regression rate.

### Phase 6: Make packaging shippable
- Remove recovery artifacts from `package.json` and `MANIFEST.in`.
- Prevent backup directories from matching package discovery.
- Build clean wheel/sdist/npm tarball and inspect contents in CI.
- Pin production dependency ranges and create a minimal runtime environment for `pip-audit`.

### Phase 7: Production hardening
- Add error monitoring hooks or at least structured error logging and log retention policy.
- Add explicit privacy consent around third-party model calls.
- Add prompt-injection and system-prompt leakage tests.
- Consolidate local data paths after preserving superseded data in an explicit archive.

## Next milestone definition
The next milestone should be "M1: Usable Local Agent CLI".

Acceptance criteria:
- `arforge ask "hello"` returns a real model response or a clear missing-config error.
- `arforge` interactive mode can complete at least one model-backed turn.
- `/help`, `/doctor`, `/plan`, `/review`, `/explain`, `/learn status`, `/capability status`, and `/export` all execute through the user-facing CLI.
- All registered tools have passing execution tests.
- Package dry runs contain no `.recovery_pyc`, backup directories, or `__pycache__`.
- README matches actual behavior.
