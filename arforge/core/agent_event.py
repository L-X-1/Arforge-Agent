"""Structured event helpers for streaming agent output."""

from __future__ import annotations


def make_event(event_type: str, data: dict = None):
    return {"type": event_type, "data": data or {}}


def reasoning_start():
    return make_event("reasoning_start")


def reasoning_delta(content: str):
    return make_event("reasoning_delta", {"content": content})


def reasoning_done():
    return make_event("reasoning_done")


def answer_start():
    return make_event("answer_start")


def answer_delta(content: str):
    return make_event("answer_delta", {"content": content})


def answer_done(answer: str):
    return make_event("answer_done", {"answer": answer})


def trace_start():
    return make_event("trace_start")


def trace_step(message: str, elapsed: float, status: str = "done"):
    return make_event("trace_step", {"message": message, "elapsed": elapsed, "status": status})


def trace_done(thinking_time: float, collapsed: bool = True):
    return make_event("trace_done", {"thinking_time": thinking_time, "collapsed": collapsed})


def tool_call_start(tool_name: str, args: dict, iteration: int):
    return make_event("tool_call_start", {"tool_name": tool_name, "args": args, "iteration": iteration})


def tool_call_done(tool_name: str, result_summary: str, iteration: int, success: bool = True):
    return make_event(
        "tool_call_done",
        {"tool_name": tool_name, "result_summary": result_summary, "iteration": iteration, "success": success},
    )


def done(answer: str, trace: list, thinking_time: float, meta: dict = None):
    return make_event("done", {"answer": answer, "trace": trace, "thinking_time": thinking_time, "collapsed": True, "meta": meta or {}})


def error(message: str):
    return make_event("error", {"message": message})
