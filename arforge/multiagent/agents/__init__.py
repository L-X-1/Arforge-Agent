"""Built-in SubAgent implementations (8 roles)."""

from __future__ import annotations

from arforge.multiagent.agents.planner_agent import PlannerAgent
from arforge.multiagent.agents.coder_agent import CoderAgent
from arforge.multiagent.agents.reviewer_agent import ReviewerAgent
from arforge.multiagent.agents.tester_agent import TesterAgent
from arforge.multiagent.agents.searcher_agent import SearcherAgent
from arforge.multiagent.agents.doc_agent import DocAgent
from arforge.multiagent.agents.debugger_agent import DebuggerAgent
from arforge.multiagent.agents.data_agent import DataAgent

__all__ = [
    "PlannerAgent",
    "CoderAgent",
    "ReviewerAgent",
    "TesterAgent",
    "SearcherAgent",
    "DocAgent",
    "DebuggerAgent",
    "DataAgent",
]
