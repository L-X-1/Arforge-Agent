"""Unified structured conversation message model for Machine Bridge.

The agent's final visible answer must never be contaminated with internal
reasoning XML, tool logs, or scratchpad text. This module defines the typed
payload that travels through the Bridge streaming protocol and is persisted by
``BridgeStateStore``.

A ``MessagePayload`` is split into four orthogonal channels:

* ``content``      — the only text the user sees as the answer body.
* ``reasoning``    — collapsible reasoning sections (understanding / thinking /
                     evidence / reflection). Never rendered into ``content``.
* ``tool_events``  — structured tool-call / file-write / approval / error records.
* ``artifacts``    — generated files with path, MIME, size, source.

Storage layer (``BridgeStateStore``) serializes the channels into separate JSON
columns (``reasoning_json`` / ``tool_events_json`` / ``artifacts_json``) so they
can be searched, replayed, and resumed independently of the answer body. Legacy
rows that predate the columns (or whose ``reasoning_json`` is empty) are migrated
on read by parsing any XML that leaked into ``content``.
"""

from __future__ import annotations

import json
import mimetypes
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

# Reasoning section keys shown to the UI/CLI in a stable order. These mirror the
# XML tags produced by ``arforge.reasoning.parser`` so the collapsible panel and
# the parser stay in sync.
REASONING_SECTIONS: tuple[tuple[str, str], ...] = (
    ("understanding", "理解"),
    ("thinking", "推理"),
    ("evidence", "证据"),
    ("reflection", "自检"),
)

VALID_MESSAGE_STATES = frozenset({"streaming", "complete", "error", "cancelled"})

_DETERMINISTIC_ARTIFACT_MIME = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def infer_artifact_mime(path: str | Path) -> str:
    """Return stable artifact MIME metadata independent of the host registry."""
    name = Path(path).name
    deterministic = _DETERMINISTIC_ARTIFACT_MIME.get(Path(name).suffix.casefold())
    return deterministic or mimetypes.guess_type(name)[0] or "application/octet-stream"


@dataclass
class ToolEvent:
    """One structured record of a tool call, file write, approval, or error."""

    kind: str  # tool | file.write | approval | error
    tool_name: str = ""
    status: str = "started"  # started | completed | failed | rejected
    target_path: str = ""
    summary: str = ""
    error: str = ""
    created_at: str = ""
    sequence: int = 0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        # Drop empty optional fields to keep payloads compact for storage/UI.
        return {key: value for key, value in data.items() if value != "" and value != 0 or key in {"kind", "status"}}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ToolEvent":
        return cls(
            kind=str(data.get("kind", "tool")),
            tool_name=str(data.get("tool_name", "")),
            status=str(data.get("status", "started")),
            target_path=str(data.get("target_path", "")),
            summary=str(data.get("summary", "")),
            error=str(data.get("error", "")),
            created_at=str(data.get("created_at", "")),
            sequence=int(data.get("sequence", 0) or 0),
        )


@dataclass
class Artifact:
    """A file produced by the agent (file.write / diff / tool side effect)."""

    artifact_id: str
    path: str
    mime: str = "text/plain"
    size_bytes: int = 0
    created_at: str = ""
    source: str = "file.write"  # file.write | diff | tool | user_message
    display_name: str = ""
    is_image: bool = False
    sha256: str = ""

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if not self.display_name:
            data.pop("display_name")
        if not self.is_image:
            data.pop("is_image")
        if not self.sha256:
            data.pop("sha256")
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Artifact":
        path = str(data.get("path", ""))
        supplied_mime = str(data.get("mime", "")).strip()
        mime = supplied_mime or infer_artifact_mime(path)
        return cls(
            artifact_id=str(data.get("artifact_id", "")),
            path=path,
            mime=mime,
            size_bytes=int(data.get("size_bytes", 0) or 0),
            created_at=str(data.get("created_at", "")),
            source=str(data.get("source", "file.write")),
            display_name=str(data.get("display_name", "")),
            is_image=bool(data.get("is_image", mime.startswith("image/"))),
            sha256=str(data.get("sha256", "")),
        )


