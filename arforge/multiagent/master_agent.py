"""MasterAgent — multi-agent orchestration engine (Layer 13).

The MasterAgent receives user input, decides whether to use single-agent or
multi-agent mode, decomposes complex goals into Tasks, dispatches them to
SubAgents, evaluates quality, iterates, and merges results into a final answer.
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from arforge.multiagent.protocol import (
    Conversation,
    Task,
    save_conversation,
)

if TYPE_CHECKING:
    from arforge.core.agent_core import ArforgeAgent


# ====================================================================
# Supporting data classes
# ====================================================================


@dataclass
class TaskUnderstanding:
    """Result of MasterAgent._understand()."""

    intent: str = ""  # One-line summary
    complexity: str = "simple"  # simple / medium / complex
    suggested_roles: list[str] = field(default_factory=list)
    estimated_steps: int = 1
    needs_multiagent: bool = False


@dataclass
class QualityAssessment:
    """Result of MasterAgent._evaluate()."""

    satisfied: bool = True
    score: float = 1.0  # 0.0 — 1.0
    missing: list[str] = field(default_factory=list)  # What's still missing
    suggestions: list[str] = field(default_factory=list)  # How to improve


# ====================================================================
# MasterAgent
# ====================================================================


class MasterAgent:
    """Top-level orchestrator that decomposes user goals and coordinates SubAgents.

    MasterAgent does NOT replace ArforgeAgent — it wraps it.  Simple queries
    are forwarded directly; complex goals go through the multi-agent pipeline:

        understand → decompose → dispatch → evaluate → (iterate) → merge → answer
    """

    def __init__(self, agent: ArforgeAgent | None = None):
        self.agent = agent  # ArforgeAgent instance (lazy-created if None)
        # Hard safety cap. The selected reasoning depth chooses 2–5 rounds.
        self.max_iterations: int = 5
        # SubAgent pool and dispatcher are lazy-imported to avoid circular deps
        self._pool = None
        self._dispatcher = None
        self._merger = None
        # P0-2: 各阶段 JSON 解析成功率统计（经 observability.json_parse 透出）
        self._json_stats = {
            "understand_ok": 0, "understand_fail": 0,
            "decompose_ok": 0, "decompose_fail": 0,
            "evaluate_ok": 0, "evaluate_fail": 0,
        }
        # P1-3: 懒构造的向量记忆（规划阶段检索项目知识）
        self._vector_memory = None
        self._vector_memory_workspace = None
        self._active_lock = threading.RLock()
        self._active_conversations: dict[str, Conversation] = {}

    # ------------------------------------------------------------------
    # Lazy accessors (avoid circular imports with sub_agent / dispatcher)
    # ------------------------------------------------------------------

    @property
    def pool(self):
        if self._pool is None:
            from arforge.multiagent.sub_agent_pool import get_sub_agent_pool

            self._pool = get_sub_agent_pool()
        return self._pool

    @property
    def dispatcher(self):
        if self._dispatcher is None:
            from arforge.multiagent.dispatcher import TaskDispatcher

            self._dispatcher = TaskDispatcher(master=self)
        return self._dispatcher

    @property
    def merger(self):
        if self._merger is None:
            from arforge.multiagent.merger import ResultMerger

            self._merger = ResultMerger(self)
        return self._merger

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    def handle(
        self,
        user_input: str,
        progress_callback=None,
        reasoning_effort: str | None = None,
    ) -> dict:
        """Main entry point: user request → multi-agent collaboration → final answer.

        Returns a dict with keys: answer, mode (single/multi), conversation_id,
        agents_used, iterations, tokens_estimated.
        """
        user_input = user_input.strip()
        if not user_input:
            return {"answer": "", "mode": "single", "conversation_id": "", "agents_used": 0}

        from arforge.reasoning.effort import normalize_reasoning_effort

        agent = getattr(self, "agent", None)
        effort = normalize_reasoning_effort(
            reasoning_effort or getattr(agent, "reasoning_effort", None)
        )
        if agent is not None:
            agent.reasoning_effort = effort

        # HK-3：多 Agent 整体会话生命周期事件（observer；无 handler 时零开销旁路）。
        from arforge.core import hooks

        hooks.fire_event(hooks.HookEvent.SESSION_START, metadata={"goal": user_input})

        # P2-6: 端到端可观测 —— 建根 span，各阶段子 span 自然嵌套于其下
        from arforge.observability import Tracer, aggregate

        tracer = Tracer()
        root = tracer.start_span("multiagent.handle")
        try:
            with tracer.span("understand"):
                understanding = self._understand(user_input)
            if not understanding.needs_multiagent and not self._needs_multiagent(understanding):
                result = self._single_agent_path(user_input)
            else:
                result = self._multi_agent_path(
                    user_input,
                    understanding,
                    tracer=tracer,
                    progress_callback=progress_callback,
                    reasoning_effort=effort,
                )
        finally:
            tracer.end_span(root)

        obs = result.get("observability") or {}
        obs["trace"] = root.to_dict()
        obs["summary"] = aggregate(root)
        result["observability"] = obs
        hooks.fire_event(
            hooks.HookEvent.SESSION_END,
            metadata={"mode": result.get("mode"), "agents_used": result.get("agents_used", 0)},
        )
        return result

    def cancel_active(self, reason: str = "cancelled by user") -> int:
        """Cooperatively cancel every active orchestration owned by this master."""
        with self._active_lock:
            active = list(self._active_conversations.values())
        for conversation in active:
            conversation.cancel(reason)
        return len(active)

    # ------------------------------------------------------------------
    # Task understanding
    # ------------------------------------------------------------------

    def _understand(self, user_input: str) -> TaskUnderstanding:
        """Analyze user input to determine intent, complexity, and agent needs.

        Uses the LLM when available; falls back to heuristic classification.
        """
        # Try LLM-driven understanding
        if self.agent is not None:
            try:
                return self._understand_via_model(user_input)
            except Exception:
                pass

        return self._understand_heuristic(user_input)

    def _understand_via_model(self, user_input: str) -> TaskUnderstanding:
        """Use the LLM to classify the request."""
        available_roles = self.pool.list_role_names()
        roles_text = ", ".join(available_roles)
        prompt = (
            f"Runtime role additions: {roles_text}\n\n"
            "分析以下用户请求，输出 JSON：\n"
            '{"intent": "一句话总结", "complexity": "simple/medium/complex", '
            '"suggested_roles": ["角色名"], "estimated_steps": 数字, '
            '"needs_multiagent": true/false}\n\n'
            "可用角色：PlannerAgent, CoderAgent, ReviewerAgent, TesterAgent, "
            "SearcherAgent, DocAgent, DebuggerAgent, DataAgent\n\n"
            f"用户请求：{user_input}"
        )
        from arforge.models.structured import generate_structured

        data = generate_structured(
            self.agent.adapter,
            [{"role": "user", "content": prompt}],
            required_keys=["intent"],
            max_tokens=256,
            temperature=0.1,
        )
        if data:
            self._json_stats["understand_ok"] += 1
            suggested_roles = data.get("suggested_roles", [])
            if not isinstance(suggested_roles, list):
                suggested_roles = []
            return TaskUnderstanding(
                intent=data.get("intent", ""),
                complexity=data.get("complexity", "simple"),
                suggested_roles=[role for role in suggested_roles if role in available_roles],
                estimated_steps=data.get("estimated_steps", 1),
                needs_multiagent=data.get("needs_multiagent", False),
            )
        self._json_stats["understand_fail"] += 1
        return self._understand_heuristic(user_input)

    @staticmethod
    def _understand_heuristic(user_input: str) -> TaskUnderstanding:
        """Keyword-based fallback when the model is unavailable."""
        text = user_input.lower()

        # Detect complexity
        if len(user_input) > 300 or any(
            kw in text for kw in ["架构", "architecture", "重构", "refactor", "系统", "system"]
        ):
            complexity = "complex"
            steps = 5
        elif any(kw in text for kw in ["修复", "fix", "实现", "implement", "测试", "test", "审查", "review"]):
            complexity = "medium"
            steps = 3
        else:
            complexity = "simple"
            steps = 1

        # Detect which roles are needed
        roles = []
        if any(kw in text for kw in ["规划", "plan", "架构", "architecture", "设计", "design"]):
            roles.append("PlannerAgent")
        if any(kw in text for kw in ["修复", "fix", "实现", "implement", "代码", "code", "编写", "修改"]):
            roles.extend(["SearcherAgent", "CoderAgent"])
        if any(kw in text for kw in ["审查", "review", "审计", "audit", "安全", "security"]):
            roles.append("ReviewerAgent")
        if any(kw in text for kw in ["测试", "test", "pytest", "覆盖率", "coverage"]):
            roles.append("TesterAgent")
        if any(kw in text for kw in ["文档", "doc", "readme", "翻译", "translate"]):
            roles.append("DocAgent")
        if any(kw in text for kw in ["调试", "debug", "错误", "error", "bug", "崩溃", "crash"]):
            roles.append("DebuggerAgent")
        if any(kw in text for kw in ["数据", "data", "图表", "chart", "分析", "analyze", "统计"]):
            roles.append("DataAgent")
        if any(kw in text for kw in ["搜索", "search", "查找", "find", "检索"]):
            roles.append("SearcherAgent")

        needs_multi = len(roles) > 1 or complexity in ("medium", "complex")

        return TaskUnderstanding(
            intent=user_input[:80],
            complexity=complexity,
            suggested_roles=roles or ["CoderAgent"],
            estimated_steps=steps,
            needs_multiagent=needs_multi,
        )

    @staticmethod
    def _needs_multiagent(understanding: TaskUnderstanding) -> bool:
        """Return True if the task warrants multi-agent collaboration."""
        if understanding.needs_multiagent:
            return True
        if understanding.complexity in ("medium", "complex"):
            return True
        if len(understanding.suggested_roles) > 1:
            return True
        if understanding.estimated_steps > 2:
            return True
        return False

    # ------------------------------------------------------------------
    # Single-agent path
    # ------------------------------------------------------------------

    def _single_agent_path(self, user_input: str) -> dict:
        """Forward to the underlying ArforgeAgent for simple queries."""
        if self.agent is not None:
            try:
                response = self.agent.chat(user_input)
                answer = response.answer if hasattr(response, "answer") else str(response)
            except Exception:
                answer = self._fallback_chat(user_input)
        else:
            answer = self._fallback_chat(user_input)

        return {"answer": answer, "mode": "single", "conversation_id": "", "agents_used": 0}

    @staticmethod
    def _fallback_chat(user_input: str) -> str:
        """Fallback: use the model adapter directly."""
        try:
            from arforge.product.model_config_runtime import get_model_config

            adapter = get_model_config().create_active_adapter()
            return adapter.generate([{"role": "user", "content": user_input}])
        except Exception:
            return f"[Arforge] 无法处理请求: {user_input[:100]}"

    # ------------------------------------------------------------------
    # Multi-agent path
    # ------------------------------------------------------------------

    def _recall_context(self, user_input: str, top_k: int = 5) -> str:
        """P1-3: 从向量记忆检索与请求相关的项目知识（只读共享上下文）。

        懒构造 VectorMemory（从 arforge.memory 载入）；ARFORGE_DISABLE_RAG=1 跳过；
        任何异常吞掉不阻断编排（离线/无数据场景行为不退化）。
        """
        import os

        if os.environ.get("ARFORGE_DISABLE_RAG") == "1":
            return ""
        try:
            from arforge.tools.file_tools import get_workspace

            workspace = str(get_workspace())
            if self._vector_memory is None or (
                self._vector_memory_workspace is not None
                and self._vector_memory_workspace.casefold() != workspace.casefold()
            ):
                from arforge.memory_vector import build_vector_memory

                self._vector_memory = build_vector_memory(workspace_path=workspace)
                self._vector_memory_workspace = workspace
            return self._vector_memory.recall_text(user_input, top_k=top_k)
        except Exception:
            return ""

    def _multi_agent_path(
        self,
        user_input: str,
        understanding: TaskUnderstanding,
        tracer=None,
        progress_callback=None,
        reasoning_effort: str = "medium",
    ) -> dict:
        """Full multi-agent pipeline: decompose → dispatch → evaluate → iterate → merge.

        P2-6: 各阶段建 span（传入 tracer 则嵌套于 handle 根 span，否则自建供独立调用）。
        """
        import config

        from arforge.observability import Tracer, aggregate

        tracer = tracer or Tracer()
        pipeline_span = tracer.start_span("multiagent.pipeline")
        conv = Conversation(master_goal=user_input)
        conv.set_shared("_reasoning_effort", reasoning_effort)
        conv.set_progress_callback(progress_callback)
        conv.set_deadline(float(getattr(config, "MULTIAGENT_TOTAL_TIMEOUT", 0)))
        with self._active_lock:
            self._active_conversations[conv.conversation_id] = conv
        conv.emit_progress(
            "pipeline_start",
            goal=user_input[:500],
            complexity=understanding.complexity,
        )
        try:
            conv.shared_memory["understanding"] = {
                "intent": understanding.intent,
                "complexity": understanding.complexity,
            }

            # P1-3: 检索项目记忆/知识作为只读共享上下文，供子 Agent 规划/执行参考
            with tracer.span("recall_context"):
                context = self._recall_context(user_input)
            if context:
                conv.shared_memory["context"] = context

            # Decompose into tasks
            conv.emit_progress("phase_start", phase="decompose")
            with tracer.span("decompose"):
                tasks = self._decompose(user_input, understanding)
            conv.tasks = tasks
            conv.emit_progress("phase_end", phase="decompose", task_count=len(tasks))

            from arforge.reasoning.effort import multiagent_iteration_budget

            iteration_budget = min(
                self.max_iterations,
                multiagent_iteration_budget(reasoning_effort),
            )
            # Iterative execution loop
            total_iterations = 0
            for iteration in range(1, iteration_budget + 1):
                total_iterations = iteration
                completed = {result.task_id for result in conv.results}
                remaining = [task for task in conv.tasks if task.task_id not in completed]
                if not remaining:
                    break
                if conv.expired:
                    conv.cancel("multi-agent runtime deadline exceeded")
                    break

                # The dispatcher owns dependency ordering across the complete
                # remaining graph. Passing only the currently-ready level would
                # artificially require one master iteration per pipeline stage.
                conv.emit_progress(
                    "phase_start",
                    phase="dispatch",
                    iteration=iteration,
                    task_count=len(remaining),
                )
                with tracer.span(f"dispatch.round{iteration}"):
                    results = self.dispatcher.dispatch(remaining, conv)
                    for r in results:
                        rs = tracer.start_span(f"agent.{r.role}", kind="subagent")
                        rs.attributes["success"] = r.success
                        rs.attributes["tokens"] = r.tokens_used
                        tracer.end_span(rs, status="ok" if r.success else "error")
                conv.emit_progress(
                    "phase_end",
                    phase="dispatch",
                    iteration=iteration,
                    completed=len(results),
                    failed=sum(1 for result in results if not result.success),
                )
                # Real dispatchers append as they execute so dependency consumers
                # can see prior outputs. Test/custom dispatchers may return results
                # without doing that; merge them exactly once in either case.
                for result in results:
                    if conv.result_for(result.task_id) is None:
                        conv.append_result(result)

                if conv.cancelled:
                    break

                # Evaluate quality
                conv.emit_progress("phase_start", phase="evaluate", iteration=iteration)
                with tracer.span("evaluate"):
                    quality = self._evaluate(conv, user_input)
                conv.emit_progress(
                    "phase_end",
                    phase="evaluate",
                    iteration=iteration,
                    satisfied=quality.satisfied,
                    score=quality.score,
                )
                if quality.satisfied:
                    break

                # Refine: adjust remaining tasks
                if iteration < iteration_budget:
                    with tracer.span("refine"):
                        self._refine(quality, conv, understanding)

            # Persist
            try:
                save_conversation(conv)
            except Exception:
                pass

            # Merge results
            conv.emit_progress("phase_start", phase="merge")
            with tracer.span("merge"):
                final = self.merger.merge(conv, user_input)
            conv.emit_progress("phase_end", phase="merge")
        finally:
            conv.emit_progress(
                "pipeline_end",
                cancelled=conv.cancelled,
                completed=len(conv.get_results_snapshot()),
            )
            with self._active_lock:
                self._active_conversations.pop(conv.conversation_id, None)
            tracer.end_span(pipeline_span)

        agents_used = len({r.role for r in conv.results})
        tokens_estimated = sum(r.tokens_used for r in conv.results)
        failed_count = sum(1 for result in conv.results if not result.success)
        original_tasks_succeeded = bool(conv.tasks) and all(
            (result := conv.result_for(task.task_id)) is not None and result.success
            for task in conv.tasks
        )
        success = (
            not conv.cancelled
            and original_tasks_succeeded
            and failed_count == 0
        )

        return {
            "answer": final.get("answer", ""),
            "mode": "multi",
            "conversation_id": conv.conversation_id,
            "agents_used": agents_used,
            "iterations": total_iterations,
            "tokens_estimated": tokens_estimated,
            "task_count": len(conv.tasks),
            "success": success,
            "cancelled": conv.cancelled,
            "cancel_reason": conv.get_shared("_cancel_reason", ""),
            "failed_count": failed_count,
            "results": [r.to_dict() for r in conv.results],
            "observability": {
                "json_parse": dict(self._json_stats),
                "trace": pipeline_span.to_dict(),
                "summary": aggregate(pipeline_span),
            },
        }

    # ------------------------------------------------------------------
    # Task decomposition
    # ------------------------------------------------------------------

    def _decompose(self, user_input: str, understanding: TaskUnderstanding) -> list[Task]:
        """Break the user goal into a list of Tasks with dependency ordering."""
        # Try LLM-driven decomposition
        if self.agent is not None:
            try:
                return self._decompose_via_model(user_input, understanding)
            except Exception:
                pass

        return self._decompose_heuristic(user_input, understanding)

    def _decompose_via_model(self, user_input: str, understanding: TaskUnderstanding) -> list[Task]:
        """Use the LLM to generate a structured task list."""
        available_roles = set(self.pool.list_role_names())
        roles_desc = "\n".join(
            f"- {r.name}: {r.description}" for r in self.pool.list_roles()
        )
        if not roles_desc:
            roles_desc = (
                "- PlannerAgent: 任务分解与方案设计\n"
                "- CoderAgent: 代码实现与编辑\n"
                "- ReviewerAgent: 代码审查与安全审计\n"
                "- TesterAgent: 测试生成与运行\n"
                "- SearcherAgent: 代码/记忆/网页检索\n"
                "- DocAgent: 文档生成与读取\n"
                "- DebuggerAgent: 错误诊断与修复\n"
                "- DataAgent: 数据分析与可视化\n"
            )

        prompt = (
            "你是任务规划专家。将以下用户目标分解为任务列表。\n\n"
            "可用角色：\n"
            f"{roles_desc}\n\n"
            "每个任务格式：\n"
            '{"task_id": "step_N", "role": "角色名", "goal": "具体目标", '
            '"depends_on": ["依赖的task_id"], "priority": 100}\n\n'
            "规则：\n"
            "- 第一个任务用 SearcherAgent 检索相关代码\n"
            "- 代码实现用 CoderAgent\n"
            "- 审查用 ReviewerAgent\n"
            "- 测试用 TesterAgent\n"
            "- depends_on 列出必须等它完成的任务 ID\n"
            "- priority 越小越优先（默认 100）\n\n"
            '以 JSON 对象输出：{"tasks": [ ...上述格式的任务... ]}，不要其他内容。\n\n'
            f"用户目标：{user_input}"
        )

        from arforge.models.structured import generate_structured

        data = generate_structured(
            self.agent.adapter,
            [{"role": "user", "content": prompt}],
            required_keys=["tasks"],
            max_tokens=1024,
            temperature=0.2,
        )
        items = data.get("tasks") if data else None
        if isinstance(items, list):
            tasks = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                role = item.get("role", "CoderAgent")
                if role not in available_roles:
                    role = "CoderAgent"
                tasks.append(
                    Task(
                        task_id=item.get("task_id", ""),
                        role=role,
                        goal=item.get("goal", str(item)),
                        depends_on=item.get("depends_on", []),
                        priority=item.get("priority", 100),
                    )
                )
            if tasks:
                self._json_stats["decompose_ok"] += 1
                return tasks
        self._json_stats["decompose_fail"] += 1
        return self._decompose_heuristic(user_input, understanding)

    @staticmethod
    def _decompose_heuristic(user_input: str, understanding: TaskUnderstanding) -> list[Task]:
        """Rule-based task decomposition fallback."""
        roles = understanding.suggested_roles
        tasks: list[Task] = []

        if not roles:
            roles = ["CoderAgent"]

        # Standard pipeline: Search → Plan → Code → Review → Test
        has_code = any(r in ("CoderAgent", "DebuggerAgent") for r in roles)
        has_review = "ReviewerAgent" in roles
        has_test = "TesterAgent" in roles

        idx = 0

        # Step 1: Search
        if has_code or "SearcherAgent" in roles:
            tasks.append(
                Task(
                    task_id=f"step_{idx}",
                    role="SearcherAgent",
                    goal=f"搜索与任务相关的代码文件和上下文：{user_input[:100]}",
                    priority=100,
                )
            )
            idx += 1

        # Step 2: Plan (if complex)
        if understanding.complexity == "complex" or "PlannerAgent" in roles:
            tasks.append(
                Task(
                    task_id=f"step_{idx}",
                    role="PlannerAgent",
                    goal=f"制定详细执行方案：{user_input[:100]}",
                    depends_on=[f"step_{idx - 1}"] if idx > 0 else [],
                    priority=90,
                )
            )
            idx += 1

        # Step 3: Code
        if has_code:
            tasks.append(
                Task(
                    task_id=f"step_{idx}",
                    role="CoderAgent",
                    goal=f"实现代码变更：{user_input[:100]}",
                    depends_on=[f"step_{idx - 1}"] if idx > 0 else [],
                    priority=80,
                )
            )
            idx += 1

        # Step 4: Review
        if has_review:
            tasks.append(
                Task(
                    task_id=f"step_{idx}",
                    role="ReviewerAgent",
                    goal=f"审查代码变更的正确性和安全性：{user_input[:100]}",
                    depends_on=[f"step_{idx - 1}"] if idx > 0 else [],
                    priority=70,
                )
            )
            idx += 1

        # Step 5: Test
        if has_test:
            tasks.append(
                Task(
                    task_id=f"step_{idx}",
                    role="TesterAgent",
                    goal=f"为变更编写并运行测试：{user_input[:100]}",
                    depends_on=[f"step_{idx - 1}"] if idx > 0 else [],
                    priority=60,
                )
            )
            idx += 1

        # Fallback: at least one task
        if not tasks:
            tasks.append(
                Task(
                    task_id="step_0",
                    role=roles[0],
                    goal=user_input[:200],
                    priority=100,
                )
            )

        return tasks

    # ------------------------------------------------------------------
    # Quality evaluation
    # ------------------------------------------------------------------

    def _evaluate(self, conv: Conversation, original_input: str) -> QualityAssessment:
        """Evaluate whether the results so far satisfy the original goal."""
        if not conv.results:
            return QualityAssessment(satisfied=False, score=0.0, missing=["no results yet"])

        # P1-4: 质量信号 — Reviewer 指出 critical/严重 → 不满意，触发下一轮（即使任务都成功）
        if self._has_critical_review(conv):
            return QualityAssessment(
                satisfied=False,
                score=0.5,
                missing=["review 指出严重(critical)问题"],
                suggestions=["修复审查指出的严重问题"],
            )

        # All successful → satisfied
        all_ok = all(r.success for r in conv.results)
        if all_ok and len(conv.results) >= len(conv.tasks):
            return QualityAssessment(satisfied=True, score=1.0)

        # Some failures → try LLM evaluation
        if self.agent is not None:
            try:
                return self._evaluate_via_model(conv, original_input)
            except Exception:
                pass

        # Heuristic
        failures = [r for r in conv.results if not r.success]
        if failures:
            return QualityAssessment(
                satisfied=False,
                score=0.5,
                missing=[f"task {f.task_id} failed: {f.error}" for f in failures],
                suggestions=["retry failed tasks"],
            )

        return QualityAssessment(satisfied=True, score=0.8)

    def _evaluate_via_model(self, conv: Conversation, original_input: str) -> QualityAssessment:
        """Use the LLM to evaluate result quality."""
        results_text = "\n".join(
            f"- [{r.role}] {'OK' if r.success else 'FAIL'}: {r.output[:200]}"
            for r in conv.results
        )
        prompt = (
            f"原始目标：{original_input}\n\n"
            f"子 Agent 结果：\n{results_text}\n\n"
            "判断：结果是否满足原始目标？输出 JSON：\n"
            '{"satisfied": true/false, "score": 0.0-1.0, '
            '"missing": ["缺失项"], "suggestions": ["改进建议"]}'
        )
        from arforge.models.structured import generate_structured

        data = generate_structured(
            self.agent.adapter,
            [{"role": "user", "content": prompt}],
            required_keys=["satisfied"],
            max_tokens=256,
            temperature=0.1,
        )
        if data is not None:
            self._json_stats["evaluate_ok"] += 1
            return QualityAssessment(
                satisfied=data.get("satisfied", True),
                score=data.get("score", 1.0),
                missing=data.get("missing", []),
                suggestions=data.get("suggestions", []),
            )
        self._json_stats["evaluate_fail"] += 1
        return QualityAssessment(satisfied=True, score=0.7)

    # ------------------------------------------------------------------
    # Refinement
    # ------------------------------------------------------------------

    @staticmethod
    def _role_for_missing(missing_text: str) -> str:
        """P1-4: 按缺失项语义匹配最合适的角色（而非一律 CoderAgent）。"""
        t = (missing_text or "").lower()
        if any(k in t for k in ("test", "测试", "verify", "验证", "覆盖率")):
            return "TesterAgent"
        if any(k in t for k in ("doc", "文档", "注释", "说明", "readme")):
            return "DocAgent"
        if any(k in t for k in ("search", "检索", "查找", "调研", "find")):
            return "SearcherAgent"
        if any(k in t for k in ("debug", "调试", "报错", "bug", "异常")):
            return "DebuggerAgent"
        if any(k in t for k in ("review", "审查", "审计", "安全")):
            return "ReviewerAgent"
        return "CoderAgent"

    @staticmethod
    def _has_critical_review(conv: Conversation) -> bool:
        """P1-4: ReviewerAgent 指出 critical/严重/blocker → 视为质量不达标。"""
        import re

        for r in conv.results:
            if r.role == "ReviewerAgent" and r.success:
                text = (r.output or "").lower()
                # Remove explicit zero/negative findings before checking severity.
                # A report such as "0 critical issues" is an approval signal, not
                # a reason to manufacture refinement tasks.
                text = re.sub(
                    r"\b(?:0|no)\s+(?:critical|blocker)s?(?:\s+issues?)?\b",
                    "",
                    text,
                )
                for phrase in ("无严重", "没有严重", "未发现严重", "无 blocker", "无blocker"):
                    text = text.replace(phrase, "")
                if "critical" in text or "严重" in text or "blocker" in text:
                    return True
        return False

    def _refine(self, quality: QualityAssessment, conv: Conversation, understanding: TaskUnderstanding) -> None:
        """Adjust remaining tasks based on quality feedback."""
        # Add follow-up tasks for missing items（P1-4: 按语义分配角色）
        for i, missing in enumerate(quality.missing):
            conv.tasks.append(
                Task(
                    task_id=f"refine_{uuid.uuid4().hex[:8]}",
                    role=self._role_for_missing(missing),
                    goal=f"补充缺失内容：{missing}",
                    depends_on=[],
                    priority=50 + i,
                )
            )

    # ------------------------------------------------------------------
    # JSON extraction helper
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_json(raw: str) -> Any:
        """Extract JSON object/array from model output (may be wrapped in text)."""
        raw = raw.strip()
        # Try direct parse
        for start_char, end_char in [("[", "]"), ("{", "}")]:
            start = raw.find(start_char)
            end = raw.rfind(end_char)
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(raw[start : end + 1])
                except (json.JSONDecodeError, TypeError):
                    pass
        return None
