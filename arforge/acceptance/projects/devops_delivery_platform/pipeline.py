from __future__ import annotations

from pathlib import Path
import re

import yaml


def validate_workflow(path: Path) -> list[str]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    if payload.get("permissions") != {"contents": "read"}:
        errors.append("workflow permissions must be read-only")
    jobs = payload.get("jobs", {})
    if not {"test", "build"} <= set(jobs):
        errors.append("test and build jobs are required")
    for job in jobs.values():
        for step in job.get("steps", []):
            action = str(step.get("uses", ""))
            if action and not re.fullmatch(r"[^@]+@[0-9a-f]{40}", action):
                errors.append(f"action is not commit-pinned: {action}")
    build_steps = [
        str(step.get("run", ""))
        for step in jobs.get("build", {}).get("steps", [])
    ]
    if not any("docker build" in step for step in build_steps):
        errors.append("Docker build step is missing")
    if not any("kubectl apply --dry-run=client" in step for step in build_steps):
        errors.append("Kubernetes validation step is missing")
    return errors


if __name__ == "__main__":
    problems = validate_workflow(Path(".github/workflows/delivery.yml"))
    if problems:
        raise SystemExit("; ".join(problems))
    print("PASS:CI/CD:GitHub Actions")
