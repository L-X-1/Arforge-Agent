"""High-level safe modification API."""

from __future__ import annotations

import py_compile
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple, Union

from arforge.logger import write_log
from arforge.security.backup_manager import smart_backup
from arforge.security.diff_generator import diff_summary_cn, generate_unified_diff
from arforge.security.file_ops import safe_write


@dataclass
class ModifyResult:
    success: bool
    file_path: Path
    is_new_file: bool = False
    original_content: str = ""
    new_content: str = ""
    backup_id: str = ""
    backup_path: str = ""
    diff_summary: str = ""
    verification_status: str = ""
    verification_detail: str = ""
    error: str = ""
    rolled_back: bool = False
    rollback_error: str = ""
    warnings: List[str] = field(default_factory=list)


def _verify_python(path: Path) -> tuple[str, str]:
    if path.suffix != ".py":
        return "skipped", "not a Python file"
    try:
        py_compile.compile(str(path), doraise=True)
    except Exception as exc:
        return "failed", str(exc)
    return "passed", "compile check passed"


def safe_modify_file(
    file_path: Union[str, Path],
    new_content: str,
    reason: str = "modify",
    related_step: int = 0,
    description: str = "",
    verify: bool = True,
    auto_rollback: bool = True,
    run_lint: bool = False,
) -> ModifyResult:
    path = Path(file_path)
    is_new = not path.exists()
    original = path.read_text(encoding="utf-8") if path.exists() else ""
    backup = smart_backup(path, reason, related_step, description) if path.exists() else None
    diff = generate_unified_diff(path, original, new_content)
    write_result = safe_write(path, new_content, auto_backup=False, require_confirm=False)
    result = ModifyResult(
        success=bool(write_result.get("success")),
        file_path=path,
        is_new_file=is_new,
        original_content=original,
        new_content=new_content,
        backup_path=str(backup) if backup else "",
        diff_summary=diff_summary_cn([diff]),
        error=write_result.get("error", ""),
    )
    if not result.success:
        return result

    if verify:
        status, detail = _verify_python(path)
        result.verification_status = status
        result.verification_detail = detail
        if status == "failed":
            result.success = False
            if auto_rollback and backup and backup.exists():
                rollback = safe_write(path, backup.read_text(encoding="utf-8"), auto_backup=False, require_confirm=False)
                result.rolled_back = bool(rollback.get("success"))
                result.rollback_error = rollback.get("error", "")
    else:
        result.verification_status = "skipped"
        result.verification_detail = "verification disabled"
    if run_lint:
        result.warnings.append("lint execution is not rebuilt in safe_modifier yet")
    write_log("info", f"safe_modify_file {path}: {result.success}")
    return result


def safe_modify_multi(
    changes: List[Tuple[Union[str, Path], str]],
    reason: str = "batch_modify",
    related_step: int = 0,
    verify: bool = True,
    auto_rollback: bool = True,
    run_lint: bool = False,
) -> List[ModifyResult]:
    return [
        safe_modify_file(path, content, reason, related_step, verify=verify, auto_rollback=auto_rollback, run_lint=run_lint)
        for path, content in changes
    ]


def safe_modify_summary(results: List[ModifyResult]) -> str:
    ok = sum(1 for item in results if item.success)
    failed = len(results) - ok
    lines = [f"Safe modify: {ok} succeeded, {failed} failed"]
    for item in results:
        status = "OK" if item.success else "FAIL"
        lines.append(f"- [{status}] {item.file_path}: {item.verification_status or item.error}")
    return "\n".join(lines)
