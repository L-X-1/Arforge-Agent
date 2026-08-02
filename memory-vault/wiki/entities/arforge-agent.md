---
title: Arforge Agent
category: entity
summary: Formal international brand for Arforge Agent (灵枢智能体), a local model capability enhancement agent system.
tags: [arforge, lingshu, brand, agent-system, model-enhancement]
sources: 1
updated: 2026-07-19
---

# Arforge Agent（灵枢智能体）

## What it is
Arforge Agent（中文名：灵枢智能体）is a local model capability enhancement agent system that uses tools, memory, execution, verification, multimodal adaptation, and continuous learning to forge different large models into agents that can act, remember, and evolve.

## Why it matters
"Arforge" emphasizes forging and strengthening models into capable agents; "灵枢" emphasizes the central intelligence hub that coordinates memory, tools, perception, execution, and learning.

## Key facts
- International name: Arforge Agent.
- Chinese name: 灵枢智能体.
- Formal bilingual display name: Arforge Agent（灵枢智能体）.
- Product category: local model capability enhancement agent system.
- Core promise: forge different large models into actionable, memorable, and evolvable agents.
- README, CLI help/version/banner, install script, Python package metadata, npm package metadata, module namespace, command entry point, and local data path all use the same product identity.
- Source restoration baseline completed on 2026-06-15.
- **On 2026-06-16, all 7 staged milestones (M1-M7) were completed:**
  - M1 Usable Local Agent CLI — DeepSeek adapter connected, interactive chat, export
  - M2 Tool and Agent Execution Loop — 12 tools with full schema, AgentLoopV2
  - M3 Capability Enhancement — 10 capabilities with real handlers and model calls
  - M4 Code Intelligence Quality — unified CodeIntelligence, 20 golden queries
  - M5 Learning and Memory Evolution — LearningSystem, auto-recording, injection
  - M6 Packaging and Release Hygiene — clean dist, no bytecode/backup artifacts
  - M7 Security, Privacy, Observability — injection detection, key masking, rate limiting
- **Final metrics: 218/218 pytest, Ruff clean, 12 tools, 10 capabilities, 20 golden queries**
- **On 2026-06-18, P1 fixes A1+A2+A3 completed:**
  - A1: Learning injection loop — `injection_total` from hardcoded 0 to real SQL counting
  - A2: 2 stub capabilities rewritten with real file modification / multimodal inspection
  - A3: AgentLoopV2 verify+retry loop — execute→verify→(retry×N)→synthesize with exponential backoff
  - 44 new tests, 220 passed, Ruff clean, zero regressions
  - P1 progress: 3/5, overall 38% (6/16 tasks)
- **On 2026-06-18, the reasoning layer was refactored:**
  - Created `arforge/reasoning/` package with structured multi-stage reasoning pipeline
  - 5-stage model-driven reasoning: UNDERSTAND → THINK → GATHER → VERIFY → ANSWER
  - XML-tagged structured output with robust fallback parsing
  - 4 reasoning modes: Quick / Coding / Planning / Full
  - DeepSeek Reasoner native `reasoning_content` capture
  - 216/218 pytest, Ruff clean on reasoning/

## Brand language
- Short intro: Arforge Agent（灵枢智能体）是一个本地大模型能力增强智能体系统。
- English short intro: Arforge Agent is a local model capability enhancement agent system.
- Primary slogan candidate: Forge models into agents.
- Chinese slogan candidate: 锻模型为智能体。

## Appears in
- [[concepts/brand-identity-migration]]
- [[synthesis/arforge-m1-m7-completion-2026-06-16]]
- [[synthesis/arforge-p1-fix-a3-verify-retry-2026-06-18]]
- [[synthesis/arforge-p1-fixes-a1-a2-2026-06-18]]
- [[synthesis/arforge-reasoning-layer-refactor-2026-06-18]]

## Open questions
- Final public PyPI/npm availability still needs web verification before external release.
