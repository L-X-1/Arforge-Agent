---
title: Arforge Dogfood Training 2026-06-14
category: synthesis
summary: Real Arforge run/test/training session results and the practical route toward Codex-level agent quality.
tags: [arforge, dogfooding, training, quality-gate, codex-level]
sources: 2
updated: 2026-06-14
---

# Arforge Dogfood Training 2026-06-14

## Thesis
Arforge cannot become Codex-level by local weight training in this session. The practical route is to make it stronger through dogfooding, reliable evaluation, high-quality memory/learning records, standard pytest gates, real CLI tasks, and targeted fixes.

## What Was Actually Run
- `arforge --version`: passed.
- `arforge --help`: passed.
- `arforge doctor --json`: passed, 41 OK checks.
- `arforge privacy`: passed, but reported API keys in `.env` files.
- `arforge export`: passed and exported learning/preference data.
- Direct `ArforgeAgent.chat()` with UTF-8-safe Chinese and English prompts: model replies worked.
- `ArforgeAgent.chat_stream()` event probe: trace/reasoning/answer event stream worked.

## Script-Style Test Results
- `python test_memory_v2.py`: 41/41 passed.
- `python test_context_v2.py`: 66/66 passed.
- `python test_verifier_v2.py`: 79/79 passed.
- `python test_recovery.py`: 58/58 passed.
- `python test_doctor.py`: 33/33 passed.
- `python test_capability_registry.py`: 84/84 passed.
- `python test_multimodal_adapters.py`: 43/43 passed.
- `python test_capability_router.py`: 57/59 passed.
- `python test_data_tools.py`: 62/69 passed.

## Standard Pytest Gate Findings
The project does not yet have a clean standard pytest gate. Many files define a script helper named `test(name, condition)`, so pytest treats it as a test function and fails with fixture `name` not found. Many test files also call `sys.exit(1)` at module top level, causing pytest collection `INTERNALERROR`.

## Training Seed
Arforge long-term memory and Learning V2 were seeded with:
- Evidence-level discipline: distinguish import, doctor, script-test, pytest, real CLI, and dogfood evidence.
- Codex-level target: real closure, transparent routing, recoverable edits, standard test gates, low hallucination.
- Known failures: pytest collection shape, top-level `sys.exit`, chart generation, capability routing.
- Next route: Step196-199 before new features.

## Bottom Line
Arforge has many working subsystems, but it will not beat competing code agents by accumulating more modules. It gets closer by converting its current architecture into a reliable, measured, self-improving CLI agent with real dogfooding data and hard quality gates.

