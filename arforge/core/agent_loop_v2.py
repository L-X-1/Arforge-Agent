"""Agent loop v2 — full verify-and-retry execution loop with structured reasoning.

Pipeline:
  user_input -> intent analysis -> tool selection -> execute -> verify ->
  (retry on failure × max_retries) -> model synthesis -> final answer

Every tool execution is verified against built-in rules.  Failures trigger
exponential-backoff retry.  The reasoning layer produces structured XML-tagged
output that is parsed into understanding, thinking, evidence, reflection, and
answer blocks.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from arforge.core.agent_core import ArforgeAgent, _contains_reasoning_tag
from arforge.core.agent_event import (
    answer_delta,
    done,
    error,
    reasoning_delta,
    tool_call_done,
    tool_call_start,
)
from arforge.intent_analyzer import analyze_intent
from arforge.reasoning import parse_reasoning, ReasoningResult
from arforge.tool_registry import REGISTRY, ToolMatch, ToolResult


# ---------------------------------------------------------------------------
# ISO 8601 regex for time-tool verification
# ---------------------------------------------------------------------------

_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")


# ---------------------------------------------------------------------------
# Result value objects
# ---------------------------------------------------------------------------


@dataclass
class LoopResult:
    answer: str
    intent: str = "general"
    tool_calls: list[dict] = field(default_factory=list)
    enhanced: bool = False
    trace: list[dict] = field(default_factory=list)
    thinking_time: float = 0.0
    reasoning: ReasoningResult | None = None
    reasoning_summary: str = ""
    verifications: list[dict] = field(default_factory=list)
    retry_count: int = 0
    observability: dict | None = None
    self_correct: dict | None = None
    messages: list = field(default_factory=list)  # G6:本 run 完整对话,供落盘/resume


# ---------------------------------------------------------------------------
# Tool prompt builder (tools listed in system prompt only — no duplication)
# ---------------------------------------------------------------------------


def _build_tool_prompt(user_input: str) -> str:
    """Build the user-facing prompt.  Tool descriptions live in the system
    prompt so they are NOT duplicated here."""
    return f"User request: {user_input}"


def _offline_tool_answer(user_input: str, tool_result: ToolResult) -> str:
    """Return a deterministic answer when model streaming is unavailable."""
    output = (tool_result.output or "").strip()
    if not output:
        output = "The tool completed successfully but did not return text output."
    return f"Tool `{tool_result.tool_name}` completed for: {user_input}\n\n{output}"


# ---------------------------------------------------------------------------
# AgentLoopV2
# ---------------------------------------------------------------------------


class AgentLoopV2:
    """Agent loop that detects tool needs, executes tools with verification,
    retries on failure, and synthesizes answers via structured reasoning."""

    def __init__(self, agent: ArforgeAgent | None = None, max_retries: int = 3):
        self.agent = agent or ArforgeAgent()
        self.max_retries = max_retries

    # -- verification ---------------------------------------------------------

    def _verify_tool_result(self, tool_name: str, result: ToolResult) -> dict:
        """Verify a tool result against built-in rules.

        Returns a dict with at least {"passed": bool, "tool": str, "method": str}.
        """
        if not result.success:
            return {"passed": False, "tool": tool_name, "method": "execution_failed", "reason": f"tool error: {result.error}"}

        # calculator -> output must be parseable as float
        if tool_name == "calculator":
            try:
                float(result.output.strip())
                return {"passed": True, "tool": tool_name, "method": "float_parse"}
            except (ValueError, TypeError):
                return {"passed": False, "tool": tool_name, "method": "float_parse", "reason": "calculator output is not a valid number"}

        # time -> output must contain an ISO 8601 datetime
        if tool_name == "time":
            if _ISO_RE.search(result.output):
                return {"passed": True, "tool": tool_name, "method": "iso_regex"}
            return {"passed": False, "tool": tool_name, "method": "iso_regex", "reason": "time output missing ISO 8601 datetime"}

        # file_read / read_file -> output must be a non-empty string
        if tool_name in ("read_file", "file_read"):
            if result.output and len(result.output.strip()) > 0:
                return {"passed": True, "tool": tool_name, "method": "non_empty"}
            return {"passed": False, "tool": tool_name, "method": "non_empty", "reason": "file read returned empty content"}

        # run_cmd -> check for returncode in meta or output
        if tool_name == "run_cmd":
            if result.meta and "returncode" in result.meta:
                return {"passed": True, "tool": tool_name, "method": "returncode_check"}
            # Loose check: output contains known returncode patterns
            if "returncode" in (result.output or "").lower():
                return {"passed": True, "tool": tool_name, "method": "returncode_in_output"}
            return {"passed": True, "tool": tool_name, "method": "skipped", "note": "no structured returncode — assuming success"}

        # No rule -> skip verification (not a failure)
        return {"passed": True, "tool": tool_name, "method": "skipped", "note": "no verification rule for this tool"}

    # -- retry loop -----------------------------------------------------------

    def _run_with_retry(self, match: ToolMatch) -> tuple[ToolResult | None, list[dict]]:
        """Execute a tool with verify-then-retry logic.

        Returns (final_result, retry_log) where retry_log records every
        verification and retry attempt.
        """
        log: list[dict] = []
        last_result: ToolResult | None = None

        for attempt in range(1, self.max_retries + 1):
            # Execute
            result = REGISTRY.execute(match)
            last_result = result

            # Verify
            verif = self._verify_tool_result(match.tool_name, result)
            verif["attempt"] = attempt
            log.append({"step": "verify", **verif})

            if verif["passed"]:
                return result, log

            # Verification failed — retry with backoff
            if attempt < self.max_retries:
                delay = 0.1 * (2 ** (attempt - 1))  # 0.1, 0.2, 0.4 …
                log.append({"step": "retry", "attempt": attempt, "reason": verif.get("reason", "verification failed"), "delay": round(delay, 3)})
                time.sleep(delay)

        # Retries exhausted — return last result anyway
        log.append({"step": "retries_exhausted", "attempts": self.max_retries, "tool": match.tool_name})
        return last_result, log

    # -- main entry ----------------------------------------------------------

    def run(self, user_input: str) -> LoopResult:
        started = time.perf_counter()
        trace: list[dict] = []
        tool_calls: list[dict] = []
        verifications: list[dict] = []
        retry_count = 0

        # 1. Analyze intent
        intent = analyze_intent(user_input)
        trace.append({"step": "intent", "category": intent.category, "needs_tool": intent.needs_tool})

        # 2. Try tool match -> execute with verify+retry
        tool_result = None
        if intent.needs_tool:
            match = REGISTRY.match(user_input)
            if match is not None:
                tool_result, retry_log = self._run_with_retry(match)

                # Count retries and collect verifications
                for entry in retry_log:
                    if entry.get("step") == "retry":
                        retry_count += 1
                    elif entry.get("step") == "verify":
                        verifications.append(entry)

                trace.extend(retry_log)

                tool_calls.append(
                    {
                        "tool": tool_result.tool_name,
                        "success": tool_result.success,
                        "output": tool_result.output[:500],
                        "error": tool_result.error,
                        "retries": retry_count,
                    }
                )
                trace.append(
                    {
                        "step": "tool_executed",
                        "tool": tool_result.tool_name,
                        "success": tool_result.success,
                        "retries": retry_count,
                        "verified": any(v["passed"] for v in verifications if v.get("tool") == tool_result.tool_name),
                    }
                )

        # 3. Build final answer with structured reasoning
        if tool_result is not None and tool_result.success:
            prompt = (
                f"The user asked: '{user_input}'\n\n"
                f"A tool was executed and returned this result:\n{tool_result.output}\n\n"
                f"Please provide a helpful response to the user based on this result."
            )
        elif tool_result is not None and not tool_result.success:
            prompt = (
                f"The user asked: '{user_input}'\n\n"
                f"A tool was attempted but failed after {retry_count} retries: {tool_result.error}\n\n"
                f"Please explain the failure helpfully and suggest alternatives."
            )
        else:
            prompt = _build_tool_prompt(user_input)

        # Use reasoning pipeline for structured output
        reasoning_result = self.agent.call_model_with_reasoning(prompt)
        answer = reasoning_result.answer
        trace.append({"step": "model_synthesized", "reasoning": reasoning_result.reasoning_summary})

        thinking_time = round(time.perf_counter() - started, 3)
        return LoopResult(
            answer=answer,
            intent=intent.category,
            tool_calls=tool_calls,
            enhanced=tool_result is not None,
            trace=trace,
            thinking_time=thinking_time,
            reasoning=reasoning_result,
            reasoning_summary=reasoning_result.reasoning_summary,
            verifications=verifications,
            retry_count=retry_count,
        )

    # -- agentic entry point (for CLI code command) -----------------------

    def run_agentic(
        self,
        task: str | None = None,
        *,
        user_input: str | None = None,
        max_steps: int | None = None,
        mode: str = "acceptEdits",
        on_token=None,
        on_answer_reset=None,
        on_intermediate=None,
        on_reasoning=None,
        on_tool_start=None,
        on_tool_complete=None,
        on_checkpoint=None,
        on_delivery=None,
        on_subagent=None,
        should_stop=None,
        model_timeout_seconds: float | None = None,
        extra_system: str = "",
        resume_messages: list[dict] | None = None,
        reasoning_effort: str | None = None,
        **_kwargs,
    ):
        """Run the agent on a coding task with full tool-loop semantics."""
        from contextlib import nullcontext

        from arforge.core.agentic import run_tool_loop
        from arforge.core.subagent import run_subagent, subagent_adapter_scope
        from arforge.product.question_runtime import (
            has_question_handler,
            question_handler,
            terminal_question_handler,
        )
        from arforge.feature_flags import get_feature_flags
        from arforge.tool_registry import REGISTRY
        from arforge.tool_registry import deferred_tool_scope
        from arforge.user_message_runtime import delivery_scope

        del mode  # Permission mode is installed by the owning CLI/Bridge runtime.
        resolved_task = task if task is not None else user_input
        if resolved_task is None:
            raise ValueError("task or user_input is required")
        if reasoning_effort is not None:
            from arforge.reasoning.effort import normalize_reasoning_effort

            self.agent.reasoning_effort = normalize_reasoning_effort(
                reasoning_effort,
                strict=True,
            )
        # One canonical depth controls prompt instructions, automatic step
        # budget, and provider-native effort when the active API supports it.
        active_adapter = self.agent.adapter
        try:
            active_adapter.reasoning_effort = self.agent.reasoning_effort
        except AttributeError:
            pass
        deferred_loading = get_feature_flags().enabled("deferred_tool_loading")
        tools = REGISTRY.to_openai_tools if deferred_loading else REGISTRY.to_openai_tools()
        reasoning_selector = getattr(
            self.agent,
            "_should_use_structured_reasoning",
            None,
        )
        use_reasoning = (
            bool(reasoning_selector(resolved_task))
            if callable(reasoning_selector)
            else False
        )
        if resume_messages is not None:
            # Resume the transcript, but refresh the system contract from the
            # current runtime. Otherwise checkpoints permanently retain stale
            # safety, platform and execution rules after an upgrade.
            fresh = self.agent.build_messages(
                resolved_task,
                use_reasoning=use_reasoning,
            )
            fresh_system = next(
                (dict(item) for item in fresh if item.get("role") == "system"),
                None,
            )
            messages = [
                dict(item)
                for item in resume_messages
                if item.get("role") != "system"
            ]
            if fresh_system is not None:
                messages.insert(0, fresh_system)
        else:
            messages = self.agent.build_messages(
                resolved_task,
                use_reasoning=use_reasoning,
            )
        if extra_system:
            system_message = next(
                (item for item in messages if item.get("role") == "system"),
                None,
            )
            if system_message is None:
                messages.insert(0, {"role": "system", "content": extra_system})
            else:
                system_message["content"] = (
                    f"{system_message.get('content', '')}\n\n{extra_system}".strip()
                )
        interaction = (
            nullcontext()
            if has_question_handler()
            else question_handler(terminal_question_handler)
        )
        tool_scope = deferred_tool_scope(enabled=True) if deferred_loading else nullcontext()
        with (
            tool_scope,
            interaction,
            delivery_scope(on_delivery) as delivery_state,
            subagent_adapter_scope(self.agent.adapter),
        ):
            subagent_records: list[dict] = []
            effort = str(getattr(self.agent, "reasoning_effort", "medium") or "medium")
            required_roles = (
                ("explore",)
                if effort == "high"
                else (("researcher", "reviewer") if effort == "ultra" else ())
            )
            # High-depth runs deterministically delegate work instead of merely
            # suggesting that the model may call a subagent tool.  Resume/goal
            # cycles reuse the reports already embedded in the transcript.
            if (
                required_roles
                and resume_messages is None
                and bool(getattr(self.agent, "multiagent_enabled", False))
            ):
                for role in required_roles:
                    subagent_started = time.monotonic()
                    record = {"role": role, "status": "started"}
                    if on_subagent is not None:
                        on_subagent(dict(record))
                    try:
                        assignment = (
                            f"Work as the {role} sub-agent on this project goal. "
                            "Inspect the real workspace, produce concrete evidence, and complete "
                            "the role-appropriate work rather than giving generic advice.\n\n"
                            f"Project goal: {resolved_task}"
                        )
                        report = run_subagent(
                            assignment,
                            role=role,
                            max_steps=3 if role == "explore" else 4,
                            should_stop=should_stop,
                            model_timeout_seconds=model_timeout_seconds,
                        )
                        record.update({"status": "completed", "report": str(report)})
                    except Exception as exc:  # noqa: BLE001 - main agent still owns delivery
                        from arforge.security_guard import sanitize_log_message

                        record.update({
                            "status": "failed",
                            "error": sanitize_log_message(str(exc)),
                        })
                    record["elapsed_ms"] = int(
                        max(0.0, time.monotonic() - subagent_started) * 1000
                    )
                    subagent_records.append(record)
                    if on_subagent is not None:
                        on_subagent(dict(record))
                reports = "\n\n".join(
                    f"[{item['role']} sub-agent: {item['status']}]\n"
                    f"{item.get('report') or item.get('error') or '(no report)'}"
                    for item in subagent_records
                )
                messages.append({
                    "role": "assistant",
                    "content": (
                        "Required sub-agent work has completed. Treat these reports as project "
                        "evidence, inspect any resulting workspace changes, and finish the parent "
                        f"goal with verification.\n\n{reports}"
                    ),
                })

            def delivery_aware_token(piece: str) -> None:
                if on_token is not None and not delivery_state.deliveries:
                    on_token(piece)

            result = run_tool_loop(
                active_adapter,
                messages,
                tools=tools,
                max_steps=max_steps,
                task=resolved_task,
                on_token=delivery_aware_token if on_token is not None else None,
                on_answer_reset=on_answer_reset,
                on_intermediate=on_intermediate,
                on_reasoning=on_reasoning,
                on_tool_start=on_tool_start,
                on_tool_complete=on_tool_complete,
                on_checkpoint=on_checkpoint,
                should_stop=should_stop,
                model_timeout_seconds=model_timeout_seconds,
            )
            result.subagents = subagent_records
        if delivery_state.deliveries:
            result.deliveries = list(delivery_state.deliveries)
            result.answer = str(delivery_state.deliveries[-1]["message"])
            result.trace.append(
                {
                    "step": result.steps,
                    "event": "primary_message_delivered",
                    "status": delivery_state.deliveries[-1]["status"],
                    "attachments": delivery_state.deliveries[-1]["attachment_count"],
                }
            )
        result.messages = messages
        return result

    def run_goal(
        self,
        task: str,
        *,
        max_steps: int | None = None,
        resume_messages: list[dict] | None = None,
        should_stop=None,
        on_intermediate=None,
        **kwargs,
    ):
        """Keep advancing a persisted coding goal until its completion gate passes.

        ``max_steps`` is a per-cycle compaction/checkpoint boundary in this
        mode, not a reason to hand control back to the user.  Only an explicit
        cancellation/deadline or a non-continuable safety/provider failure ends
        an unfinished goal.
        """
        from arforge.core.agentic import (
            _academic_artifact_quality_issues,
            _answer_declares_incomplete,
        )

        cycles = 0
        current_resume = resume_messages
        all_tools: list[dict] = []
        all_trace: list[dict] = []
        all_verifications: list[dict] = []
        all_subagents: list[dict] = []
        total_steps = 0
        continuable = {
            "max_steps",
            "task_incomplete",
            "verification_missing",
            "browser_verification_missing",
            "evidence_missing",
            "academic_artifact_quality_failed",
        }

        while True:
            if should_stop is not None and should_stop():
                raise InterruptedError("goal run cancelled or timed out")
            cycles += 1
            result = self.run_agentic(
                task,
                max_steps=max_steps,
                resume_messages=current_resume,
                should_stop=should_stop,
                on_intermediate=on_intermediate,
                **kwargs,
            )
            total_steps += int(getattr(result, "steps", 0) or 0)
            all_tools.extend(getattr(result, "tool_calls", []) or [])
            all_trace.extend(getattr(result, "trace", []) or [])
            all_verifications.extend(getattr(result, "verifications", []) or [])
            all_subagents.extend(getattr(result, "subagents", []) or [])
            report = getattr(result, "incomplete_report", None)
            self_correct = getattr(result, "self_correct", None)
            stop_reason = (
                str(self_correct.get("stop_reason", "") or "")
                if isinstance(self_correct, dict)
                else ""
            )
            if (
                not isinstance(report, dict)
                and _answer_declares_incomplete(getattr(result, "answer", ""))
            ):
                # ``deliver_user_message`` is applied after the canonical tool
                # loop returns.  Re-check the delivered text here so a report
                # with explicit unverified/remaining work cannot bypass the
                # tool-loop completion gate and terminate a persisted goal.
                report = {
                    "task": task,
                    "stop_reason": "task_incomplete",
                    "answer_declared_incomplete": True,
                }
                result.incomplete_report = report
                self_correct = (
                    dict(self_correct) if isinstance(self_correct, dict) else {}
                )
                self_correct["stop_reason"] = "task_incomplete"
                result.self_correct = self_correct
                stop_reason = "task_incomplete"
                rejection_event = {
                    "step": getattr(result, "steps", 0),
                    "event": "goal_completion_claim_rejected",
                    "reason": "answer_declares_unfinished_work",
                }
                result.trace.append(rejection_event)
                # This cycle's trace was aggregated before the completion gate;
                # retain the rejection in the final multi-cycle result as well.
                all_trace.append(dict(rejection_event))
            if not isinstance(report, dict):
                academic_issues = _academic_artifact_quality_issues(task, all_tools)
                if academic_issues:
                    # The canonical tool loop performs the same gate before a
                    # normal final answer.  Goal mode must repeat it here
                    # because deliver_user_message and max-step finalization
                    # are applied outside that branch and previously allowed
                    # malformed academic artifacts to be reported as complete.
                    report = {
                        "task": task,
                        "stop_reason": "academic_artifact_quality_failed",
                        "issues": academic_issues,
                    }
                    result.incomplete_report = report
                    self_correct = (
                        dict(self_correct) if isinstance(self_correct, dict) else {}
                    )
                    self_correct["stop_reason"] = "academic_artifact_quality_failed"
                    result.self_correct = self_correct
                    stop_reason = "academic_artifact_quality_failed"
                    rejection_event = {
                        "step": getattr(result, "steps", 0),
                        "event": "goal_completion_claim_rejected",
                        "reason": "academic_artifact_quality_failed",
                        "issues": academic_issues,
                    }
                    result.trace.append(rejection_event)
                    all_trace.append(dict(rejection_event))
            if not isinstance(report, dict):
                result.goal_mode = True
                result.goal_cycles = cycles
                result.steps = total_steps
                result.tool_calls = all_tools
                result.trace = all_trace
                result.verifications = all_verifications
                result.subagents = all_subagents
                return result
            if stop_reason and stop_reason not in continuable:
                result.goal_mode = True
                result.goal_cycles = cycles
                result.steps = total_steps
                result.tool_calls = all_tools
                result.trace = all_trace
                result.verifications = all_verifications
                result.subagents = all_subagents
                return result

            if on_intermediate is not None:
                on_intermediate(
                    f"目标尚未达成，已自动进入第 {cycles + 1} 轮；"
                    "将沿用检查点、工具证据和未完成项继续执行。"
                )
            issue_details = ""
            repair_guidance = ""
            if isinstance(report, dict):
                issues = report.get("issues")
                if isinstance(issues, list) and issues:
                    issue_details = (
                        "\nThe completion gate found these exact issues; correct every one "
                        "and regenerate and re-verify derived artifacts:\n- "
                        + "\n- ".join(str(item) for item in issues)
                    )
                if report.get("stop_reason") == "academic_artifact_quality_failed":
                    repair_guidance = (
                        "\nThis is an artifact-only quality rejection. Reuse unrelated tests "
                        "that already passed; do not rerun the repository-wide test suite "
                        "unless your repair changed repository source code. Inspect and repair "
                        "the rejected document, regenerate its derived PDF, then run focused "
                        "document parsing/rendering checks."
                    )
            continuation = {
                "role": "user",
                "content": (
                    "Continue the same goal autonomously. Do not ask the user to type continue. "
                    "Use the existing tool evidence and checkpoint, resolve every unfinished item, "
                    "run the required verification, and stop only when the original goal is "
                    "actually complete."
                    + issue_details
                    + repair_guidance
                ),
            }
            current_resume = [*(getattr(result, "messages", []) or []), continuation]

    # -- streaming version ---------------------------------------------------

    def stream(self, user_input: str):
        """Stream events: reasoning -> tool_call -> answer -> done.

        Reasoning output (understanding, thinking, evidence, reflection)
        is streamed before the final answer for transparency.
        """
        yield reasoning_delta("Analyzing intent and available tools…")

        started = time.perf_counter()
        intent = analyze_intent(user_input)

        tool_result = None
        if intent.needs_tool:
            match = REGISTRY.match(user_input)
            if match is not None:
                tool_result, _retry_log = self._run_with_retry(match)
                if tool_result is not None:
                    yield tool_call_start(tool_result.tool_name, {}, 1)
                    yield tool_call_done(
                        tool_result.tool_name,
                        tool_result.output[:200] if tool_result.success else f"failed: {tool_result.error}",
                        1,
                        success=tool_result.success,
                    )

        # Synthesize with reasoning — use public build_messages API
        if tool_result is not None and tool_result.success:
            prompt = f"User asked: '{user_input}'\nTool result: {tool_result.output}\nProvide a helpful response."
        else:
            prompt = _build_tool_prompt(user_input)

        answer = ""
        try:
            full_response = ""
            native_reasoning = ""
            content_chunks: list[str] = []
            for chunk in self.agent.adapter.stream_generate(
                self.agent.build_messages(prompt, use_reasoning=self.agent.reasoning_enabled)
            ):
                kind = getattr(chunk, "kind", "content")
                if kind == "reasoning":
                    native_reasoning += getattr(chunk, "reasoning_content", "") or chunk.text
                    continue
                if kind == "usage":
                    continue
                text = chunk.text
                if text:
                    full_response += text
                    content_chunks.append(text)

            has_reasoning_tags = _contains_reasoning_tag(full_response)
            if self.agent.reasoning_enabled or has_reasoning_tags:
                self.agent.last_reasoning = parse_reasoning(full_response)
                answer = self.agent.last_reasoning.answer
                for section in ("understanding", "thinking", "evidence", "reflection"):
                    value = getattr(self.agent.last_reasoning, section, "") or ""
                    if value.strip():
                        yield reasoning_delta(f"{section}: {value}")
            else:
                self.agent.last_reasoning = None
                answer = full_response

            if native_reasoning and self.agent.last_reasoning is None:
                self.agent.last_reasoning = ReasoningResult(
                    thinking=native_reasoning.strip(),
                    answer=answer,
                    raw_response=full_response,
                    parse_success=True,
                    reasoning_mode="native",
                )
                yield reasoning_delta(f"thinking: {self.agent.last_reasoning.thinking}")

            if answer:
                if has_reasoning_tags or self.agent.reasoning_enabled:
                    yield answer_delta(answer)
                else:
                    for piece in content_chunks:
                        if piece:
                            yield answer_delta(piece)
        except Exception as exc:
            if tool_result is not None and tool_result.success:
                answer = _offline_tool_answer(user_input, tool_result)
                yield answer_delta(answer)
            else:
                yield error(str(exc))

        elapsed = round(time.perf_counter() - started, 3)
        yield done(
            answer,
            [{"intent": intent.category, "tool": tool_result.tool_name if tool_result else None}],
            elapsed,
            {"intent": intent.category, "enhanced": tool_result is not None},
        )

    # -- coding-specific loop ------------------------------------------------

    def run_coding_task(self, user_input: str, file_paths: list[str] | None = None) -> LoopResult:
        """Run a coding task with file context, reasoning, and verification."""
        started = time.perf_counter()
        trace: list[dict] = []

        # Read referenced files
        file_context = ""
        if file_paths:
            from arforge.code_reader import read_code_file

            parts = []
            for fp in file_paths:
                content = read_code_file(fp)
                parts.append(f"--- {fp} ---\n{content}")
            file_context = "\n\n".join(parts)
            trace.append({"step": "files_read", "paths": file_paths})

        # Build coding prompt with file context
        prompt_parts = [
            "You are an expert software engineer. Analyze the task and provide a concrete solution.",
            "",
            f"Task: {user_input}",
        ]
        if file_context:
            prompt_parts.append(f"\nRelevant files:\n{file_context}")
        prompt_parts.append(
            "\nIf code changes are needed, show the exact diff. If verification is needed, explain your approach."
        )
        full_prompt = "\n".join(prompt_parts)

        # Use reasoning pipeline for structured code analysis
        reasoning_result = self.agent.call_model_with_reasoning(full_prompt)
        answer = reasoning_result.answer
        trace.append({"step": "model_synthesized", "reasoning": reasoning_result.reasoning_summary})

        thinking_time = round(time.perf_counter() - started, 3)

        return LoopResult(
            answer=answer,
            intent="coding",
            trace=trace,
            thinking_time=thinking_time,
            reasoning=reasoning_result,
            reasoning_summary=reasoning_result.reasoning_summary,
        )

    # -- agentic loop (LLM-driven multi-step tool use) ----------------------

    @staticmethod
    def _finalize(adapter, messages) -> str:
        """不带工具地请模型基于现有上下文给出最终自然语言回答."""
        try:
            final = adapter.generate_with_tools(messages, tools=None)
            return final.content or ""
        except Exception as exc:
            return f"[Arforge] 生成最终回答失败:{exc}"


# ---------------------------------------------------------------------------
# Module-level convenience
# ---------------------------------------------------------------------------


def run_agent_turn_v2(user_input: str) -> LoopResult:
    return AgentLoopV2().run(user_input)
