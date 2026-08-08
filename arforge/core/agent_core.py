"""Arforge agent core — local model capability enhancement agent.

Wires the DeepSeek adapter, memory, and tool execution into a unified agent
that can reason, remember, and act on user requests.

The agent supports structured multi-stage reasoning (UNDERSTAND → THINK →
GATHER → VERIFY → ANSWER) via the arforge.reasoning pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from arforge.core.agent_response import AgentResponse
from arforge.core.agent_trace import AgentTrace
from arforge.project_rules import ProjectRulesError
from arforge.prompt import SYSTEM_PROMPT, VOLATILE_CONTEXT_MARKER, build_user_prompt
from arforge.reasoning import (
    ReasoningPipeline,
    ReasoningResult,
    parse_reasoning,
    build_reasoning_system_prompt,
)

VISIBLE_ANSWER_POLICY = """

## Multi-Agent Parallelism

You have access to subagent tools that can work in parallel:
- `spawn_subagent` — delegate read-only exploration tasks (e.g., read SPEC.md, examine existing code)
- `spawn_write_subagent` — delegate write tasks (e.g., write a group of related files)

**When to use subagents:**
- Large tasks with many files: spawn multiple write subagents in parallel for different file groups
- Need to read many files before writing: spawn read subagents to explore, then write based on their summaries
- Project scaffolding: spawn subagents for each layer (entities, mappers, services, controllers) simultaneously

**Strategy for project building:**
1. First, read the spec/docs (yourself or spawn read subagent)
2. Then spawn 2-4 write subagents in parallel for different layers
3. Finally verify the results

Prefer parallelism — it saves time and tokens.

