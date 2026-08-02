"""Cross-file consistency planning for symbol edits.

This module is intentionally read-only. It gives the agent a structured plan
before risky edits such as renaming a symbol or changing a function signature.
"""

from __future__ import annotations

import ast
import io
import keyword
import tokenize
from pathlib import Path
from typing import Any

from arforge.project_scanner import scan_project


def analyze_symbol_change(
    symbol: str,
    *,
    root: str | Path = ".",
    new_name: str | None = None,
    signature: str | None = None,
    limit: int = 200,
) -> dict[str, Any]:
    """Return a read-only consistency plan for a symbol change."""
    if not symbol or not symbol.strip():
        raise ValueError("symbol is required")
    base = Path(root).resolve()
    old_name = symbol.strip()
    wanted = max(1, int(limit))

    definitions: list[dict[str, Any]] = []
    references: list[dict[str, Any]] = []
    imports: list[dict[str, Any]] = []
    call_sites: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    for item in scan_project(base, suffixes=(".py",)):
        rel = str(item["path"]).replace("\\", "/")
        path = base / rel
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source)
        except (OSError, SyntaxError) as exc:
            failures.append({"file": rel, "reason": exc.__class__.__name__})
            continue

        visitor = _SymbolChangeVisitor(rel, old_name)
        visitor.visit(tree)
        definitions.extend(visitor.definitions)
        references.extend(visitor.references)
        imports.extend(visitor.imports)
        call_sites.extend(visitor.call_sites)

        if _total_items(definitions, references, imports, call_sites) >= wanted:
            break

    affected_files = sorted(
        {
            item["file"]
            for item in [*definitions, *references, *imports, *call_sites]
            if item.get("file")
        }
    )
    operations = _operations(old_name, new_name, signature)
    warnings = _warnings(old_name, definitions, references, imports, call_sites, new_name, signature)

    return {
        "symbol": old_name,
        "new_name": new_name or "",
        "signature": signature or "",
        "operations": operations,
        "affected_files": affected_files,
        "definitions": definitions[:wanted],
        "references": references[:wanted],
        "imports": imports[:wanted],
        "call_sites": call_sites[:wanted],
        "warnings": warnings,
        "summary": {
            "definitions": len(definitions),
            "references": len(references),
            "imports": len(imports),
            "call_sites": len(call_sites),
            "affected_files": len(affected_files),
            "failures": len(failures),
            "truncated": _total_items(definitions, references, imports, call_sites) > wanted,
        },
        "failures": failures[:20],
    }


def format_symbol_change_plan(plan: dict[str, Any]) -> str:
    """Render a compact human-readable plan for the tool output."""
    summary = plan["summary"]
    lines = [
        f"Cross-file consistency plan for `{plan['symbol']}`",
        f"- affected_files: {summary['affected_files']}",
        f"- definitions: {summary['definitions']}",
        f"- references: {summary['references']}",
        f"- imports: {summary['imports']}",
        f"- call_sites: {summary['call_sites']}",
    ]
    if plan.get("new_name"):
        lines.append(f"- rename_to: {plan['new_name']}")
    if plan.get("signature"):
        lines.append(f"- target_signature: {plan['signature']}")
    if plan["warnings"]:
        lines.append("")
        lines.append("Warnings:")
        lines.extend(f"- {warning}" for warning in plan["warnings"])
    if plan["affected_files"]:
        lines.append("")
        lines.append("Affected files:")
        lines.extend(f"- {file}" for file in plan["affected_files"][:50])
    if plan["call_sites"]:
        lines.append("")
        lines.append("Call sites:")
        for item in plan["call_sites"][:20]:
            lines.append(f"- {item['file']}:{item['line']} `{item['name']}` args={item['args']} kwargs={item['kwargs']}")
    if plan["imports"]:
        lines.append("")
        lines.append("Imports to review:")
        for item in plan["imports"][:20]:
            alias = f" as {item['asname']}" if item.get("asname") else ""
            lines.append(f"- {item['file']}:{item['line']} from {item['module']} import {item['name']}{alias}")
    return "\n".join(lines)


