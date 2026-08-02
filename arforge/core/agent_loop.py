"""Local agent turn loop."""

from __future__ import annotations

from dataclasses import dataclass

from arforge.agent_core import ArforgeAgent
from arforge.capability.enhancement_engine import get_capability_engine
from arforge.intent_analyzer import analyze_intent
from arforge.tool_executor import run_tool_if_match


@dataclass
class AgentLoopResult:
    answer: str
    intent: str
    tool_result: object = None
    enhanced: bool = False


class AgentLoop:
    def __init__(self, agent: ArforgeAgent | None = None):
        self.agent = agent or ArforgeAgent()

    def run(self, user_input: str) -> AgentLoopResult:
        intent = analyze_intent(user_input)
        tool_result = run_tool_if_match(user_input)
        response = self.agent.chat(user_input)
        answer = response.answer
        if tool_result is not None:
            answer = f"{answer}\n\nTool result:\n{tool_result}"
        enhanced_answer = get_capability_engine().enhance_answer(user_input, answer)
        return AgentLoopResult(enhanced_answer, intent.category, tool_result, enhanced_answer != answer)


def run_agent_turn(user_input: str) -> AgentLoopResult:
    return AgentLoop().run(user_input)
