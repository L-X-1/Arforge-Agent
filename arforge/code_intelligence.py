"""Unified code intelligence facade.

Provides a single entry point for all code analysis operations:
- Symbol search and navigation
- Call graph traversal (callers / callees)
- Dependency analysis (imports / reverse dependencies)
- Reference finding
- Impact analysis
- Test mapping
- Context packaging for model consumption
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


# ====================================================================
# Result objects
# ====================================================================


@dataclass
class SymbolRef:
    name: str
    kind: str  # function / class / method / variable
    file: str
    line: int
    signature: str = ""


@dataclass
class ContextPackage:
    """Structured context for model consumption with file paths and line numbers."""

    query: str
    symbols: list[SymbolRef] = field(default_factory=list)
    callers: list[str] = field(default_factory=list)
    callees: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    references: list[SymbolRef] = field(default_factory=list)
    test_files: list[str] = field(default_factory=list)
    impacted_files: list[str] = field(default_factory=list)
    file_contents: dict[str, str] = field(default_factory=dict)

    def to_markdown(self) -> str:
        """Render as a markdown block for model context injection."""
        lines = [f"## Context Package: {self.query}", ""]

        if self.symbols:
            lines.append("### Symbols Found")
            for s in self.symbols[:10]:
                lines.append(f"- `{s.name}` ({s.kind}) — `{s.file}:{s.line}`")
            lines.append("")

        if self.callers:
            caller_names = [c["name"] if isinstance(c, dict) else str(c) for c in self.callers[:10]]
            lines.append(f"### Callers: {', '.join(caller_names)}")
            lines.append("")

        if self.callees:
            callee_names = [c["name"] if isinstance(c, dict) else str(c) for c in self.callees[:10]]
            lines.append(f"### Callees: {', '.join(callee_names)}")
            lines.append("")

        if self.dependencies:
            lines.append(f"### Dependencies: {', '.join(self.dependencies[:10])}")
            lines.append("")

        if self.references:
            lines.append("### References")
            for r in self.references[:10]:
                lines.append(f"- `{r.file}:{r.line}` — {r.name} ({r.kind})")
            lines.append("")

        if self.test_files:
            lines.append(f"### Tests: {', '.join(self.test_files[:5])}")
            lines.append("")

        if self.impacted_files:
            lines.append(f"### Impacted: {', '.join(self.impacted_files[:5])}")
            lines.append("")

        if self.file_contents:
            lines.append("### Relevant File Contents")
            for path, content in list(self.file_contents.items())[:5]:
                lines.append(f"```python  {path}")
                lines.append(content[:2000])
                lines.append("```")
            lines.append("")

        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {
            "query": self.query,
            "symbols": [s.__dict__ for s in self.symbols],
            "callers": self.callers,
            "callees": self.callees,
            "dependencies": self.dependencies,
            "references": [r.__dict__ for r in self.references],
            "test_files": self.test_files,
            "impacted_files": self.impacted_files,
        }


# ====================================================================
# CodeIntelligence — unified facade
# ====================================================================


class CodeIntelligence:
    """Single entry point for all code intelligence operations."""

    def __init__(self, project_root: str | Path | None = None):
        self.root = Path(project_root) if project_root else Path.cwd()

    # -- search ---------------------------------------------------------------

    def search_symbol(self, name: str, limit: int = 20, match_mode: str = "substring") -> list[SymbolRef]:
        """Search for a symbol by name across the codebase.

        match_mode: "exact" | "prefix" | "substring" (default)
        """
        from arforge.python_ast_indexer import search_symbol

        results = search_symbol(name, match_mode=match_mode)
        refs = []
        for r in results[:limit]:
            if isinstance(r, dict):
                refs.append(
                    SymbolRef(
                        name=r.get("name", name),
                        kind=r.get("kind", "unknown"),
                        file=r.get("file", ""),
                        line=r.get("line", 0),
                        signature=r.get("signature", ""),
                    )
                )
        return refs

    def search_code(self, query: str, limit: int = 20) -> list[SymbolRef]:
        """Full-text search for code across the codebase (file content scan)."""
        import re
        from arforge.project_scanner import scan_project

        results = []
        terms = [t for t in re.split(r"\s+", query.lower()) if len(t) > 1]
        if not terms:
            return results

        # Resolve the candidate set through the shared pruned scanner. Path.rglob
        # descends into dependency stores before a file-level exclusion can run;
        # after the TypeScript framework merge that made two simple searches
        # enumerate the entire multi-gigabyte node_modules tree.
        for item in scan_project(self.root, suffixes=(".py",)):
            py_file = self.root / item["path"]
            try:
                content = py_file.read_text(encoding="utf-8")
            except Exception:
                continue
            for lineno, line in enumerate(content.splitlines(), 1):
                if all(t in line.lower() for t in terms):
                    results.append(SymbolRef(name="", kind="match", file=item["path"], line=lineno))
                    if len(results) >= limit:
                        break
            if len(results) >= limit:
                break
        return results

    # -- call graph ----------------------------------------------------------

    def get_callers(self, name: str, limit: int = 20) -> list[str]:
        from arforge.call_graph import list_callers

        return list_callers(name)[:limit]

    def get_callees(self, name: str, limit: int = 20) -> list[str]:
        from arforge.call_graph import list_callees

        return list_callees(name)[:limit]

    # -- dependencies --------------------------------------------------------

    def get_dependencies(self, file_path: str = "", limit: int = 200) -> list[dict]:
        from arforge.dependency_graph import list_dependencies

        deps = list_dependencies()
        return deps[:limit] if isinstance(deps, list) else []

    def get_reverse_dependencies(self, file_path: str, limit: int = 20) -> list[str]:
        from arforge.dependency_graph import list_reverse_dependencies

        return list_reverse_dependencies(file_path)[:limit]

    # -- references ----------------------------------------------------------

    def find_references(self, name: str, limit: int = 30) -> list[SymbolRef]:
        from arforge.reference_indexer import find_references

        refs = find_references(name, limit=limit)
        result = []
        for r in refs:
            if isinstance(r, dict):
                result.append(
                    SymbolRef(
                        name=r.get("name", name),
                        kind=r.get("kind", "reference"),
                        file=r.get("file", ""),
                        line=r.get("line", 0),
                    )
                )
        return result

    # -- impact --------------------------------------------------------------

    def analyze_impact(self, target: str) -> dict:
        from arforge.impact_analyzer import analyze_change_impact

        return analyze_change_impact(target)

    # -- test mapping --------------------------------------------------------

    def find_tests_for(self, source_file: str) -> list[str]:
        from arforge.test_mapping_indexer import list_tests_for_file, recommend_tests_for_file

        results = list_tests_for_file(source_file)
        if results:
            return [r["test"] for r in results]
        return [r.get("recommendation", "") for r in recommend_tests_for_file(source_file)]

    # -- file reading --------------------------------------------------------

    def read_file_content(self, file_path: str, max_lines: int = 200) -> str:
        target = self.root / file_path
        if not target.exists():
            return f"(file not found: {file_path})"
        try:
            lines = target.read_text(encoding="utf-8").splitlines()
            return "\n".join(lines[:max_lines])
        except Exception as exc:
            return f"(error reading {file_path}: {exc})"

    # -- context packaging ---------------------------------------------------

    def build_context_package(self, query: str, target_files: list[str] | None = None) -> ContextPackage:
        """Build a complete ContextPackage for a query.

        Combines symbols, call graph, dependencies, references, test mapping,
        and file contents into a single structured package ready for model injection.
        """
        pkg = ContextPackage(query=query)

        # Search for symbols mentioned in the query
        words = [w for w in query.split() if len(w) > 2 and w.isalnum()]
        for word in words[:5]:
            syms = self.search_symbol(word, limit=5)
            pkg.symbols.extend(syms)

        # If a symbol name is clear, get its call graph
        if pkg.symbols:
            main = pkg.symbols[0]
            pkg.callers = self.get_callers(main.name, limit=10)
            pkg.callees = self.get_callees(main.name, limit=10)
            pkg.references = self.find_references(main.name, limit=20)
            pkg.impacted_files = list(
                set(
                    d
                    for d in self.analyze_impact(main.file).get("reverse_dependencies", [])
                    if isinstance(d, str)
                )
            )[:10]

        # Read target files
        for fpath in (target_files or [])[:5]:
            pkg.file_contents[fpath] = self.read_file_content(fpath)

        # Find test files
        if target_files:
            for f in target_files[:3]:
                pkg.test_files.extend(self.find_tests_for(str(f)))

        return pkg


# ====================================================================
# Singleton
# ====================================================================

_INTELLIGENCE: CodeIntelligence | None = None


def get_code_intelligence() -> CodeIntelligence:
    global _INTELLIGENCE
    if _INTELLIGENCE is None:
        _INTELLIGENCE = CodeIntelligence()
    return _INTELLIGENCE


# ====================================================================
# Quick helper functions
# ====================================================================


def search(query: str, limit: int = 20) -> list[SymbolRef]:
    """Quick symbol search."""
    return get_code_intelligence().search_symbol(query, limit)


def context_package(query: str, files: list[str] | None = None) -> ContextPackage:
    """Build a context package for a query."""
    return get_code_intelligence().build_context_package(query, files)


def find_definition(name: str) -> SymbolRef | None:
    """Find where a symbol is defined. Returns the first matching symbol."""
    syms = get_code_intelligence().search_symbol(name, limit=1)
    return syms[0] if syms else None


def who_calls(name: str) -> list[str]:
    """List all callers of a function/class."""
    return get_code_intelligence().get_callers(name)


def what_tests(file_path: str) -> list[str]:
    """Find tests for a source file."""
    return get_code_intelligence().find_tests_for(file_path)
