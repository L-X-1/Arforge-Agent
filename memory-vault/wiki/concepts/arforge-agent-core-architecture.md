---
title: Arforge Agent（灵枢智能体�?Core Architecture
category: concept
summary: A layered local CLI agent architecture centered on ArforgeAgent, event streaming, DeepSeek model adaptation, V2 coding loop, tools, memory, knowledge, verification, recovery, learning, and capability routing.
tags: [arforge, architecture, cli, agent-core]
sources: 2
updated: 2026-06-14
---

# Arforge Agent（灵枢智能体�?Core Architecture

## Definition
Arforge's current architecture is a layered CLI agent runtime. `arforge.cli` owns the interactive shell and stream rendering. `ArforgeAgent` in `arforge.agent_core` owns routing, memory injection, context enhancement, learning adjustment, plan mode, safe modification, and model/tool dispatch. Coding tasks route into `agent_loop_v2`, which adds code retrieval, knowledge injection, reasoning, capability assessment, verification, safe apply, evaluation, and self-correction.

## Current layers
- CLI/UI layer: `cli.py`, `cli_ui.py`, `locale.py`, slash command modules, bottom input area, language switching, `/thought`, streaming Markdown rendering.
- Agent core layer: `agent_core.py`, `agent_event.py`, `agent_response.py`, `agent_trace.py`.
- Model layer: `model_adapter.py`, `model_factory.py`, `deepseek_adapter.py`; currently DeepSeek-first with adapter hooks for future providers.
- Coding loop layer: `agent_loop_v2.py`, `context_v2.py`, `code_retrieval.py`, knowledge/context/ranking modules.
- Tool/execution layer: `tool_executor.py`, `tool_registry.py`, `arforge/tools/*`, `sandbox.py`, `permission.py`.
- Verification and recovery layer: `verifier.py`, `verifier_v2.py`, `recovery.py`, `backup_manager.py`, `safe_modifier.py`, `diff_*`.
- Knowledge/perception layer: `knowledge_v2.py`, `knowledge_graph.py`, code indexers, call graph, API/database/class/dependency analyzers.
- Memory/learning layer: `memory.py`, `semantic_memory.py`, `auto_memory.py`, `learning_v2.py`, `learning_*`.
- Capability enhancement layer: `arforge/capability/*`, including registry, router, fusion, enhanced pipeline, evidence builders, multimodal adapters.
- Product hardening layer: `doctor.py`, `privacy_cli.py`, `export_cli.py`, status and slash command extensions.

## Key claims
- The core routing path is explicit: memory write, tool result, orchestration, workflow, code analysis, general coding task, coding intent, complex plan, then normal chat.
- The stream protocol separates trace, reasoning, answer, final, and error events, which supports a thought/answer separation without flooding the UI.
- The broad module set is structurally coherent, but the next quality jump depends more on dogfooding, installation, error containment, and documentation than on adding new layers.

## Used in
- [[synthesis/arforge-agent-architecture-2026-06-14]]

