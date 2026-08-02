"""Run real STAGE-01 technical validation and retain evidence."""

from __future__ import annotations

import argparse
import json
import sys

from arforge.core.staging_validation import collect_staging_validation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--formal-report", required=True)
    parser.add_argument("--output-dir", default="build/release-evidence")
    parser.add_argument("--release-candidate-id", required=True)
    parser.add_argument("--artifact-set-id", required=True)
    parser.add_argument("--workflow-run-id", required=True)
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--duration-minutes", type=float, default=15.0)
    parser.add_argument("--token-budget", type=int, default=300_000)
    args = parser.parse_args()
    try:
        result = collect_staging_validation(
            formal_report=args.formal_report,
            output_dir=args.output_dir,
            release_candidate_id=args.release_candidate_id,
            artifact_set_id=args.artifact_set_id,
            workflow_run_id=args.workflow_run_id,
            requests=args.requests,
            concurrency=args.concurrency,
            duration_minutes=args.duration_minutes,
            token_budget=args.token_budget,
        )
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"technical_ready": result["technical_ready"], "paths": result["paths"]}, indent=2))
    return 0 if result["technical_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
