"""Measure cold-process Arforge startup and CLI latency budgets."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time


CASES = {
    "package_import": [sys.executable, "-c", "import arforge"],
    "agent_init": [sys.executable, "-c", "from arforge.core.agent_core import ArforgeAgent; ArforgeAgent()"],
    "cli_version": [sys.executable, "-m", "arforge", "--version"],
    "cli_help": [sys.executable, "-m", "arforge", "--help"],
    "cli_privacy": [sys.executable, "-m", "arforge", "privacy"],
}

BUDGET_P95_MS = {
    "package_import": 500,
    "agent_init": 1_000,
    "cli_version": 750,
    "cli_help": 750,
    "cli_privacy": 1_000,
}


def measure(runs: int = 8) -> dict:
    if runs < 2:
        raise ValueError("runs must be at least 2")
    with tempfile.TemporaryDirectory(prefix="arforge-perf-") as temp:
        root = Path(temp)
        environment = os.environ.copy()
        environment.update(
            {
                "NO_COLOR": "1",
                "ARFORGE_HOME": str(root / "profile"),
                "ARFORGE_DB_URL": "sqlite:///:memory:",
                "ARFORGE_MULTIAGENT_DB_URL": "sqlite:///:memory:",
            }
        )
        results = {}
        for name, command in CASES.items():
            samples = []
            for _ in range(runs):
                started = time.perf_counter()
                completed = subprocess.run(
                    command,
                    env=environment,
                    input="n\n",
                    text=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                    check=False,
                )
                samples.append((time.perf_counter() - started) * 1000)
                if completed.returncode:
                    raise RuntimeError(f"{name} exited with {completed.returncode}")
            ordered = sorted(samples)
            p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
            results[name] = {
                "runs": runs,
                "p50_ms": round(statistics.median(samples), 1),
                "p95_ms": round(p95, 1),
                "budget_p95_ms": BUDGET_P95_MS[name],
                "within_budget": p95 <= BUDGET_P95_MS[name],
            }
        return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=8)
    parser.add_argument("--enforce", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    results = measure(args.runs)
    if args.json:
        print(json.dumps(results, sort_keys=True))
    else:
        for name, result in results.items():
            print(f"{name}: p50={result['p50_ms']}ms p95={result['p95_ms']}ms budget={result['budget_p95_ms']}ms")
    return 1 if args.enforce and not all(item["within_budget"] for item in results.values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
