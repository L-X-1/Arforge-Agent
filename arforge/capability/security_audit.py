"""Simple security audit helpers."""

from __future__ import annotations


DANGEROUS_PATTERNS = ["rm -rf", "del /s", "eval(", "exec(", "pickle.loads", "shell=True"]


def audit_text(text: str) -> dict:
    findings = [pattern for pattern in DANGEROUS_PATTERNS if pattern.lower() in text.lower()]
    return {"safe": not findings, "findings": findings}


def audit_command(command: str) -> dict:
    return audit_text(command)
