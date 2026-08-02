"""Persistent fine-grained permission rules.

G14 extends the existing mode/category matrix with auditable remembered
decisions. The module is intentionally independent from the runtime decider at
first, so existing tool execution behaviour does not change until an explicit
integration point consumes these rules.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from arforge.paths import data_path

_SAFE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,191}$")
_DECISIONS = {"allow_once", "allow_always", "deny_always"}


@dataclass(frozen=True)
class PermissionRule:
    rule_id: str
    subject: str
    category: str
    scope: str
    decision: str
    reason: str
    created_at: str
    expires_at: str | None = None
    revoked_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def active(self) -> bool:
        if self.revoked_at:
            return False
        if self.expires_at and self.expires_at <= _now():
            return False
        return True


def rules_path() -> Path:
    return data_path("state", "permission_rules.json")


def add_rule(
    *,
    subject: str,
    category: str,
    scope: str = "workspace",
    decision: str,
    reason: str = "",
    ttl_seconds: int | None = None,
    path: Path | None = None,
) -> PermissionRule:
    problems = validate_rule(subject=subject, category=category, scope=scope, decision=decision)
    if problems:
        raise ValueError("; ".join(problems))
    now = _now()
    expires_at = _format_time(time.time() + ttl_seconds) if ttl_seconds and ttl_seconds > 0 else None
    rule = PermissionRule(
        rule_id=f"perm_{uuid.uuid4().hex[:16]}",
        subject=subject,
        category=category,
        scope=scope,
        decision=decision,
        reason=reason[:500],
        created_at=now,
        expires_at=expires_at,
    )
    rows = [item for item in load_rules(path=path) if item.active]
    rows.append(rule)
    _save_rules(rows, path=path)
    return rule


def list_rules(*, include_inactive: bool = False, path: Path | None = None) -> dict[str, Any]:
    rows = load_rules(path=path)
    if not include_inactive:
        rows = [item for item in rows if item.active]
    return {
        "count": len(rows),
        "items": [item.to_dict() | {"active": item.active} for item in rows],
        "path": str((path or rules_path()).resolve()),
    }


def revoke_rule(rule_id: str, *, path: Path | None = None) -> PermissionRule | None:
    rows = load_rules(path=path)
    revoked: PermissionRule | None = None
    next_rows: list[PermissionRule] = []
    for item in rows:
        if item.rule_id == rule_id and not item.revoked_at:
            revoked = PermissionRule(**(item.to_dict() | {"revoked_at": _now()}))
            next_rows.append(revoked)
        else:
            next_rows.append(item)
    if revoked is not None:
        _save_rules(next_rows, path=path)
    return revoked


def match_rule(*, subject: str, category: str, scope: str = "workspace", path: Path | None = None) -> PermissionRule | None:
    for item in reversed(load_rules(path=path)):
        if not item.active:
            continue
        if item.subject not in {subject, "*"}:
            continue
        if item.category not in {category, "*"}:
            continue
        if item.scope not in {scope, "*"}:
            continue
        return item


def match_any_rule(
    *,
    subjects: list[str] | tuple[str, ...],
    category: str,
    scope: str = "workspace",
    path: Path | None = None,
) -> PermissionRule | None:
    """Return the newest active rule matching any subject in priority order."""
    candidates = [subject for subject in subjects if subject]
    for item in reversed(load_rules(path=path)):
        if not item.active:
            continue
        if item.category not in {category, "*"}:
            continue
        if item.scope not in {scope, "*"}:
            continue
        if item.subject == "*" or item.subject in candidates:
            return item
    return None
    return None


def load_rules(*, path: Path | None = None) -> list[PermissionRule]:
    target = path or rules_path()
    if not target.is_file():
        return []
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(raw, list):
        return []
    rows: list[PermissionRule] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            rows.append(
                PermissionRule(
                    rule_id=str(item.get("rule_id", "")),
                    subject=str(item.get("subject", "")),
                    category=str(item.get("category", "")),
                    scope=str(item.get("scope", "workspace")),
                    decision=str(item.get("decision", "")),
                    reason=str(item.get("reason", "")),
                    created_at=str(item.get("created_at", "")),
                    expires_at=item.get("expires_at"),
                    revoked_at=item.get("revoked_at"),
                )
            )
        except TypeError:
            continue
    return rows


def validate_rule(*, subject: str, category: str, scope: str, decision: str) -> list[str]:
    problems: list[str] = []
    for field, value in {"subject": subject, "category": category, "scope": scope}.items():
        if not value or not _SAFE.match(value):
            problems.append(f"{field} has invalid characters")
    if decision not in _DECISIONS:
        problems.append(f"decision must be one of {', '.join(sorted(_DECISIONS))}")
    return problems


def _save_rules(rows: list[PermissionRule], *, path: Path | None = None) -> None:
    target = path or rules_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(
        json.dumps([item.to_dict() for item in rows], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp.replace(target)


def _now() -> str:
    return _format_time(time.time())


def _format_time(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))
