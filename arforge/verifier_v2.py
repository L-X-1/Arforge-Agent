"""Extended verification helpers."""

from __future__ import annotations

from pathlib import Path

from arforge.verifier import verify_python_file


def verify_files(paths: list[str | Path]) -> dict:
    results = {str(path): verify_python_file(path) for path in paths if str(path).endswith(".py")}
    return {"success": all(item["success"] for item in results.values()), "results": results}


def summarize_verification(result: dict) -> str:
    return "passed" if result.get("success") else "failed"
