"""Eval judge utilities — LLM-judge and code-execution scoring.

Provides:
  judge_answer(answer, rubric, adapter) -> dict
  run_code_check(code, test_code) -> dict
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def _load_json_object(raw: str) -> dict:
    """Parse a JSON object even when a compatible model adds a code fence."""
    text = str(raw or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start >= 0:
        value, _end = json.JSONDecoder().raw_decode(text[start:])
        if isinstance(value, dict):
            return value
    raise ValueError("judge response did not contain a JSON object")


def judge_answer(answer: str, rubric: str, adapter: Any = None) -> dict:
    """Use an LLM adapter to judge whether an answer satisfies a rubric.

    Args:
        answer: The agent's answer text.
        rubric: Description of what constitutes a correct answer.
        adapter: An LLM adapter with a generate() method. If None, returns failure.

    Returns:
        {"passed": bool, "score": float, "reason": str}
    """
    if adapter is None:
        return {"passed": False, "score": 0.0, "reason": "No judge adapter provided"}

    try:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are an expert evaluator. Judge whether the answer satisfies the rubric. "
                    "Respond with a JSON object: {\"passed\": true/false, \"score\": 0.0-1.0, \"reason\": \"...\"}"
                ),
            },
            {
                "role": "user",
                "content": f"Rubric: {rubric}\n\nAnswer: {answer}",
            },
        ]
        # Reasoning-capable compatible endpoints may spend part of this budget
        # on hidden thinking before emitting the JSON text.  A 256-token cap
        # can therefore produce an empty visible response even for a correct
        # answer.
        raw = adapter.generate(messages, max_tokens=1024, temperature=0.0, response_format={"type": "json_object"})
        if not str(raw or "").strip():
            raise ValueError("judge returned no visible response")
        result = _load_json_object(raw)
        return {
            "passed": bool(result.get("passed", False)),
            "score": float(result.get("score", 0.0)),
            "reason": str(result.get("reason", "")),
        }
    except Exception as exc:
        return {"passed": False, "score": 0.0, "reason": f"Judge error: {exc}"}


def run_code_check(code: str, test_code: str) -> dict:
    """Execute agent-produced code against a test snippet and return pass/fail.

    Extracts Python code from markdown fences, writes to a temp file,
    appends the test code, and executes the result.

    Returns:
        {"passed": bool, "score": float, "stdout": str, "stderr": str}
    """
    # Extract code from markdown fences if present
    clean_code = code.strip()
    if clean_code.startswith("```"):
        lines = clean_code.split("\n")
        # Remove opening fence
        if lines[0].startswith("```"):
            lines = lines[1:]
        # Remove closing fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        clean_code = "\n".join(lines)

    if not clean_code.strip():
        return {"passed": False, "score": 0.0, "stdout": "", "stderr": "No code provided"}

    full_code = clean_code + "\n" + test_code

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    ) as f:
        f.write(full_code)
        tmp_path = f.name

    try:
        r = subprocess.run(
            ["python", tmp_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        passed = r.returncode == 0
        return {
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "stdout": r.stdout[:2000],
            "stderr": r.stderr[:2000],
        }
    except subprocess.TimeoutExpired:
        return {"passed": False, "score": 0.0, "stdout": "", "stderr": "Timeout"}
    except Exception as exc:
        return {"passed": False, "score": 0.0, "stdout": "", "stderr": str(exc)}
    finally:
        Path(tmp_path).unlink(missing_ok=True)