@dataclass
class DeliveryMetadata:
    """Classification for a primary user-visible message delivery."""

    status: str = "normal"
    sent_at: str = ""
    attachment_count: int = 0
    local_only: bool = True

    def __post_init__(self) -> None:
        if self.status not in {"normal", "proactive"}:
            raise ValueError(f"invalid delivery status: {self.status!r}")
        if self.attachment_count < 0:
            raise ValueError("attachment_count must not be negative")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> "DeliveryMetadata | None":
        if not isinstance(data, dict) or not data:
            return None
        status = str(data.get("status", "normal") or "normal")
        if status not in {"normal", "proactive"}:
            status = "normal"
        return cls(
            status=status,
            sent_at=str(data.get("sent_at", "") or ""),
            attachment_count=max(0, int(data.get("attachment_count", 0) or 0)),
            local_only=bool(data.get("local_only", True)),
        )


@dataclass
class ReasoningPayload:
    """Collapsible reasoning sections. Empty sections are still allowed so the
    protocol stays uniform (``reasoning.completed`` is always emitted even for
    simple greetings that carry no reasoning)."""

    understanding: str = ""
    thinking: str = ""
    evidence: str = ""
    reflection: str = ""

    @property
    def section_count(self) -> int:
        """Number of non-empty sections, for the collapsed summary line."""
        return sum(1 for value in (self.understanding, self.thinking, self.evidence, self.reflection) if value.strip())

    @property
    def is_empty(self) -> bool:
        return self.section_count == 0

    def to_dict(self) -> dict[str, str]:
        return {
            "understanding": self.understanding,
            "thinking": self.thinking,
            "evidence": self.evidence,
            "reflection": self.reflection,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ReasoningPayload":
        if not isinstance(data, dict):
            return cls()
        return cls(
            understanding=str(data.get("understanding", "") or ""),
            thinking=str(data.get("thinking", "") or ""),
            evidence=str(data.get("evidence", "") or ""),
            reflection=str(data.get("reflection", "") or ""),
        )

    @classmethod
    def from_reasoning_result(cls, result: Any) -> "ReasoningPayload":
        """Build from an ``arforge.reasoning.ReasoningResult`` (which may be None)."""
        if result is None:
            return cls()
        return cls(
            understanding=getattr(result, "understanding", "") or "",
            thinking=getattr(result, "thinking", "") or "",
            evidence=getattr(result, "evidence", "") or "",
            reflection=getattr(result, "reflection", "") or "",
        )


@dataclass
class MessagePayload:
    """The full structured message: the answer plus three collapsible channels."""

    content: str = ""
    reasoning: ReasoningPayload = field(default_factory=ReasoningPayload)
    tool_events: list[ToolEvent] = field(default_factory=list)
    artifacts: list[Artifact] = field(default_factory=list)
    delivery: DeliveryMetadata | None = None
    state: str = "complete"

    def __post_init__(self) -> None:
        if self.state not in VALID_MESSAGE_STATES:
            raise ValueError(f"invalid message state: {self.state!r}")

    def to_storage(self) -> dict[str, str]:
        """Split into the flat columns persisted by ``BridgeStateStore``.

        ``content`` holds only the final answer. The other three channels are
        JSON-encoded so the store can index/trim them independently.
        """
        return {
            "content": self.content,
            "reasoning_json": _dump_json(self.reasoning.to_dict()) if not self.reasoning.is_empty else "",
            "tool_events_json": _dump_json([event.to_dict() for event in self.tool_events]) if self.tool_events else "",
            "artifacts_json": _dump_json([artifact.to_dict() for artifact in self.artifacts]) if self.artifacts else "",
            "delivery_json": _dump_json(self.delivery.to_dict()) if self.delivery is not None else "",
            "state": self.state,
        }

    @staticmethod
    def from_storage(row: dict[str, Any]) -> "MessagePayload":
        """Reconstruct from a stored row, migrating legacy content-as-XML rows.

        If ``reasoning_json`` is empty but ``content`` still contains reasoning
        XML tags (older messages written before the split), parse the XML so the
        collapsible panel can show the historical reasoning and the answer body
        stays clean.
        """
        content = str(row.get("content", "") or "")
        state = str(row.get("state", "complete") or "complete")
        reasoning = ReasoningPayload.from_dict(_load_json(row.get("reasoning_json")))
        tool_events = [ToolEvent.from_dict(item) for item in _load_json(row.get("tool_events_json"))]
        artifacts = [Artifact.from_dict(item) for item in _load_json(row.get("artifacts_json"))]
        delivery = DeliveryMetadata.from_dict(_load_json(row.get("delivery_json")))

        # Legacy migration: old rows stored the whole XML response in content.
        if reasoning.is_empty and _looks_like_xml(content):
            parsed = _parse_legacy_xml(content)
            if parsed["reasoning"].section_count:
                reasoning = parsed["reasoning"]
                content = parsed["content"]
        return MessagePayload(
            content=content,
            reasoning=reasoning,
            tool_events=tool_events,
            artifacts=artifacts,
            delivery=delivery,
            state=state,
        )

    def to_completed_event(self, *, meta: dict[str, Any] | None = None, usage: Any = None) -> dict[str, Any]:
        """Shape the ``operation.completed`` payload sent to the bridge client."""
        return {
            "answer": self.content,
            "reasoning": self.reasoning.to_dict(),
            "tool_events": [event.to_dict() for event in self.tool_events],
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            "delivery": self.delivery.to_dict() if self.delivery is not None else None,
            "meta": dict(meta or {}),
            "usage": usage,
        }


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------


def _dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load_json(value: Any) -> Any:
    if not value:
        return [] if isinstance(value, (list,)) or value in (None, "") else {}
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return []


_LEGACY_TAGS = ("understanding", "thinking", "evidence", "reflection", "answer")


def _looks_like_xml(text: str) -> bool:
    return any(f"<{tag}>" in text.lower() or f"<{tag} " in text.lower() for tag in _LEGACY_TAGS)


def _parse_legacy_xml(content: str) -> dict[str, Any]:
    """Parse a legacy XML-laden content blob into clean answer + reasoning."""
    from arforge.reasoning import parse_reasoning

    parsed = parse_reasoning(content)
    reasoning = ReasoningPayload(
        understanding=parsed.understanding,
        thinking=parsed.thinking,
        evidence=parsed.evidence,
        reflection=parsed.reflection,
    )
    # Prefer the parsed <answer> when present; otherwise strip the known tags
    # from the raw text so the user never sees raw XML.
    if parsed.answer and parsed.parse_success:
        clean = parsed.answer
    else:
        clean = _strip_known_tags(content)
    return {"content": clean, "reasoning": reasoning}


def _strip_known_tags(text: str) -> str:
    import re

    cleaned = text
    for tag in _LEGACY_TAGS:
        cleaned = re.sub(rf"<{tag}\b[^>]*>[\s\S]*?</{tag}\s*>", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(rf"<{tag}\b[^>]*/?>", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(rf"</{tag}\s*>", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def merge_tool_events(existing: Iterable[ToolEvent], new: Iterable[ToolEvent]) -> list[ToolEvent]:
    """Append new tool events without duplicating by (kind, target_path, sequence)."""
    seen = {(event.kind, event.target_path, event.sequence) for event in existing}
    merged = list(existing)
    for event in new:
        key = (event.kind, event.target_path, event.sequence)
        if key not in seen:
            seen.add(key)
            merged.append(event)
    return merged
