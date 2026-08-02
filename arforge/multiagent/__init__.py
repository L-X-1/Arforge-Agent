"""Arforge multi-agent orchestration layer (Layer 13).

MasterAgent + SubAgent pool + dispatch protocols + collaboration patterns.
"""

from __future__ import annotations

from arforge.multiagent.protocol import AgentRole, Conversation, Task, TaskResult
from arforge.multiagent.sub_agent import (
    AgentChannel,
    AgentMessage,
    AgentStatus,
    SubAgent,
    get_agent_status,
    get_all_agent_statuses,
    set_agent_status,
)

from arforge.multiagent.dispatcher import DispatchConfig, TaskDispatcher, get_dispatcher
from arforge.multiagent.router import DynamicTaskRouter, RouterConfig
from arforge.multiagent.metrics import DispatchMetricsCollector, DispatchReport, format_dispatch_report

__all__ = [
    "AgentRole",
    "Task",
    "TaskResult",
    "Conversation",
    "SubAgent",
    "AgentChannel",
    "AgentMessage",
    "AgentStatus",
    "get_agent_status",
    "get_all_agent_statuses",
    "set_agent_status",
    "DispatchConfig",
    "TaskDispatcher",
    "get_dispatcher",
    "DynamicTaskRouter",
    "RouterConfig",
    "DispatchMetricsCollector",
    "DispatchReport",
    "format_dispatch_report",
]