def apply_python_symbol_rename(
    symbol: str,
    new_name: str,
    *,
    root: str | Path = ".",
    apply: bool = False,
    require_definition: bool = True,
    limit: int = 200,
) -> dict[str, Any]:
    """Preview or apply a token-aware Python symbol rename.

    The operation is intentionally conservative:
    - only Python files returned by ``analyze_symbol_change`` are considered;
    - comments and strings are never edited because only NAME tokens are changed;
    - by default at least one definition must be found before any write happens;
    - ``apply=False`` returns the exact per-file replacement counts without
      modifying the workspace.
    """
    old_name = symbol.strip()
    target_name = new_name.strip()
    if not old_name:
        raise ValueError("symbol is required")
    if not _valid_identifier(target_name):
        raise ValueError("new_name must be a valid Python identifier")
    if old_name == target_name:
        raise ValueError("new_name must differ from symbol")

    base = Path(root).resolve()
    plan = analyze_symbol_change(old_name, root=base, new_name=target_name, limit=limit)
    if require_definition and not plan["definitions"]:
        raise ValueError(f"definition not found for symbol: {old_name}")

    files: list[dict[str, Any]] = []
    total_replacements = 0
    for relative in plan["affected_files"]:
        path = (base / relative).resolve()
        if base != path and base not in path.parents:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except OSError as exc:
            files.append({"file": relative, "replacements": 0, "error": exc.__class__.__name__})
            continue
        updated, replacements = _rename_name_tokens(source, old_name, target_name)
        changed = replacements > 0 and updated != source
        if apply and changed:
            path.write_text(updated, encoding="utf-8")
        total_replacements += replacements
        files.append(
            {
                "file": relative,
                "replacements": replacements,
                "changed": changed,
            }
        )

    return {
        "symbol": old_name,
        "new_name": target_name,
        "applied": bool(apply),
        "files": files,
        "total_replacements": total_replacements,
        "plan": plan,
        "warnings": _rename_apply_warnings(plan, total_replacements, bool(apply)),
    }


def format_python_symbol_rename(result: dict[str, Any]) -> str:
    """Render a compact rename preview/apply report."""
    mode = "applied" if result["applied"] else "dry-run"
    lines = [
        f"Python symbol rename {mode}: `{result['symbol']}` -> `{result['new_name']}`",
        f"- files: {len(result['files'])}",
        f"- replacements: {result['total_replacements']}",
    ]
    if result["warnings"]:
        lines.append("")
        lines.append("Warnings:")
        lines.extend(f"- {warning}" for warning in result["warnings"])
    if result["files"]:
        lines.append("")
        lines.append("Files:")
        for item in result["files"][:100]:
            status = "changed" if item.get("changed") else "unchanged"
            if item.get("error"):
                status = f"error={item['error']}"
            lines.append(f"- {item['file']}: {item['replacements']} replacement(s), {status}")
    return "\n".join(lines)


