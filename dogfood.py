"""Deterministic offline dogfood for Arforge's core user journeys."""

from __future__ import annotations

import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import statistics
import tempfile
import time


PROMPTS = [
    "Summarize the goal in one sentence.",
    "List three practical next actions.",
    "Explain the tradeoff briefly.",
    "Give a concise status update.",
    "Turn this idea into a checklist.",
    "Identify the main assumption.",
    "Suggest one safer alternative.",
    "Describe the expected outcome.",
    "State the decision clearly.",
    "Provide a short handoff note.",
    "Name the biggest uncertainty.",
    "Summarize the evidence.",
    "Give a one-line recommendation.",
    "Explain what success means.",
    "List the acceptance criteria.",
    "Describe a rollback trigger.",
    "Give a user-facing explanation.",
    "State what should happen next.",
    "Highlight one possible failure.",
    "Close with a concise answer.",
]


class OfflineAdapter:
    """Stable model substitute: exercises the full chat/learning pipeline without network use."""

    def __init__(self):
        self.calls = 0

    def generate(self, messages, **kwargs):  # noqa: ARG002
        self.calls += 1
        return (
            "<understanding>offline dogfood request</understanding>"
            "<thinking>deterministic local validation</thinking>"
            "<evidence>isolated profile and database</evidence>"
            "<reflection>no network dependency</reflection>"
            f"<answer>Offline response {self.calls}.</answer>"
        )


def _restore_environment(previous: dict[str, str | None]) -> None:
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def run_dogfood(rounds: int = 5) -> dict:
    if rounds < 1:
        raise ValueError("rounds must be at least 1")
    with ExitStack() as stack:
        previous = {
            key: os.environ.get(key)
            for key in ("ARFORGE_HOME", "ARFORGE_DB_URL", "ARFORGE_MULTIAGENT_DB_URL", "DEEPSEEK_API_KEY")
        }
        temp = stack.enter_context(tempfile.TemporaryDirectory(prefix="arforge-dogfood-"))
        stack.callback(_restore_environment, previous)
        root = Path(temp)
        os.environ["ARFORGE_HOME"] = str(root / "profile")
        os.environ["ARFORGE_DB_URL"] = f"sqlite:///{root / 'main.db'}"
        os.environ["ARFORGE_MULTIAGENT_DB_URL"] = f"sqlite:///{root / 'multi.db'}"
        os.environ.pop("DEEPSEEK_API_KEY", None)

        from arforge.core.agent_core import ArforgeAgent
        from arforge.database.engine import dispose_engines
        from arforge.mcp_client import make_request
        from arforge.memory import query_memories, save_memory_v2
        from arforge.privacy_cli import scan_sensitive_files
        from arforge.tool_registry import REGISTRY, ToolMatch
        import arforge.tools.basic_tools  # noqa: F401

        stack.callback(dispose_engines)

        adapter = OfflineAdapter()
        agent = ArforgeAgent(reasoning_enabled=True, multiagent_enabled=False)
        agent._adapter = adapter
        latencies: list[float] = []
        failures: list[str] = []

        for _ in range(rounds):
            for prompt in PROMPTS:
                started = time.perf_counter()
                response = agent.chat(prompt)
                latencies.append((time.perf_counter() - started) * 1000)
                if not response.answer.startswith("Offline response"):
                    failures.append(prompt)

        calculation = REGISTRY.execute(ToolMatch("calculate", {"expression": "(17 + 8) * 4"}))
        if not calculation.success or calculation.output != "100":
            failures.append("calculate tool")

        secret = "sk-" + "D" * 38
        memory_id = save_memory_v2(f"never persist {secret}", dedupe=False)
        stored = next(item for item in query_memories(limit=20) if item["id"] == memory_id)
        if secret in stored["content"]:
            failures.append("memory redaction")

        request = make_request("tools/list", {})
        if request.get("jsonrpc") != "2.0" or request.get("method") != "tools/list":
            failures.append("MCP request")

        sensitive_scan = scan_sensitive_files(root)
        if sensitive_scan["findings"]:
            failures.append("sensitive data scan")

        ordered = sorted(latencies)
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        return {
            "success": not failures,
            "turns": len(latencies),
            "model_calls": adapter.calls,
            "p50_ms": round(statistics.median(latencies), 2),
            "p95_ms": round(p95, 2),
            "failures": failures,
            "network_calls": 0,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=5, help="20 turns per round; default produces 100 turns")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = run_dogfood(args.rounds)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        print(f"Offline dogfood: {result['turns']} turns, p95={result['p95_ms']}ms, failures={len(result['failures'])}")
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
