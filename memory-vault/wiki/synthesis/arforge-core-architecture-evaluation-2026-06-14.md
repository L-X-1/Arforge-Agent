---
title: Arforge Core Architecture Evaluation 2026-06-14
category: synthesis
summary: Layer-by-layer true evaluation and staged development roadmap for Arforge Agent（灵枢智能体�?after repository and pytest review.
tags: [arforge, architecture-evaluation, roadmap, quality-gate]
sources: 2
updated: 2026-06-14
---

# Arforge Core Architecture Evaluation 2026-06-14

## Thesis
Arforge has the bones of a real local Agent Runtime, not a simple prompt wrapper. Its next phase should convert broad Alpha capability into repeatable product quality: passing tests, clean install, friendly errors, dogfooding telemetry, Plan Mode interaction, and targeted multimodal activation.

## Real Findings
- Repository scale remains about 150 Python files under `arforge/`, about 63,813 source lines, plus 43 test files and about 10,175 test lines.
- Full `python -m pytest -q` currently does not pass cleanly. Pytest enters `INTERNALERROR` during collection because `test_battle_scenarios.py` calls `sys.exit(1)` at module import.
- The battle scenario output itself reports 34/35 checks passed. The one failing scenario is data analysis chart generation: bar chart generation rejects the provided data format.
- The highest-maintenance files are `agent_core.py`, `cli.py`, `cli_ui.py`, `tool_executor.py`, `orchestrator.py`, `planner.py`, and `agent_loop_v2.py`.

## Layer Verdicts
- CLI/UI: directionally strong, but needs extraction of session state, command dispatch, input control, and stream rendering.
- Agent Core: route architecture is real, but `ArforgeAgent` has too many responsibilities.
- DeepSeek adapter: abstraction is correct, but DeepSeek-native cost/cache/error telemetry needs hard data.
- V2 Coding Loop: the most valuable chain, but needs transparent run reports and real dogfood success metrics.
- Context/Knowledge/Perception: rich module inventory, but retrieval quality must be evaluated by recall accuracy.
- Tool/Execution: usable but needs one standard tool schema and retirement of legacy routing paths.
- Security/Sandbox/Recovery: strong Alpha foundation, needs red-team command corpus and product-grade confirmations.
- Verification: useful, but current pytest failure means quality gate engineering is still P0.
- Memory/Learning: differentiating capability, but only real outcomes and correction data will prove value.
- Capability/Multimodal: good registry/router architecture, but OCR/document/image must move from interface to real task closure.
- Workflow/Plan Mode: promising, but needs interactive approval, phase state, risk display, and pause/resume.

## Roadmap
1. Step 196-199: fix pytest collection, crash containment, first-run config, dogfooding telemetry, P0 RC decision.
2. Step 200-203: Plan Mode V1, clean install regression, user docs, internal RC evaluation.
3. Step 204-206: OCR/document minimum viable loops with real screenshot/PDF tasks.
4. Step 207-210: CLI/Core/tool schema refactors and quality gate V1.

## Bottom Line
Do not add more modules until the current runtime becomes stable, installable, diagnosable, recoverable, learnable, and repeatedly dogfoodable as a CLI internal RC.

