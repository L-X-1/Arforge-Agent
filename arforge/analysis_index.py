"""Shared AST analysis index for project relationship modules."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

from arforge.project_scanner import scan_project


@dataclass
class ModuleAnalysis:
    path: str
    imports: list[dict] = field(default_factory=list)
    symbols: list[dict] = field(default_factory=list)
    calls: list[dict] = field(default_factory=list)
    classes: list[dict] = field(default_factory=list)
    assignments: list[dict] = field(default_factory=list)


_CACHE: dict[str, ModuleAnalysis] = {}


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def analyze_file(path: Path, root: Path = Path(".")) -> ModuleAnalysis:
    rel = str(path.resolve().relative_to(root.resolve()))
    text = path.read_text(encoding="utf-8", errors="replace")
    analysis = ModuleAnalysis(rel)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return analysis
    parents: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                analysis.imports.append({"module": alias.name, "name": alias.asname or alias.name, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                analysis.imports.append({"module": module, "name": alias.name, "asname": alias.asname, "line": node.lineno})
        elif isinstance(node, ast.ClassDef):
            bases = [_call_name(base) for base in node.bases]
            analysis.classes.append({"name": node.name, "bases": bases, "line": node.lineno, "file": rel})
            analysis.symbols.append({"name": node.name, "kind": "class", "line": node.lineno, "file": rel})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            analysis.symbols.append({"name": node.name, "kind": "function", "line": node.lineno, "file": rel})
        elif isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name:
                analysis.calls.append({"name": name, "line": node.lineno, "file": rel, "scope": ".".join(parents)})
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                name = _call_name(target)
                if name:
                    analysis.assignments.append({"name": name, "line": node.lineno, "file": rel, "value_type": type(node.value).__name__})
    return analysis


def build_analysis_index(root: str | Path = ".") -> dict[str, ModuleAnalysis]:
    global _CACHE
    base = Path(root).resolve()
    analyses = {}
    for item in scan_project(base, suffixes=(".py",)):
        if "arforge_corrupt_backup" in item["path"] or item["path"].startswith("tests/legacy_script"):
            continue
        path = base / item["path"]
        analyses[item["path"]] = analyze_file(path, base)
    _CACHE = analyses
    return analyses


def get_analysis_index() -> dict[str, ModuleAnalysis]:
    if not _CACHE:
        return build_analysis_index()
    return _CACHE
