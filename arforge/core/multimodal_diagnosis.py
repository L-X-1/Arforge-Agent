"""Multimodal diagnostic chain for screenshots and documents.

The chain is deliberately local and auditable:
source file -> text extraction -> error signal extraction -> code search ->
repair-oriented suggestions. It does not require a model call.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from arforge.project_scanner import scan_project

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"}
_DOC_EXTS = {".pdf", ".docx", ".txt", ".md", ".rst"}
_CODE_SUFFIXES = (".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs")


def diagnose_multimodal_file(
    file_path: str | Path,
    *,
    root: str | Path = ".",
    extracted_text: str | None = None,
    max_search_results: int = 8,
) -> dict[str, Any]:
    """Run the local multimodal error-diagnosis chain."""
    path = Path(file_path)
    base = Path(root).resolve()
    source = _extract_source_text(path, extracted_text=extracted_text)
    text = source.get("text", "")
    signals = extract_error_signals(text)
    terms = _search_terms(signals, text)
    matches = search_code_for_terms(base, terms, limit=max_search_results)
    suggestions = build_repair_suggestions(signals, matches, source)
    return {
        "success": bool(text.strip()),
        "path": str(path),
        "source": source,
        "signals": signals,
        "search_terms": terms,
        "matches": matches,
        "suggestions": suggestions,
        "summary": {
            "text_chars": len(text),
            "signals": len(signals),
            "search_terms": len(terms),
            "matches": len(matches),
        },
    }


def extract_error_signals(text: str) -> list[dict[str, Any]]:
    """Extract traceback, exception, import and missing-name clues."""
    signals: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    for match in re.finditer(r'File "([^"]+)", line (\d+)', text):
        _add_signal(
            signals,
            seen,
            {
                "kind": "file_line",
                "value": match.group(1),
                "line": int(match.group(2)),
                "raw": match.group(0),
            },
        )

    for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b(?::\s*([^\n]+))?", text):
        _add_signal(
            signals,
            seen,
            {
                "kind": "exception",
                "value": match.group(1),
                "detail": (match.group(2) or "").strip(),
                "raw": match.group(0).strip(),
            },
        )

    for pattern, kind in [
        (r"name '([^']+)' is not defined", "missing_name"),
        (r"No module named '([^']+)'", "missing_module"),
        (r"cannot import name '([^']+)'", "missing_import"),
        (r"Module not found: Can't resolve '([^']+)'", "missing_module"),
    ]:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            _add_signal(
                signals,
                seen,
                {
                    "kind": kind,
                    "value": match.group(1),
                    "raw": match.group(0),
                },
            )

    for match in re.finditer(r"\b([A-Za-z0-9_./\\-]+\.(?:py|js|jsx|ts|tsx|go|rs))\b", text):
        _add_signal(
            signals,
            seen,
            {
                "kind": "file_reference",
                "value": match.group(1).replace("\\", "/"),
                "raw": match.group(0),
            },
        )

    return signals


def search_code_for_terms(root: Path, terms: list[str], *, limit: int = 8) -> list[dict[str, Any]]:
    if not terms:
        return []
    matches: list[dict[str, Any]] = []
    lower_terms = [term.lower() for term in terms if len(term) > 1]
    for item in scan_project(root, suffixes=_CODE_SUFFIXES):
        rel = str(item["path"]).replace("\\", "/")
        path = root / rel
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_no, line in enumerate(lines, 1):
            lower = line.lower()
            found = [term for term in lower_terms if term.lower() in lower]
            if not found:
                continue
            matches.append(
                {
                    "file": rel,
                    "line": line_no,
                    "terms": sorted(set(found)),
                    "preview": line.strip()[:240],
                }
            )
            if len(matches) >= limit:
                return matches
    return matches


def build_repair_suggestions(
    signals: list[dict[str, Any]],
    matches: list[dict[str, Any]],
    source: dict[str, Any],
) -> list[str]:
    suggestions: list[str] = []
    file_signals = [signal for signal in signals if signal["kind"] in {"file_line", "file_reference"}]
    exception_signals = [signal for signal in signals if signal["kind"] == "exception"]
    missing_signals = [signal for signal in signals if signal["kind"].startswith("missing_")]

    if file_signals:
        first = file_signals[0]
        line = f":{first['line']}" if first.get("line") else ""
        suggestions.append(f"Inspect the referenced file first: {first['value']}{line}.")
    if missing_signals:
        values = ", ".join(sorted({signal["value"] for signal in missing_signals}))
        suggestions.append(f"Search definitions/imports for missing symbol or module: {values}.")
    if exception_signals:
        values = ", ".join(sorted({signal["value"] for signal in exception_signals}))
        suggestions.append(f"Reproduce the failing path and add a focused regression for: {values}.")
    if matches:
        touched = ", ".join(sorted({match["file"] for match in matches})[:5])
        suggestions.append(f"Start with matched code locations before editing: {touched}.")
    if not source.get("success"):
        suggestions.append("Text extraction did not succeed; install/configure OCR or provide a text document/export.")
    if not suggestions:
        suggestions.append("No strong error signal was found; inspect the extracted text and provide a clearer screenshot or log.")
    return suggestions


def format_multimodal_diagnosis(result: dict[str, Any]) -> str:
    summary = result["summary"]
    source = result["source"]
    lines = [
        "Multimodal diagnosis",
        f"- source_type: {source.get('type', 'unknown')}",
        f"- extraction_success: {source.get('success')}",
        f"- text_chars: {summary['text_chars']}",
        f"- signals: {summary['signals']}",
        f"- matches: {summary['matches']}",
    ]
    if source.get("error"):
        lines.append(f"- extraction_error: {source['error']}")
    if result["signals"]:
        lines.append("")
        lines.append("Signals:")
        for signal in result["signals"][:12]:
            location = f":{signal['line']}" if signal.get("line") else ""
            lines.append(f"- {signal['kind']} {signal['value']}{location}")
    if result["matches"]:
        lines.append("")
        lines.append("Code matches:")
        for match in result["matches"][:12]:
            lines.append(f"- {match['file']}:{match['line']} [{', '.join(match['terms'])}] {match['preview']}")
    lines.append("")
    lines.append("Suggestions:")
    lines.extend(f"- {suggestion}" for suggestion in result["suggestions"])
    return "\n".join(lines)


def _extract_source_text(path: Path, *, extracted_text: str | None) -> dict[str, Any]:
    if extracted_text is not None:
        return {"success": True, "type": "provided_text", "text": extracted_text, "path": str(path)}
    if not path.exists():
        return {"success": False, "type": "missing", "text": "", "path": str(path), "error": "file not found"}
    suffix = path.suffix.lower()
    if suffix in _IMAGE_EXTS:
        from arforge.multimodal import extract_ocr, inspect_image

        meta = inspect_image(path)
        ocr = extract_ocr(path)
        normalized = _normalize_extraction_result(ocr)
        normalized.update({"type": "image_ocr", "image": meta, "path": str(path)})
        return normalized
    if suffix in _DOC_EXTS:
        from arforge.multimodal import read_document

        doc = read_document(path)
        normalized = _normalize_extraction_result(doc, text_key="text_preview")
        normalized.update({"type": "document", "path": str(path)})
        return normalized
    return {"success": False, "type": "unsupported", "text": "", "path": str(path), "error": f"unsupported file type: {suffix}"}


def _normalize_extraction_result(result: Any, *, text_key: str = "text") -> dict[str, Any]:
    if isinstance(result, str):
        success = bool(result.strip()) and "not installed" not in result.lower() and "failed" not in result.lower()
        return {"success": success, "text": result, "error": "" if success else result}
    if isinstance(result, dict):
        text = str(result.get(text_key) or result.get("text") or result.get("ocr_text") or "")
        return {
            "success": bool(result.get("success", bool(text.strip()))),
            "text": text,
            "error": result.get("error", ""),
            "engine": result.get("engine", ""),
        }
    return {"success": False, "text": "", "error": "unsupported extraction result"}


def _search_terms(signals: list[dict[str, Any]], text: str) -> list[str]:
    terms: list[str] = []
    for signal in signals:
        value = str(signal.get("value", "")).strip()
        if value:
            terms.append(Path(value).stem if "." in value or "/" in value else value)
        detail = str(signal.get("detail", "")).strip()
        terms.extend(re.findall(r"'([A-Za-z_][A-Za-z0-9_]{2,})'", detail))
        terms.extend(re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", detail)[:6])
    if not terms:
        terms.extend(re.findall(r"[A-Za-z_][A-Za-z0-9_]{3,}", text)[:6])
    deduped: list[str] = []
    for term in terms:
        if term and term not in deduped:
            deduped.append(term)
    return deduped[:12]


def _add_signal(signals: list[dict[str, Any]], seen: set[tuple[str, str, int]], signal: dict[str, Any]) -> None:
    key = (signal.get("kind", ""), signal.get("value", ""), int(signal.get("line", 0) or 0))
    if key in seen:
        return
    seen.add(key)
    signals.append(signal)
