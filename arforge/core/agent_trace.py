"""Trace collector for agent reasoning and tool execution."""

from __future__ import annotations

import time


class AgentTrace:
    def __init__(self):
        self.steps: list[dict] = []
        self.start_time = time.perf_counter()
        self.end_time = None

    def add(self, message: str, status: str = "done"):
        elapsed = round(time.perf_counter() - self.start_time, 3)
        step = {"message": message, "status": status, "elapsed": elapsed}
        self.steps.append(step)
        return step

    def finish(self):
        self.end_time = time.perf_counter()
        return self.duration()

    def duration(self):
        end = self.end_time if self.end_time is not None else time.perf_counter()
        return round(end - self.start_time, 3)

    def to_list(self):
        return list(self.steps)

    def to_summary_text(self):
        return f"Thought for {self.duration()}s"

    def render_for_cmd(self):
        lines = [self.to_summary_text()]
        for step in self.steps:
            lines.append(f"- [{step.get('status', 'done')}] {step.get('message', '')} ({step.get('elapsed', 0)}s)")
        return "\n".join(lines)