class _SymbolChangeVisitor(ast.NodeVisitor):
    def __init__(self, file: str, symbol: str):
        self.file = file
        self.symbol = symbol
        self.definitions: list[dict[str, Any]] = []
        self.references: list[dict[str, Any]] = []
        self.imports: list[dict[str, Any]] = []
        self.call_sites: list[dict[str, Any]] = []
        self._scope: list[str] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        self._record_definition(node, "function")
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        self._record_definition(node, "async_function")
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        self._record_definition(node, "class")
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_ImportFrom(self, node: ast.ImportFrom) -> Any:
        module = "." * node.level + (node.module or "")
        for alias in node.names:
            if alias.name == self.symbol:
                self.imports.append(
                    {
                        "file": self.file,
                        "line": node.lineno,
                        "module": module,
                        "name": alias.name,
                        "asname": alias.asname,
                        "kind": "from_import",
                    }
                )
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> Any:
        for alias in node.names:
            if alias.name.split(".")[-1] == self.symbol:
                self.imports.append(
                    {
                        "file": self.file,
                        "line": node.lineno,
                        "module": alias.name,
                        "name": alias.name,
                        "asname": alias.asname,
                        "kind": "import",
                    }
                )
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> Any:
        if node.id == self.symbol:
            self.references.append(self._location(node, "name", node.id))
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> Any:
        if node.attr == self.symbol:
            self.references.append(self._location(node, "attribute", _call_name(node)))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> Any:
        name = _call_name(node.func)
        if name == self.symbol or name.endswith(f".{self.symbol}"):
            self.call_sites.append(
                {
                    "file": self.file,
                    "line": node.lineno,
                    "name": name,
                    "scope": ".".join(self._scope),
                    "args": len(node.args),
                    "kwargs": [kw.arg or "**" for kw in node.keywords],
                }
            )
        self.generic_visit(node)

    def _record_definition(self, node: ast.AST, kind: str) -> None:
        name = getattr(node, "name", "")
        if name == self.symbol:
            self.definitions.append(
                {
                    "file": self.file,
                    "line": getattr(node, "lineno", 0),
                    "name": name,
                    "kind": kind,
                    "scope": ".".join(self._scope),
                    "signature": _signature(node),
                }
            )

    def _location(self, node: ast.AST, kind: str, name: str) -> dict[str, Any]:
        return {
            "file": self.file,
            "line": getattr(node, "lineno", 0),
            "name": name,
            "kind": kind,
            "scope": ".".join(self._scope),
        }


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def _signature(node: ast.AST) -> str:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return ""
    args = [arg.arg for arg in [*node.args.posonlyargs, *node.args.args]]
    if node.args.vararg:
        args.append(f"*{node.args.vararg.arg}")
    args.extend(arg.arg for arg in node.args.kwonlyargs)
    if node.args.kwarg:
        args.append(f"**{node.args.kwarg.arg}")
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{prefix} {node.name}({', '.join(args)})"


def _operations(old_name: str, new_name: str | None, signature: str | None) -> list[str]:
    operations: list[str] = []
    if new_name and new_name != old_name:
        operations.extend(["rename_definitions", "rename_references", "update_imports"])
    if signature:
        operations.extend(["update_signature", "review_call_sites"])
    return operations or ["inspect_consistency"]


def _warnings(
    old_name: str,
    definitions: list[dict[str, Any]],
    references: list[dict[str, Any]],
    imports: list[dict[str, Any]],
    call_sites: list[dict[str, Any]],
    new_name: str | None,
    signature: str | None,
) -> list[str]:
    warnings: list[str] = []
    if not definitions:
        warnings.append(f"No definition named `{old_name}` was found; verify the workspace root or language support.")
    if new_name and "." in new_name:
        warnings.append("New name contains a dot; rename planning expects a bare symbol name.")
    if signature and not call_sites:
        warnings.append("Signature change requested but no call sites were found.")
    if imports:
        warnings.append("Import statements reference this symbol and must be updated together with definitions.")
    if references and not call_sites:
        warnings.append("References exist outside direct calls; review assignments, annotations and attribute access.")
    return warnings


def _total_items(*groups: list[Any]) -> int:
    return sum(len(group) for group in groups)


def _valid_identifier(value: str) -> bool:
    return value.isidentifier() and not keyword.iskeyword(value)


def _rename_name_tokens(source: str, old_name: str, new_name: str) -> tuple[str, int]:
    tokens: list[tokenize.TokenInfo] = []
    replacements = 0
    reader = io.StringIO(source).readline
    for token in tokenize.generate_tokens(reader):
        if token.type == tokenize.NAME and token.string == old_name:
            token = tokenize.TokenInfo(token.type, new_name, token.start, token.end, token.line)
            replacements += 1
        tokens.append(token)
    return tokenize.untokenize(tokens), replacements


def _rename_apply_warnings(plan: dict[str, Any], total_replacements: int, applied: bool) -> list[str]:
    warnings = list(plan.get("warnings") or [])
    if total_replacements == 0:
        warnings.append("No NAME tokens were replaced; inspect the plan before editing manually.")
    if plan["summary"].get("truncated"):
        warnings.append("Plan was truncated; run with a higher limit before applying a broad rename.")
    if not applied:
        warnings.append("Dry-run only; pass apply=true after reviewing affected files.")
    return warnings
