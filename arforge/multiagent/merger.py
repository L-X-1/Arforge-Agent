"""ResultMerger — synthesizes SubAgent TaskResults into a final answer.

Supports four merge strategies:
1. Single result — pass through directly
2. Pipeline merge — chain outputs in dependency order
3. Adversarial merge — Coder + Reviewer + Tester → reconcile
4. LLM synthesis — feed all results to model for unified answer
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arforge.multiagent.master_agent import MasterAgent
    from arforge.multiagent.protocol import Conversation


class ResultMerger:
    """Combine multiple SubAgent results into a cohesive final answer."""

    def __init__(self, master: MasterAgent | None = None):
        self.master = master

    # ------------------------------------------------------------------
    # Main entry
    # ------------------------------------------------------------------

    def merge(self, conversation: Conversation, original_input: str) -> dict:
        """Select merge strategy based on conversation structure and execute.

        Returns a dict with at least {'answer': str}.
        """
        results = conversation.results
        if not results:
            return {"answer": "", "strategy": "empty"}

        # Single result — pass through
        if len(results) == 1:
            return self._single_result(results[0])

        # Detect strategy from task configuration
        if self._is_adversarial(conversation):
            return self._adversarial_merge(conversation, original_input)

        if self._is_pipeline(conversation):
            return self._pipeline_merge(conversation, original_input)

        # Default: LLM synthesis
        return self._llm_synthesis(conversation, original_input)

    # ------------------------------------------------------------------
    # Strategy: single result
    # ------------------------------------------------------------------

    @staticmethod
    def _single_result(result) -> dict:
        return {
            "answer": result.output if result.success else f"任务失败：{result.error}",
            "strategy": "single",
        }

    # ------------------------------------------------------------------
    # Strategy: pipeline
    # ------------------------------------------------------------------

    def _pipeline_merge(self, conversation, original_input: str) -> dict:
        """Chain results in dependency order (last task's output is the answer)."""
        results = conversation.results
        # Sort by task dependency depth
        ordered = self._order_by_dependency(results, conversation)
        if not ordered:
            return {"answer": "", "strategy": "pipeline"}

        # Use the last successful result as the primary answer
        last_success = None
        for r in reversed(ordered):
            if r.success:
                last_success = r
                break

        if last_success is None:
            # All failed — report errors
            errors = "\n".join(f"- [{r.role}] {r.error}" for r in ordered if r.error)
            return {"answer": f"所有任务失败：\n{errors}", "strategy": "pipeline"}

        # Build summary from all steps
        steps = []
        for r in ordered:
            status = "✓" if r.success else "✗"
            steps.append(f"{status} [{r.role}] {r.output[:200]}")

        answer = "\n".join(steps) + f"\n\n---\n最终结果：\n{last_success.output}"
        return {"answer": answer, "strategy": "pipeline"}

    # ------------------------------------------------------------------
    # Strategy: adversarial
    # ------------------------------------------------------------------

    def _adversarial_merge(self, conversation, original_input: str) -> dict:
        """Coder → Reviewer → Tester: find issues, reconcile, produce final code."""
        results = conversation.results
        coder_result = self._find_role_result(results, "CoderAgent")
        reviewer_result = self._find_role_result(results, "ReviewerAgent")
        tester_result = self._find_role_result(results, "TesterAgent")

        parts = []

        if coder_result and coder_result.success:
            parts.append(f"## 代码实现 (CoderAgent)\n{coder_result.output}")

        if reviewer_result:
            if reviewer_result.success:
                parts.append(f"## 审查意见 (ReviewerAgent)\n{reviewer_result.output}")
            else:
                parts.append(f"## 审查失败\n{reviewer_result.error}")

        if tester_result:
            if tester_result.success:
                parts.append(f"## 测试结果 (TesterAgent)\n{tester_result.output}")
            else:
                parts.append(f"## 测试失败\n{tester_result.error}")

        if not parts:
            return {"answer": "对抗验证未产生结果", "strategy": "adversarial"}

        answer = "\n\n".join(parts)

        # If we have a model, synthesize a reconciled answer
        if self.master and self.master.agent:
            try:
                prompt = (
                    f"原始需求：{original_input}\n\n"
                    f"各 Agent 结果：\n{answer}\n\n"
                    "请综合以上信息，给出最终统一的回答。关注：\n"
                    "1. 实现是否正确\n"
                    "2. 审查发现的问题是否已解决\n"
                    "3. 测试是否通过\n"
                    "4. 最终建议"
                )
                synthesis = self.master.agent.adapter.generate(
                    [{"role": "user", "content": prompt}],
                    max_tokens=1024,
                    temperature=0.3,
                )
                answer = f"{answer}\n\n## 综合分析\n{synthesis}"
            except Exception:
                pass

        return {"answer": answer, "strategy": "adversarial"}

    # ------------------------------------------------------------------
    # Strategy: LLM synthesis
    # ------------------------------------------------------------------

    def _llm_synthesis(self, conversation, original_input: str) -> dict:
        """Feed all sub-agent results to the LLM for a unified answer."""
        results_text = self._format_results(conversation.results)

        if self.master and self.master.agent:
            try:
                prompt = (
                    f"用户原始请求：{original_input}\n\n"
                    f"各子 Agent 的结果：\n{results_text}\n\n"
                    "请综合上述信息，给出最终的、统一的、清晰的回答。"
                )
                answer = self.master.agent.adapter.generate(
                    [{"role": "user", "content": prompt}],
                    max_tokens=1024,
                    temperature=0.3,
                )
                return {"answer": answer, "strategy": "llm_synthesis"}
            except Exception:
                pass

        # Fallback: concatenate results
        return {"answer": results_text, "strategy": "concat_fallback"}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _format_results(results: list) -> str:
        """Format a list of TaskResults for prompt injection."""
        parts = []
        for r in results:
            status = "✅" if r.success else "❌"
            parts.append(
                f"{status} [{r.role}] (tokens={r.tokens_used}, elapsed={r.elapsed_ms}ms)\n"
                f"{r.output[:400] if r.success else r.error[:200]}"
            )
        return "\n\n---\n\n".join(parts)

    @staticmethod
    def _order_by_dependency(results: list, conversation) -> list:
        """Order results by their task dependency depth."""
        task_order = {t.task_id: i for i, t in enumerate(conversation.tasks)}
        return sorted(results, key=lambda r: task_order.get(r.task_id, 999))

    @staticmethod
    def _find_role_result(results: list, role: str):
        """Find the first result with the given role."""
        for r in results:
            if r.role == role:
                return r
        return None

    @staticmethod
    def _is_pipeline(conversation) -> bool:
        """Detect pipeline pattern: sequential depends_on chain."""
        if len(conversation.tasks) < 2:
            return False
        # Pipeline: each task (except first) depends on previous
        chain = 0
        for t in conversation.tasks:
            if t.depends_on:
                chain += 1
        return chain >= len(conversation.tasks) - 1

    @staticmethod
    def _is_adversarial(conversation) -> bool:
        """Detect adversarial pattern: Coder + Reviewer + Tester present."""
        roles = {r.role for r in conversation.results}
        return "ReviewerAgent" in roles and ("CoderAgent" in roles or "TesterAgent" in roles)
