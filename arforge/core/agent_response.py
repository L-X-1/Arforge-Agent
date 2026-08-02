"""Agent response value object."""

from __future__ import annotations


class AgentResponse:
    def __init__(self, answer: str, trace=None, thinking_time: float = 0.0, collapsed: bool = True, meta=None):
        self.answer = answer
        self.trace = trace or []
        self.thinking_time = thinking_time
        self.collapsed = collapsed
        self.meta = meta or {}

    def to_dict(self):
        return {
            "answer": self.answer,
            "trace": self.trace,
            "thinking_time": self.thinking_time,
            "collapsed": self.collapsed,
            "meta": self.meta,
        }