## User-visible response policy
- Do not expose internal reasoning, scratchpad notes, or XML reasoning tags in the final response.
- Reply with the direct user-facing answer only, unless the user explicitly asks for a structured diagnostic report.
- Keep simple social/chat requests concise.
"""


class RouteType(Enum):
    MEMORY_WRITE = "memory_write"
    TOOL_RESULT = "tool_result"
    AGENT_LOOP_CODE = "code_analysis"
    AGENT_LOOP_GENERAL = "general_code"
    CODING_TASK = "coding_task"
    COMPLEX_PLAN = "complex_plan"
    NORMAL_CHAT = "normal_chat"
    ORCHESTRATE = "orchestrate"
    WORKFLOW = "workflow"


@dataclass
class RouteDecision:
    route_type: RouteType
    result: str = None
    extra: dict = None


def is_code_analysis_task(user_input: str) -> bool:
    text = user_input.lower()
    return any(word in text for word in ["review", "analyze", "explain", "bug", "代码", "审查", "分析"])


def is_general_coding_task(user_input: str) -> bool:
    text = user_input.lower()
    return any(word in text for word in ["code", "fix", "implement", "test", "修改", "实现", "修复"])


def is_complex_task(user_input: str) -> bool:
    return len(user_input) > 300 or any(word in user_input.lower() for word in ["plan", "architecture", "架构", "规划"])


def _contains_reasoning_tag(value: str) -> bool:
    lowered = value.lower()
    return any(
        marker in lowered
        for marker in (
            "<understanding",
            "</understanding",
            "<thinking",
            "</thinking",
            "<evidence",
            "</evidence",
            "<reflection",
            "</reflection",
            "<answer",
            "</answer",
        )
    )


def analyze_intent(user_input: str):
    if is_code_analysis_task(user_input):
        return RouteDecision(RouteType.AGENT_LOOP_CODE)
    if is_general_coding_task(user_input):
        return RouteDecision(RouteType.AGENT_LOOP_GENERAL)
    if is_complex_task(user_input):
        return RouteDecision(RouteType.COMPLEX_PLAN)
    return RouteDecision(RouteType.NORMAL_CHAT)


def analyze_coding_task(user_input: str):
    return {"is_coding": is_general_coding_task(user_input) or is_code_analysis_task(user_input), "input": user_input}


def load_memories(limit: int = 20) -> list[str]:
    from arforge.memory import load_memories as loader

    return loader(limit)


def save_memory(content: str):
    from arforge.memory import save_memory as saver

    return saver(content)


def save_memory_v2(content: str, mem_type: str = "knowledge", tags: str = "", importance: int = 1, source: str = "user", related_to: str = "", dedupe: bool = True, project_id: str = "", workspace_path: str = ""):
    from arforge.memory import save_memory_v2 as saver

    return saver(
        content,
        mem_type=mem_type,
        tags=tags,
        importance=importance,
        source=source,
        related_to=related_to,
        dedupe=dedupe,
        project_id=project_id,
        workspace_path=workspace_path,
    )


def query_memories(query_text: str = "", mem_type: str = "", tag_filter: str = "", importance_min: int = 0, limit: int = 20, source_filter: str = "", project_id: str = "", workspace_path: str = "") -> list[dict]:
    from arforge.memory import query_memories as query

    return query(
        query_text=query_text,
        mem_type=mem_type,
        tag_filter=tag_filter,
        source_filter=source_filter,
        project_id=project_id,
        workspace_path=workspace_path,
        importance_min=importance_min,
        limit=limit,
    )


def search_memories(keywords: str, limit: int = 10) -> list[dict]:
    from arforge.memory import search_memories as search

    return search(keywords, limit)


def semantic_search_memories(query: str, top_k: int = 10, min_score: float = 0.05) -> list[dict]:
    from arforge.semantic_memory import semantic_search_memories as search

    return search(query, top_k, min_score)


def token_budget_bar(used: int, total: int, width: int = 30, color: bool = True) -> str:
    if total <= 0:
        return "[" + "-" * width + "] 0%"
    ratio = max(0.0, min(1.0, used / total))
    filled = int(width * ratio)
    return "[" + "#" * filled + "-" * (width - filled) + f"] {ratio:.0%}"


class ArforgeAgent:
    def __init__(self, reasoning_enabled: bool = True, multiagent_enabled: bool = True, reasoning_effort: str = "medium"):
        from arforge.reasoning.effort import normalize_reasoning_effort

        self.conversation_history: list[dict] = []
        self.memory_text = ""
        self._adapter = None
        self._adapter_identity = None
        self.reasoning_enabled = reasoning_enabled
        self.reasoning_effort = normalize_reasoning_effort(reasoning_effort)
        self.last_reasoning: ReasoningResult | None = None
        self.multiagent_enabled = multiagent_enabled
        self._master = None
        self._memory_tokens = 0
        self._last_memory_recall_report = None
        self._last_usage: dict = {}
        self._last_context_messages: list[dict] = []
        self._last_usage_message_tokens = 0
        self._compaction_count = 0
        self._last_compaction: dict = {}
        self._cumulative_prompt_tokens = 0
        self._cumulative_completion_tokens = 0
        self._provider_call_count = 0
        self._compacted_tokens_total = 0
        self._checkpoint_restored = False
        self._compaction_history_complete = True
        self._context_checkpoint_active = False
        self._last_context_package = None
        self._context_package_recovery_state = "none"
        self._restored_context_package_status: dict = {}

    @property
    def adapter(self):
        from arforge.product.model_config_runtime import get_model_config

        runtime = get_model_config()
        identity_getter = getattr(runtime, "adapter_identity", None)
        current_identity = identity_getter() if callable(identity_getter) else None
        if self._adapter is None or (
            self._adapter_identity is not None
            and current_identity is not None
            and current_identity != self._adapter_identity
        ):
            self._adapter = runtime.create_active_adapter()
            self._adapter_identity = current_identity
        return self._adapter

    @property
    def master(self):
        """Lazy-construct the MasterAgent for multi-agent orchestration."""
        if self._master is None and self.multiagent_enabled:
            from arforge.multiagent.master_agent import MasterAgent

            self._master = MasterAgent(self)
        return self._master

    @property
    def _reasoning_pipeline(self) -> ReasoningPipeline:
        """Lazy-construct the reasoning pipeline (needs adapter)."""
        return ReasoningPipeline(self.adapter)

    def refresh_memory_text(self, query: str = ""):
        """Recall bounded, workspace-scoped long-term memory for one turn."""
        from pathlib import Path

        from arforge.auto_memory import workspace_memory_scope
        from arforge.core.context import estimate_text_tokens
        from arforge.memory import query_memories_for_scope
        from arforge.semantic_memory import semantic_search_memories
        from arforge.workspace_context import current_workspace

        project_id, workspace_path = workspace_memory_scope(current_workspace(Path.cwd()))
        ranked: list[dict] = []
        report: dict | None = None
        if query:
            report = semantic_search_memories(
                query,
                top_k=8,
                min_score=0.05,
                project_id=project_id,
                workspace_path=workspace_path,
                limit=500,
            )
            ranked.extend(report.get("items", []) if isinstance(report, dict) else report)
        ranked.extend(query_memories_for_scope(
            project_id=project_id,
            workspace_path=workspace_path,
            limit=30,
        ))
        selected: list[dict] = []
        seen: set[str] = set()
        used = 0
        budget = 4_096
        for item in ranked:
            content = str(item.get("content", "") if isinstance(item, dict) else item).strip()
            key = content.casefold()
            if not content or key in seen:
                continue
            cost = estimate_text_tokens(content) + 8
            if selected and used + cost > budget:
                continue
            selected.append({
                "content": content,
                "mem_type": str(item.get("mem_type", "knowledge") if isinstance(item, dict) else "knowledge"),
                "importance": int(item.get("importance", 1) if isinstance(item, dict) else 1),
            })
            seen.add(key)
            used += cost
            if len(selected) >= 12 or used >= budget:
                break
        self._memory_tokens = used
        from arforge.core.memory_context import render_untrusted_memories

        self.memory_text = render_untrusted_memories(selected)
        self._last_memory_recall_report = (
            {**report, "items": selected}
            if isinstance(report, dict) and report.get("retrieval_uid")
            else None
        )
        return self.memory_text

    def prepare_context_messages(self, messages: list[dict]) -> list[dict]:
        """Compact when required, then compile a verified provider package."""
        from arforge.core.compaction import compact, needs_compaction
        from arforge.core.context import resolve_context_budget, resolve_context_window
        from arforge.core.context_os import (
            ContextCompiler,
            unit_from_memory_recall,
            units_from_messages,
        )

        adapter = self.adapter
        model = getattr(adapter, "model_name", "")
        configured = getattr(adapter, "context_window_tokens", None)
        prepared = [dict(message) for message in messages]
        memory_unit = None
        if self.memory_text and isinstance(self._last_memory_recall_report, dict):
            embedded = f"## Relevant Memory\n{self.memory_text}"
            for message in prepared:
                if message.get("role") == "system" and embedded in str(
                    message.get("content", "")
                ):
                    message["content"] = str(message.get("content", "")).replace(
                        embedded, ""
                    )
                    break
            memory_unit = unit_from_memory_recall(self._last_memory_recall_report)
        if needs_compaction(prepared, model, configured):
            compacted, stats = compact(prepared, adapter, model, persist_durable=True)
            if stats.get("compacted"):
                prepared = compacted
                self._compaction_count += 1
                self._last_compaction = dict(stats)
                self._compacted_tokens_total += max(
                    0,
                    int(stats.get("before_tokens", 0) or 0)
                    - int(stats.get("after_tokens", 0) or 0),
                )
                self._context_checkpoint_active = True
                # Keep the checkpoint in short-term memory so the next turn does
                # not re-expand the raw history and summarize it again.
                without_system = [item for item in compacted if item.get("role") != "system"]
                if without_system and without_system[-1].get("role") == "user":
                    without_system = without_system[:-1]
                self.conversation_history = without_system
        window = resolve_context_window(model, configured)
        budget = resolve_context_budget(window.tokens)
        previous_package = self._last_context_package
        previous_recovery_state = self._context_package_recovery_state
        units = list(units_from_messages(prepared, source_id="agent-live"))
        if memory_unit is not None:
            insert_at = next(
                (
                    index
                    for index, unit in enumerate(units)
                    if unit.layer == "current_request"
                ),
                len(units),
            )
            units.insert(insert_at, memory_unit)
        package = ContextCompiler().compile(
            units,
            model=model,
            usable_input_tokens=budget["usable_input_tokens"],
        )
        self._last_context_package = package
        if previous_package is not None and (
            previous_package.model != package.model
            or previous_package.usable_input_tokens != package.usable_input_tokens
        ):
            self._context_package_recovery_state = "recompiled_model_switch"
        elif previous_recovery_state == "rebuild_pending_stale":
            self._context_package_recovery_state = "rebuilt_stale_checkpoint"
        elif self._checkpoint_restored:
            self._context_package_recovery_state = "recompiled_checkpoint"
        else:
            self._context_package_recovery_state = "compiled"
        self._restored_context_package_status = {}
        prepared = package.messages
        self._last_context_messages = [dict(item) for item in prepared]
        return prepared

    def record_context_usage(self, usage, *, update_current: bool = True) -> None:
        from arforge.core.context import estimate_messages_tokens, normalize_usage

        normalized = normalize_usage(usage)
        if update_current:
            self._last_usage = normalized
            self._last_usage_message_tokens = estimate_messages_tokens(
                self._last_context_messages
            )
        if normalized["prompt_tokens"] or normalized["completion_tokens"]:
            self._cumulative_prompt_tokens += normalized["prompt_tokens"]
            self._cumulative_completion_tokens += normalized["completion_tokens"]
            self._provider_call_count += 1

    def context_status(self) -> dict:
        from arforge.core.context import build_context_status
        from arforge.product.model_config_runtime import get_model_config

        resolved = get_model_config().get_resolved_config()
        model = str(resolved.get("model", ""))
        messages = self._last_context_messages or list(self.conversation_history)
        from arforge.core.context_os import context_messages_digest

        status = build_context_status(
            messages,
            model,
            configured_tokens=resolved.get("context_window_tokens"),
            usage=self._last_usage,
            usage_message_tokens=self._last_usage_message_tokens,
            memory_tokens=self._memory_tokens,
            compaction_count=self._compaction_count,
            last_compaction=self._last_compaction,
            cumulative_prompt_tokens=self._cumulative_prompt_tokens,
            cumulative_completion_tokens=self._cumulative_completion_tokens,
            provider_call_count=self._provider_call_count,
            compacted_tokens_total=self._compacted_tokens_total,
            checkpoint_restored=self._checkpoint_restored,
            compaction_history_complete=self._compaction_history_complete,
            context_package=(
                self._last_context_package.to_dict()
                if self._last_context_package is not None
                else None
            ),
            context_package_messages_digest=(
                context_messages_digest(self._last_context_package.messages)
                if self._last_context_package is not None
                else ""
            ),
            context_package_recovery_state=self._context_package_recovery_state,
        )
        if self._last_context_package is None and self._restored_context_package_status:
            status.update(self._restored_context_package_status)
            status["context_package_recovery_state"] = self._context_package_recovery_state
        return status

    def _classify_task(self, user_input: str) -> str:
        """Lightweight keyword classification for reasoning prompt selection."""
        from arforge.planning.reasoning import classify_task
        return classify_task(user_input)

    def _should_use_structured_reasoning(
        self,
        user_input: str,
        reasoning_effort: str | None = None,
    ) -> bool:
        """Decide whether to inject the XML reasoning instructions.

        * ``low`` — always structured with a light prompt.
        * ``medium`` — keyword-based heuristic; simple greetings skip reasoning.
        * ``high`` / ``ultra`` — always structured at progressively deeper levels.
        """
        from arforge.reasoning.effort import normalize_reasoning_effort

        if not self.reasoning_enabled:
            return False
        effort = normalize_reasoning_effort(reasoning_effort or self.reasoning_effort)
        if effort in {"low", "high", "ultra"}:
            return True
        text = user_input.strip()
        if not text:
            return False
        if is_code_analysis_task(text) or is_general_coding_task(text) or is_complex_task(text):
            return True
        lowered = text.lower()
        return any(
            word in lowered
            for word in [
                "why", "compare", "evaluate", "debug", "diagnose", "root cause",
                "为什么", "对比", "评估", "诊断", "根因", "方案", "风险",
            ]
        )

    def build_messages(self, user_content: str, use_reasoning: bool = False) -> list[dict]:
        """Public entry point: build messages array for model call.

        When use_reasoning is True, the system prompt includes structured
        reasoning instructions whose depth is controlled by ``self.reasoning_effort``.
        """
        return self._build_messages(
            user_content,
            reasoning_effort=self.reasoning_effort if use_reasoning else "low",
            force_reasoning=use_reasoning,
        )

    def _build_messages(
        self,
        user_content: str,
        reasoning_effort: str = "medium",
        force_reasoning: bool | None = None,
    ) -> list[dict]:
        """Build messages array for model call.

        ``reasoning_effort`` controls which prompt tier the system message uses:
        ``low`` (minimal), ``medium`` (balanced), ``high`` (deep), or
        ``ultra`` (exhaustive multi-pass).
        When reasoning is disabled the base prompt is used directly.
        """
        # Project rules are the first workspace input read for every turn.
        # Development work fails closed if ARFORGE.md is absent or unreadable.
        from arforge.project_rules import (
            build_project_rules_system_prompt,
            is_project_workspace,
        )
        from arforge.skill_runtime import is_development_request

        project_rules_prompt = build_project_rules_system_prompt(
            required=is_project_workspace() or is_development_request(user_content)
        )
        self.refresh_memory_text(user_content)

        use_reasoning = (
            self._should_use_structured_reasoning(user_content, reasoning_effort)
            if force_reasoning is None
            else bool(force_reasoning)
        )
        if use_reasoning and self.reasoning_enabled:
            system = build_reasoning_system_prompt(
                user_input=user_content,
                base_system_prompt=SYSTEM_PROMPT,
                effort=reasoning_effort,
                memory_context="",
            )
        else:
            system = SYSTEM_PROMPT + VISIBLE_ANSWER_POLICY
        volatile_sections: list[str] = []
        if project_rules_prompt:
            volatile_sections.append(project_rules_prompt)
        if self.memory_text:
            volatile_sections.append(f"## Relevant Memory\n{self.memory_text}")

        # Development skills are routed deterministically and injected before
        # response styling so desktop and CLI share the same execution method.
        # Skill discovery is optional: a malformed local skill must never make
        # the base chat path unavailable.
        try:
            from arforge.skill_runtime import build_skill_system_prompt

            skill_prompt = build_skill_system_prompt(user_content)
            if skill_prompt:
                volatile_sections.append(skill_prompt)
        except Exception:
            pass

        # Response styles are user-authored, data-only prompt fragments.  They
        # are appended after the product safety and tool-use rules, so a style
        # can shape presentation without weakening the execution contract.
        try:
            from arforge.output_styles import get_active_output_style_prompt

            style_prompt = get_active_output_style_prompt()
            if style_prompt:
                volatile_sections.append(f"## Response Style\n{style_prompt}")
        except Exception:
            # Style discovery is optional and must never make a chat unavailable.
            pass
        if volatile_sections:
            system += VOLATILE_CONTEXT_MARKER + "\n\n".join(volatile_sections)

        messages = [{"role": "system", "content": system}]
        messages.extend(self.conversation_history)
        messages.append({"role": "user", "content": build_user_prompt(user_content)})
        return messages

    def call_model(self, user_content: str, max_tokens: int = None, temperature: float = None, use_reasoning: bool = False) -> str:
        """Call the underlying model. When use_reasoning is True, structured
        reasoning instructions are injected into the system prompt."""
        # Security: check for prompt injection
        from arforge.security_guard import INJECTION_WARNING, detect_injection, log_structured_error

        injection = detect_injection(user_content)
        if not injection["clean"]:
            log_structured_error("prompt_injection", f"injection detected: {injection['count']} patterns, severity={injection['severity']}", recoverable=True, context={"input_preview": user_content[:200]})
            if injection["severity"] == "high":
                return INJECTION_WARNING

        try:
            messages = self._build_messages(
                user_content,
                reasoning_effort=self.reasoning_effort if use_reasoning else "low",
                force_reasoning=use_reasoning,
            )
            messages = self.prepare_context_messages(messages)
            return self.adapter.generate(messages, max_tokens=max_tokens, temperature=temperature)
        except ProjectRulesError as exc:
            log_structured_error(
                "project_rules",
                str(exc),
                recoverable=True,
            )
            return f"[Arforge] Project development blocked: {exc}"
        except Exception as exc:
            error_info = __import__("arforge.security_guard", fromlist=["classify_exception"]).classify_exception(exc)
            log_structured_error(error_info["category"], error_info["message"], recoverable=error_info["recoverable"])
            return f"[Arforge] Model call failed: {error_info['message']}\n\nCheck your API key via `arforge doctor`."

    def call_model_with_reasoning(self, user_content: str, max_tokens: int = None, temperature: float = None) -> ReasoningResult:
        """Call the model with structured reasoning and return the parsed result.

        This is the primary reasoning-aware entry point. It returns a
        ReasoningResult with understanding, thinking, evidence, reflection,
        and answer fields.
        """
        raw = self.call_model(user_content, max_tokens=max_tokens, temperature=temperature, use_reasoning=True)
        self.last_reasoning = parse_reasoning(raw)
        return self.last_reasoning

    def build_response(self, answer: str, trace: AgentTrace, response_type: str) -> AgentResponse:
        trace.finish()
        return AgentResponse(answer, trace.to_list(), trace.duration(), True, {"type": response_type})

    def chat(self, user_input: str) -> AgentResponse:
        """Handle a user chat turn with structured reasoning enabled by default.

        The model is instructed to reason through the problem before answering.
        Reasoning trace is stored in self.last_reasoning for inspection.
        """
        trace = AgentTrace()
        trace.add("received user input")

        # Reject high-confidence prompt-injection attempts before memory,
        # learning, or model adapters can observe the untrusted content.
        from arforge.security_guard import INJECTION_WARNING, detect_injection, log_structured_error

        injection = detect_injection(user_input)
        if not injection["clean"] and injection["severity"] == "high":
            log_structured_error(
                "prompt_injection",
                f"injection detected: {injection['count']} patterns, severity=high",
                recoverable=True,
                context={"input_preview": user_input[:200]},
            )
            trace.add("blocked high-confidence prompt injection")
            return self.build_response(INJECTION_WARNING, trace, "security_block")

        # Inject learnings from past sessions
        try:
            from arforge.learning_system import get_learning_system

            ls = get_learning_system()
            learning_ctx = ls.build_injection_context(user_input)
            if learning_ctx:
                trace.add("injected learning context")
        except Exception:
            learning_ctx = ""

        # Build messages with reasoning instructions only when the task benefits from
        # structured diagnostics; simple chat stays answer-only to reduce tokens.
        messages = self.prepare_context_messages(self._build_messages(user_input, reasoning_effort=self.reasoning_effort))
        use_structured_reasoning = self._should_use_structured_reasoning(user_input)
        if learning_ctx:
            messages[0]["content"] += f"\n\n{learning_ctx}"

        try:
            raw_response = self.adapter.generate(messages)
            success = True
            error_msg = ""

            # Parse reasoning from response
            if use_structured_reasoning:
                self.last_reasoning = parse_reasoning(raw_response)
                answer = self.last_reasoning.answer
                trace.add(f"reasoning: {self.last_reasoning.reasoning_summary}")
            else:
                self.last_reasoning = None
                answer = parse_reasoning(raw_response).answer
        except Exception as exc:
            answer = f"[Arforge] Model call failed: {exc}"
            success = False
            error_msg = str(exc)

        self.conversation_history.append({"role": "user", "content": user_input})
        self.conversation_history.append({"role": "assistant", "content": answer})

        # Auto-record outcome for continuous learning
        try:
            from arforge.learning_system import get_learning_system

            ls = get_learning_system()
            ls.record_turn(
                user_input=user_input,
                answer=answer,
                success=success,
                intent="chat",
                route="chat",
                error=error_msg,
                injected_context_size=len(learning_ctx) if learning_ctx else 0,
            )
        except Exception:
            pass  # Learning recording failure must not break the agent

        return self.build_response(answer, trace, "chat")

    def chat_multiagent(
        self,
        user_input: str,
        progress_callback=None,
        reasoning_effort: str | None = None,
    ) -> dict:
        """Handle a user request via the multi-agent orchestration pipeline.

        Falls back to single-agent chat() when multi-agent is disabled or
        the MasterAgent is unavailable.

        Returns a dict with keys: answer, mode, conversation_id, agents_used.
        """
        from arforge.security_guard import INJECTION_WARNING, detect_injection

        injection = detect_injection(user_input)
        if not injection["clean"] and injection["severity"] == "high":
            return {
                "answer": INJECTION_WARNING,
                "mode": "security_block",
                "conversation_id": "",
                "agents_used": 0,
            }
        from arforge.reasoning.effort import normalize_reasoning_effort

        self.reasoning_effort = normalize_reasoning_effort(
            reasoning_effort or self.reasoning_effort
        )
        if not self.multiagent_enabled or self.master is None:
            response = self.chat(user_input)
            return {
                "answer": response.answer,
                "mode": "single",
                "conversation_id": "",
                "agents_used": 0,
            }
        if progress_callback is None:
            return self.master.handle(user_input)
        return self.master.handle(user_input, progress_callback=progress_callback)

    def cancel_multiagent(self, reason: str = "cancelled by user") -> int:
        """Cancel active multi-agent work and return the number of runs signalled."""
        master = self._master
        if master is None:
            return 0
        cancel = getattr(master, "cancel_active", None)
        return int(cancel(reason) if callable(cancel) else 0)

    def should_use_multiagent(self, user_input: str) -> bool:
        """Deterministically decide whether the CLI should enter orchestration."""
        if not self.multiagent_enabled:
            return False
        from arforge.multiagent.master_agent import MasterAgent

        understanding = MasterAgent._understand_heuristic(user_input)
        return MasterAgent._needs_multiagent(understanding)

    def list_agents(self) -> list[dict]:
        """Return metadata for all registered SubAgent roles."""
        try:
            from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

            pool = get_sub_agent_pool()
            return [r.to_dict() for r in pool.list_roles()]
        except Exception:
            return []

    def chat_stream(self, user_input: str, reasoning_effort: str | None = None):
        """Stream chat with reasoning support.

        ``reasoning_effort`` overrides the instance-level default when given.
        The effort tier controls the depth of the system prompt and how many
        reasoning XML tags the model is instructed to produce.
        """
        from arforge.reasoning.effort import normalize_reasoning_effort

        eff = normalize_reasoning_effort(reasoning_effort or self.reasoning_effort)
        self.reasoning_effort = eff
        trace = AgentTrace()
        trace.add("analysing input")
        from arforge.security_guard import INJECTION_WARNING, detect_injection, sanitize_log_message

        injection = detect_injection(user_input)
        if not injection["clean"] and injection["severity"] == "high":
            trace.add("blocked high-confidence prompt injection")
            yield {"type": "reasoning_started", "data": {}}
            yield {"type": "reasoning_completed", "data": {"reasoning": {}}}
            yield {"type": "answer_delta", "data": {"content": INJECTION_WARNING}}
            yield {
                "type": "done",
                "data": {
                    "answer": INJECTION_WARNING,
                    "trace": trace.to_list(),
                    "thinking_time": trace.duration(),
                    "collapsed": True,
                    "reasoning": {},
                    "tool_events": [],
                    "artifacts": [],
                    "meta": {"mode": "security_block"},
                },
            }
            return

        try:
            messages = self.prepare_context_messages(self._build_messages(user_input, reasoning_effort=eff))
            use_structured_reasoning = self._should_use_structured_reasoning(user_input, eff)
            full_response = ""
            native_reasoning = ""
            answer = ""
            usage = None
            # Record the boundary of every content chunk so the clean answer can
            # be replayed as multiple ``answer_delta`` events when the model did
            # NOT emit reasoning XML tags. Tagged responses must be parsed whole
            # before the clean answer is safe to emit, so they stay single-shot
            # (the reasoning/answer separation invariant is non-negotiable).
            content_chunks: list[str] = []
            for chunk in self.adapter.stream_generate(messages):
                kind = getattr(chunk, "kind", "content")
                if kind == "reasoning":
                    native_reasoning += getattr(chunk, "reasoning_content", "") or chunk.text
                    continue
                if kind == "usage":
                    usage = getattr(chunk, "usage", None)
                    self.record_context_usage(usage)
                    continue
                text = chunk.text
                if text:
                    full_response += text
                    content_chunks.append(text)

            # Parse reasoning from the full response
            has_reasoning_tags = _contains_reasoning_tag(full_response)
            if use_structured_reasoning:
                self.last_reasoning = parse_reasoning(full_response)
                answer = self.last_reasoning.answer
            else:
                parsed = parse_reasoning(full_response)
                if has_reasoning_tags:
                    self.last_reasoning = parsed
                    answer = parsed.answer
                else:
                    self.last_reasoning = None
                    answer = full_response
            # Native provider reasoning (deepseek-reasoner style) fills the
            # thinking channel even when the prompt did not request XML tags, so
            # the reasoning panel is populated for every turn that produced one.
            if native_reasoning and self.last_reasoning is None:
                self.last_reasoning = ReasoningResult(
                    thinking=native_reasoning.strip(),
                    answer=answer,
                    raw_response=full_response,
                    parse_success=True,
                    reasoning_mode="native",
                )
            # Emit reasoning channel: stream each non-empty section as a tagged
            # delta, then always emit reasoning_completed so clients can settle.
            yield {"type": "reasoning_started", "data": {}}
            if self.last_reasoning is not None:
                for section in ("understanding", "thinking", "evidence", "reflection"):
                    value = getattr(self.last_reasoning, section, "") or ""
                    if value.strip():
                        yield {"type": "reasoning_delta", "data": {"section": section, "content": value}}
            reasoning_payload = self.last_reasoning.to_dict() if self.last_reasoning else {}
            reasoning_view = {
                "understanding": reasoning_payload.get("understanding", ""),
                "thinking": reasoning_payload.get("thinking", ""),
                "evidence": reasoning_payload.get("evidence", ""),
                "reflection": reasoning_payload.get("reflection", ""),
            }
            yield {"type": "reasoning_completed", "data": {"reasoning": reasoning_view}}
            # Only now does the clean answer reach the answer channel. Tagged
            # responses were parsed into a clean answer (XML tags stripped), so a
            # single delta preserves the separation invariant. Untagged responses
            # are plain prose — replay the original chunks as multiple deltas so
            # the client renders a true token-by-token stream.
            if answer:
                if has_reasoning_tags or use_structured_reasoning:
                    yield {"type": "answer_delta", "data": {"content": answer}}
                else:
                    for piece in content_chunks:
                        if piece:
                            yield {"type": "answer_delta", "data": {"content": piece}}
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": answer})
        except Exception as exc:
            project_rules_error = isinstance(exc, ProjectRulesError)
            yield {
                "type": "error",
                "data": {
                    "code": "PROJECT_RULES_REQUIRED" if project_rules_error else "MODEL_ERROR",
                    "message": sanitize_log_message(str(exc)) or "model stream failed",
                },
            }
            return
        yield {
            "type": "done",
            "data": {
                "answer": answer,
                "trace": trace.to_list(),
                "thinking_time": trace.duration(),
                "collapsed": True,
                "meta": {"mode": "single", "reasoning_mode": self.last_reasoning.reasoning_mode if self.last_reasoning else "none", "usage": usage},
                "reasoning": reasoning_view,
                "tool_events": [],
                "artifacts": [],
                "usage": usage,
            },
        }

    def quick_plan(self, task: str) -> str:
        """Generate a plan with reasoning-aware prompting."""
        messages = self._build_messages(
            f"Plan this task: {task}",
            reasoning_effort="high" if self.reasoning_enabled else "low",
            force_reasoning=self.reasoning_enabled,
        )
        try:
            raw = self.adapter.generate(messages, max_tokens=1024, temperature=0.3)
            if self.reasoning_enabled:
                self.last_reasoning = parse_reasoning(raw)
                return self.last_reasoning.answer
            return raw
        except Exception as exc:
            return f"Plan failed: {exc}"

    def enter_plan_mode(self, task: str) -> dict:
        return {"success": True, "task": task, "plan": self.quick_plan(task)}

    def build_coding_stream_messages(self, user_input: str, trace_steps: list, start_time: float):
        return self._build_messages(user_input)

    def safe_modify_file(
        self,
        file_path: str,
        new_content: str,
        reason: str = "agent_modify",
        description: str = "",
        verify: bool = True,
        auto_rollback: bool = True,
    ) -> dict:
        from arforge.security.safe_modifier import safe_modify_file

        result = safe_modify_file(Path(file_path), new_content, reason=reason, description=description, verify=verify, auto_rollback=auto_rollback)
        return result.__dict__

    def safe_modify_multi(self, changes: list, reason: str = "agent_batch_modify", verify: bool = True, auto_rollback: bool = True) -> list:
        from arforge.security.safe_modifier import safe_modify_multi

        results = safe_modify_multi(changes, reason=reason, verify=verify, auto_rollback=auto_rollback)
        return [item.__dict__ for item in results]
