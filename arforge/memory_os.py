"""Governed Memory OS domain service over the existing memory projection."""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from arforge.database import (
    Memory,
    MemoryRelation,
    MemoryRetrievalEvent,
    MemoryRevision,
    get_session,
)
from arforge.security_guard import sanitize_for_storage


MEMORY_CLASSES = frozenset(
    {"episodic", "semantic", "procedural", "project", "user", "trajectory"}
)
MEMORY_LIFECYCLES = frozenset(
    {"candidate", "active", "superseded", "quarantined", "forgotten", "rejected"}
)
MEMORY_RELATION_TYPES = frozenset({"supports", "contradicts", "supersedes", "derived_from"})
MEMORY_RELATION_STATUSES = frozenset({"proposed", "confirmed", "rejected"})
_MUTABLE_FIELDS = frozenset(
    {
        "content",
        "mem_type",
        "tags",
        "importance",
        "source",
        "project_id",
        "workspace_path",
        "related_to",
        "strength",
        "review_level",
        "last_reviewed_at",
        "memory_class",
        "lifecycle",
        "confidence",
        "provenance",
    }
)


class MemoryOSError(RuntimeError):
    """Base Memory OS failure."""


class MemoryValidationError(MemoryOSError, ValueError):
    """A governed memory or mutation violates its contract."""


class MemoryConflictError(MemoryOSError):
    """An optimistic write used a stale projection version."""


class MemoryIntegrityError(MemoryOSError):
    """Revision history no longer matches its canonical digest chain."""


class MemoryNotFoundError(MemoryOSError, LookupError):
    """The requested memory does not exist."""


class MemoryPromotionError(MemoryOSError):
    """A cognitive run is not eligible to create durable memory candidates."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _digest_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _content_digest(content: str) -> str:
    return _digest_bytes(content.encode("utf-8"))


def memory_class_for_type(mem_type: str) -> str:
    """Map the compatibility domain type into a stable semantic class."""
    kind = str(mem_type or "knowledge").strip().casefold()
    if kind in {"preference", "identity"}:
        return "user"
    if kind in {"workflow", "constraint"}:
        return "procedural"
    if kind in {"convention", "project"}:
        return "project"
    if kind == "error":
        return "episodic"
    if kind == "trajectory":
        return "trajectory"
    return "semantic"


def memory_scope_id(project_id: str, workspace_path: str) -> str:
    """Return a stable privacy-minimized identifier for retrieval telemetry."""
    normalized_path = str(workspace_path or "").replace("\\", "/").rstrip("/").casefold()
    payload = {"project_id": str(project_id or ""), "workspace": normalized_path}
    return "scope:" + hashlib.sha256(_canonical(payload)).hexdigest()[:24]


def _provenance(value: Mapping[str, Any] | None) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise MemoryValidationError("provenance must be an object")
    original = dict(value)
    cleaned = sanitize_for_storage(original)
    safe_identifier = re.compile(r"[A-Za-z0-9_.:@/+-]{1,512}")
    identifier_keys = {
        "corrects_memory_uid",
        "evidence_ids",
        "signal_record_id",
        "source_event_checksum",
        "source_id",
        "source_run_id",
        "task_id",
        "verification_record_ids",
    }
    # Credential masking is intentionally broad and can mistake identifiers
    # such as ``task-promotion`` for an ``sk-`` key fragment. Restore only
    # tightly bounded identifier-shaped provenance fields; free text remains
    # sanitized recursively.
    for key in identifier_keys & original.keys():
        item = original[key]
        if isinstance(item, str) and safe_identifier.fullmatch(item):
            cleaned[key] = item
        elif isinstance(item, (list, tuple)) and all(
            isinstance(entry, str) and safe_identifier.fullmatch(entry) for entry in item
        ):
            cleaned[key] = list(item)
    try:
        encoded = _canonical(cleaned)
    except (TypeError, ValueError) as exc:
        raise MemoryValidationError(f"provenance is not canonical JSON: {exc}") from exc
    if len(encoded) > 16_384:
        raise MemoryValidationError("provenance exceeds 16384 bytes")
    return cleaned


def _validate_actor_reason(actor: str, reason: str) -> tuple[str, str]:
    clean_actor = str(actor or "").strip()
    clean_reason = sanitize_for_storage(str(reason or "")).strip()
    if not clean_actor or len(clean_actor) > 80:
        raise MemoryValidationError("actor must contain 1..80 characters")
    if len(clean_reason) > 4_000:
        raise MemoryValidationError("reason exceeds 4000 characters")
    return clean_actor, clean_reason


def _validate_projection(
    *,
    content: str,
    memory_class: str,
    lifecycle: str,
    confidence: float,
    importance: int,
    provenance: Mapping[str, Any] | None,
) -> tuple[str, str, str, float, int, dict[str, Any]]:
    cleaned_content = sanitize_for_storage(str(content or "")).strip()
    if not cleaned_content:
        raise MemoryValidationError("content must not be empty")
    if len(cleaned_content.encode("utf-8")) > 64 * 1024:
        raise MemoryValidationError("content exceeds 65536 bytes")
    clean_class = str(memory_class or "").strip().casefold()
    if clean_class not in MEMORY_CLASSES:
        raise MemoryValidationError(f"unknown memory_class {memory_class!r}")
    clean_lifecycle = str(lifecycle or "").strip().casefold()
    if clean_lifecycle not in MEMORY_LIFECYCLES:
        raise MemoryValidationError(f"unknown lifecycle {lifecycle!r}")
    try:
        clean_confidence = float(confidence)
    except (TypeError, ValueError) as exc:
        raise MemoryValidationError("confidence must be numeric") from exc
    if not 0.0 <= clean_confidence <= 1.0:
        raise MemoryValidationError("confidence must be between 0 and 1")
    try:
        clean_importance = int(importance)
    except (TypeError, ValueError) as exc:
        raise MemoryValidationError("importance must be an integer") from exc
    if not 1 <= clean_importance <= 5:
        raise MemoryValidationError("importance must be between 1 and 5")
    return (
        cleaned_content,
        clean_class,
        clean_lifecycle,
        clean_confidence,
        clean_importance,
        _provenance(provenance),
    )


def _memory_snapshot(memory: Memory) -> dict[str, Any]:
    return {
        "memory_uid": memory.memory_uid,
        "content": memory.content,
        "mem_type": memory.mem_type,
        "tags": memory.tags,
        "importance": memory.importance,
        "source": memory.source,
        "project_id": memory.project_id,
        "workspace_path": memory.workspace_path,
        "related_to": memory.related_to,
        "strength": memory.strength,
        "review_level": memory.review_level,
        "last_reviewed_at": memory.last_reviewed_at,
        "memory_class": memory.memory_class,
        "lifecycle": memory.lifecycle,
        "confidence": memory.confidence,
        "version": memory.version,
        "content_digest": memory.content_digest,
        "provenance": dict(memory.provenance or {}),
    }


def _memory_record(memory: Memory) -> dict[str, Any]:
    return {
        "id": int(memory.id),
        "created_at": memory.created_at,
        "updated_at": memory.updated_at,
        **_memory_snapshot(memory),
    }


def _revision_envelope(revision: MemoryRevision) -> dict[str, Any]:
    return {
        "memory_id": revision.memory_id,
        "memory_uid": revision.memory_uid,
        "version": revision.version,
        "created_at": revision.created_at,
        "operation": revision.operation,
        "actor": revision.actor,
        "reason": revision.reason,
        "source_run_id": revision.source_run_id,
        "source_event_sequence": revision.source_event_sequence,
        "snapshot": revision.snapshot,
        "content_digest": revision.content_digest,
        "previous_revision_digest": revision.previous_revision_digest,
    }


def _revision_record(revision: MemoryRevision) -> dict[str, Any]:
    return {"id": revision.id, **_revision_envelope(revision), "revision_digest": revision.revision_digest}


def _relation_record(relation: MemoryRelation) -> dict[str, Any]:
    return {
        "id": relation.id,
        "relation_uid": relation.relation_uid,
        "created_at": relation.created_at,
        "source_memory_id": relation.source_memory_id,
        "target_memory_id": relation.target_memory_id,
        "relation_type": relation.relation_type,
        "status": relation.status,
        "confidence": relation.confidence,
        "evidence": dict(relation.evidence or {}),
        "actor": relation.actor,
        "reason": relation.reason,
    }


class MemoryOS:
    """Transactional domain boundary for governed long-term memory."""

    def create(
        self,
        content: str,
        *,
        mem_type: str = "knowledge",
        tags: str = "",
        importance: int = 1,
        source: str = "user",
        related_to: str = "",
        project_id: str = "",
        workspace_path: str = "",
        memory_class: str | None = None,
        lifecycle: str = "active",
        confidence: float = 1.0,
        provenance: Mapping[str, Any] | None = None,
        actor: str = "user",
        reason: str = "created",
        _operation: str = "create",
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            memory = self._create_in_session(
                session,
                content,
                mem_type=mem_type,
                tags=tags,
                importance=importance,
                source=source,
                related_to=related_to,
                project_id=project_id,
                workspace_path=workspace_path,
                memory_class=memory_class,
                lifecycle=lifecycle,
                confidence=confidence,
                provenance=provenance,
                actor=actor,
                reason=reason,
                operation=_operation,
            )
            return _memory_record(memory)

    def _create_in_session(
        self,
        session: Any,
        content: str,
        *,
        mem_type: str,
        tags: str = "",
        importance: int,
        source: str,
        related_to: str = "",
        project_id: str,
        workspace_path: str,
        memory_class: str | None = None,
        lifecycle: str,
        confidence: float,
        provenance: Mapping[str, Any] | None,
        actor: str,
        reason: str,
        operation: str,
    ) -> Memory:
        """Insert a projection and first revision in the caller's transaction."""
        governed = _validate_projection(
            content=content,
            memory_class=memory_class or memory_class_for_type(mem_type),
            lifecycle=lifecycle,
            confidence=confidence,
            importance=importance,
            provenance=provenance,
        )
        clean_content, clean_class, clean_lifecycle, clean_confidence, clean_importance, clean_provenance = governed
        timestamp = _now()
        memory = Memory(
            created_at=timestamp,
            updated_at=timestamp,
            content=clean_content,
            mem_type=str(mem_type or "knowledge").strip().casefold(),
            tags=str(tags or ""),
            importance=clean_importance,
            source=str(source or "user"),
            project_id=str(project_id or ""),
            workspace_path=str(workspace_path or ""),
            related_to=str(related_to or ""),
            strength=1.0,
            review_level=0,
            last_reviewed_at="",
            memory_uid=uuid.uuid4().hex,
            memory_class=clean_class,
            lifecycle=clean_lifecycle,
            confidence=clean_confidence,
            version=1,
            content_digest=_content_digest(clean_content),
            provenance=clean_provenance,
        )
        session.add(memory)
        session.flush()
        self._append_revision(
            session,
            memory,
            operation=operation,
            actor=actor,
            reason=reason,
            previous_revision_digest="",
        )
        session.flush()
        return memory

    def promote_from_journal(
        self,
        journal: Any,
        *,
        project_id: str,
        workspace_path: str,
    ) -> list[dict[str, Any]]:
        """Create reviewable candidates from verified evidence-linked learning signals."""
        from arforge.core.cognitive_ir import Evidence, LearningSignal, Verification
        from arforge.core.cognitive_runtime import replay_cognitive_events

        events = journal.read_verified()
        if not events:
            raise MemoryPromotionError("verified journal is empty")
        task = replay_cognitive_events(events)
        if task.state.value not in {"completed", "rolled_back"}:
            raise MemoryPromotionError(
                f"run must be terminal before memory promotion, got {task.state.value!r}"
            )
        evidence = {
            record.record_id: record
            for record in task.records
            if isinstance(record, Evidence)
        }
        passed = [
            record
            for record in task.records
            if isinstance(record, Verification) and record.status == "passed"
        ]
        if not passed:
            raise MemoryPromotionError("promotion requires a passed verification")
        signals = [record for record in task.records if isinstance(record, LearningSignal)]
        eligible: list[tuple[LearningSignal, list[Verification]]] = []
        for signal in signals:
            if not signal.evidence_ids or any(item not in evidence for item in signal.evidence_ids):
                continue
            linked = [
                verification
                for verification in passed
                if set(verification.evidence_ids) & set(signal.evidence_ids)
            ]
            if not linked:
                continue
            if any(
                evidence[evidence_id].sensitivity in {"confidential", "restricted"}
                for evidence_id in signal.evidence_ids
            ):
                continue
            eligible.append((signal, linked))
        if not eligible:
            raise MemoryPromotionError(
                "promotion requires an evidence-linked learning signal and passed verification"
            )

        last_event = events[-1]
        candidates: list[dict[str, Any]] = []
        with get_session() as session:
            for signal, linked in sorted(
                eligible,
                key=lambda item: (-item[0].reward, item[0].record_id),
            ):
                provenance = {
                    "kind": "cognitive_promotion",
                    "source_run_id": journal.run_id,
                    "source_event_sequence": last_event.sequence,
                    "source_event_checksum": last_event.checksum,
                    "task_id": task.task_id,
                    "signal_record_id": signal.record_id,
                    "verification_record_ids": sorted(item.record_id for item in linked),
                    "evidence_ids": sorted(signal.evidence_ids),
                }
                existing = [
                    memory
                    for memory in session.query(Memory)
                    .filter(Memory.lifecycle.in_(("candidate", "active", "rejected")))
                    .all()
                    if isinstance(memory.provenance, dict)
                    and memory.provenance.get("source_run_id") == journal.run_id
                    and memory.provenance.get("signal_record_id") == signal.record_id
                    and memory.provenance.get("source_event_checksum") == last_event.checksum
                ]
                if existing:
                    candidates.append(_memory_record(existing[0]))
                    continue
                authorities = [evidence[evidence_id].authority for evidence_id in signal.evidence_ids]
                confidence = sum(authorities) / len(authorities)
                signal_type = signal.signal_type.casefold()
                mem_type = signal_type if signal_type in {
                    "preference",
                    "identity",
                    "fact",
                    "workflow",
                    "convention",
                    "constraint",
                } else "knowledge"
                memory = self._create_in_session(
                    session,
                    signal.outcome[:4_000],
                    mem_type=mem_type,
                    importance=4 if signal.reward >= 0.75 else 3,
                    source="runtime",
                    project_id=project_id,
                    workspace_path=workspace_path,
                    lifecycle="candidate",
                    confidence=confidence,
                    provenance=provenance,
                    actor="runtime:cognitive-promotion",
                    reason="verified Agent IR learning signal",
                    operation="promotion_candidate",
                )
                candidates.append(_memory_record(memory))
        return candidates

    def activate_candidate(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        return self._change_lifecycle(
            memory_id,
            expected_version=expected_version,
            expected_lifecycle="candidate",
            lifecycle="active",
            operation="activate",
            actor=actor,
            reason=reason,
        )

    def reject_candidate(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        return self._change_lifecycle(
            memory_id,
            expected_version=expected_version,
            expected_lifecycle="candidate",
            lifecycle="rejected",
            operation="reject",
            actor=actor,
            reason=reason,
        )

    def get(self, memory_id: int) -> dict[str, Any]:
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            return _memory_record(memory)

    def correct(
        self,
        memory_id: int,
        content: str,
        *,
        expected_version: int,
        actor: str,
        reason: str,
        provenance: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create an active successor and supersede the original atomically."""
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            original = session.get(Memory, int(memory_id))
            if original is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            if original.version != int(expected_version):
                raise MemoryConflictError(
                    f"expected version {expected_version}, actual {original.version} for memory {memory_id}"
                )
            if original.lifecycle != "active":
                raise MemoryValidationError(
                    f"only active memory can be corrected, got {original.lifecycle!r}"
                )
            correction_provenance = _provenance(provenance)
            correction_provenance["corrects_memory_uid"] = original.memory_uid
            governed = _validate_projection(
                content=content,
                memory_class=original.memory_class,
                lifecycle="active",
                confidence=original.confidence,
                importance=original.importance,
                provenance=correction_provenance,
            )
            clean_content, clean_class, _, clean_confidence, clean_importance, clean_provenance = governed
            timestamp = _now()
            successor = Memory(
                created_at=timestamp,
                updated_at=timestamp,
                content=clean_content,
                mem_type=original.mem_type,
                tags=original.tags,
                importance=clean_importance,
                source="user-corrected" if actor.startswith("user") else original.source,
                project_id=original.project_id,
                workspace_path=original.workspace_path,
                related_to=original.related_to,
                strength=1.0,
                review_level=original.review_level,
                last_reviewed_at=original.last_reviewed_at,
                memory_uid=uuid.uuid4().hex,
                memory_class=clean_class,
                lifecycle="active",
                confidence=clean_confidence,
                version=1,
                content_digest=_content_digest(clean_content),
                provenance=clean_provenance,
            )
            session.add(successor)
            session.flush()
            self._append_revision(
                session,
                successor,
                operation="correction",
                actor=actor,
                reason=reason,
                previous_revision_digest="",
            )

            previous = self._latest_or_backfill(session, original)
            original.lifecycle = "superseded"
            original.version += 1
            original.updated_at = timestamp
            self._append_revision(
                session,
                original,
                operation="supersede",
                actor=actor,
                reason=reason,
                previous_revision_digest=previous.revision_digest,
            )
            self._add_relation(
                session,
                source_memory_id=successor.id,
                target_memory_id=original.id,
                relation_type="supersedes",
                status="confirmed",
                confidence=1.0,
                evidence={"source_revision": 1, "target_revision": original.version},
                actor=actor,
                reason=reason,
            )
            session.flush()
            return _memory_record(successor)

    def relate(
        self,
        source_memory_id: int,
        target_memory_id: int,
        *,
        relation_type: str,
        status: str = "proposed",
        confidence: float = 1.0,
        evidence: Mapping[str, Any] | None = None,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            if session.get(Memory, int(source_memory_id)) is None:
                raise MemoryNotFoundError(f"memory {source_memory_id} was not found")
            if session.get(Memory, int(target_memory_id)) is None:
                raise MemoryNotFoundError(f"memory {target_memory_id} was not found")
            relation = self._add_relation(
                session,
                source_memory_id=int(source_memory_id),
                target_memory_id=int(target_memory_id),
                relation_type=relation_type,
                status=status,
                confidence=confidence,
                evidence=evidence,
                actor=actor,
                reason=reason,
            )
            session.flush()
            return _relation_record(relation)

    def relations(self, *, memory_id: int) -> list[dict[str, Any]]:
        with get_session() as session:
            rows = (
                session.query(MemoryRelation)
                .filter(
                    (MemoryRelation.source_memory_id == int(memory_id))
                    | (MemoryRelation.target_memory_id == int(memory_id))
                )
                .order_by(MemoryRelation.id.asc())
                .all()
            )
            return [_relation_record(row) for row in rows]

    def forget(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        return self._change_lifecycle(
            memory_id,
            expected_version=expected_version,
            expected_lifecycle="active",
            lifecycle="forgotten",
            operation="forget",
            actor=actor,
            reason=reason,
        )

    def restore(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        return self._change_lifecycle(
            memory_id,
            expected_version=expected_version,
            expected_lifecycle="forgotten",
            lifecycle="active",
            operation="restore",
            actor=actor,
            reason=reason,
        )

    def quarantine(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            if memory.version != int(expected_version):
                raise MemoryConflictError(
                    f"expected version {expected_version}, actual {memory.version} for memory {memory_id}"
                )
            if memory.lifecycle != "active":
                raise MemoryValidationError(
                    f"quarantine requires 'active', got {memory.lifecycle!r}"
                )
            previous = self._latest_or_backfill(session, memory)
            if not str(memory.source).casefold().startswith("quarantined:"):
                memory.source = f"quarantined:{memory.source}"
            reason_tag = f"quarantine:{reason}"
            tags = [tag.strip() for tag in str(memory.tags or "").split(",") if tag.strip()]
            if reason_tag not in tags:
                tags.append(reason_tag)
            memory.tags = ",".join(tags)
            memory.lifecycle = "quarantined"
            memory.importance = 1
            memory.strength = 0.1
            memory.version += 1
            memory.updated_at = _now()
            self._append_revision(
                session,
                memory,
                operation="quarantine",
                actor=actor,
                reason=reason,
                previous_revision_digest=previous.revision_digest,
            )
            session.flush()
            return _memory_record(memory)

    def restore_quarantined(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            if memory.version != int(expected_version):
                raise MemoryConflictError(
                    f"expected version {expected_version}, actual {memory.version} for memory {memory_id}"
                )
            if memory.lifecycle != "quarantined":
                raise MemoryValidationError(
                    f"restore_quarantined requires 'quarantined', got {memory.lifecycle!r}"
                )
            previous = self._latest_or_backfill(session, memory)
            source = str(memory.source)
            memory.source = source.split(":", 1)[1] if source.casefold().startswith("quarantined:") else source
            memory.lifecycle = "active"
            memory.strength = max(0.5, memory.strength)
            memory.version += 1
            memory.updated_at = _now()
            self._append_revision(
                session,
                memory,
                operation="restore",
                actor=actor,
                reason=reason,
                previous_revision_digest=previous.revision_digest,
            )
            session.flush()
            return _memory_record(memory)

    def decay(self, *, factor: float = 0.99, floor: float = 0.1) -> int:
        """Revision automatic/model memories without weakening explicit user data."""
        if not 0.0 < float(factor) <= 1.0:
            raise MemoryValidationError("decay factor must be between 0 and 1")
        if not 0.0 <= float(floor) <= 1.0:
            raise MemoryValidationError("decay floor must be between 0 and 1")
        updated = 0
        with get_session() as session:
            memories = (
                session.query(Memory)
                .filter(Memory.lifecycle == "active")
                .filter(Memory.source.in_(("auto", "model")))
                .order_by(Memory.id.asc())
                .all()
            )
            for memory in memories:
                new_strength = max(float(floor), float(memory.strength) * float(factor))
                if new_strength == memory.strength:
                    continue
                previous = self._latest_or_backfill(session, memory)
                memory.strength = new_strength
                memory.version += 1
                memory.updated_at = _now()
                self._append_revision(
                    session,
                    memory,
                    operation="decay",
                    actor="runtime:decay",
                    reason=f"factor={factor};floor={floor}",
                    previous_revision_digest=previous.revision_digest,
                )
                updated += 1
            session.flush()
        return updated

    def delete(self, memory_id: int, *, actor: str, reason: str) -> dict[str, Any]:
        """Explicit privacy deletion, including retained identity references."""
        actor, reason = _validate_actor_reason(actor, reason)
        del actor, reason  # Authorization/audit is performed by the calling surface.
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                return {"memory_id": int(memory_id), "deleted": False}
            retrieval_updates = 0
            for retrieval in session.query(MemoryRetrievalEvent).all():
                returned = [
                    item
                    for item in list(retrieval.returned or [])
                    if not self._returned_references_memory(item, memory.id)
                ]
                feedback = self._remove_feedback_reference(dict(retrieval.feedback or {}), memory.id)
                if returned != retrieval.returned or feedback != retrieval.feedback:
                    retrieval.returned = returned
                    retrieval.feedback = feedback
                    retrieval_updates += 1
            relations_deleted = (
                session.query(MemoryRelation)
                .filter(
                    (MemoryRelation.source_memory_id == memory.id)
                    | (MemoryRelation.target_memory_id == memory.id)
                )
                .delete(synchronize_session=False)
            )
            revisions_deleted = (
                session.query(MemoryRevision)
                .filter(MemoryRevision.memory_id == memory.id)
                .delete(synchronize_session=False)
            )
            session.delete(memory)
            return {
                "memory_id": int(memory_id),
                "deleted": True,
                "revisions_deleted": int(revisions_deleted),
                "relations_deleted": int(relations_deleted),
                "retrieval_events_redacted": retrieval_updates,
            }

    def recall(
        self,
        query: str,
        *,
        project_id: str,
        workspace_path: str,
        top_k: int = 10,
        min_score: float = 0.05,
        limit: int = 500,
    ) -> dict[str, Any]:
        """Rank active scoped memory and record bounded actual-recall telemetry."""
        from arforge.memory import query_memories_for_scope
        from arforge.semantic_memory import SemanticIndex

        normalized_query = " ".join(str(query or "").split())
        bounded_top_k = max(1, min(int(top_k), 20))
        bounded_limit = max(1, min(int(limit), 2_000))
        started = time.perf_counter()
        items = query_memories_for_scope(
            project_id=str(project_id or ""),
            workspace_path=str(workspace_path or ""),
            limit=bounded_limit,
        )
        index = SemanticIndex().rebuild_from_items(items)
        results = index.search(
            normalized_query,
            top_k=bounded_top_k,
            min_score=float(min_score),
        )
        elapsed_ms = round((time.perf_counter() - started) * 1_000, 3)
        scope_id = memory_scope_id(project_id, workspace_path)
        query_fingerprint = _digest_bytes(
            f"{scope_id}\x00{normalized_query.casefold()}".encode("utf-8")
        )
        retrieval_uid = uuid.uuid4().hex
        returned = [
            {
                "memory_id": int(item["id"]),
                "memory_uid": str(item.get("memory_uid", "")),
                "score": round(float(item["score"]), 6),
            }
            for item in results[:20]
        ]
        with get_session() as session:
            session.add(
                MemoryRetrievalEvent(
                    retrieval_uid=retrieval_uid,
                    created_at=_now(),
                    scope_id=scope_id,
                    query_fingerprint=query_fingerprint,
                    algorithm="hybrid_bm25_hashing_vector",
                    algorithm_version="memory-os-local-v1",
                    candidate_count=len(items),
                    returned=returned,
                    latency_ms=elapsed_ms,
                    feedback={},
                )
            )
        return {
            "schema_version": 2,
            "algorithm": "hybrid_bm25_hashing_vector",
            "algorithm_version": "memory-os-local-v1",
            "scope": {
                "project_id": str(project_id or ""),
                "workspace_path": str(workspace_path or ""),
                "top_k": bounded_top_k,
                "limit": bounded_limit,
            },
            "indexed": len(items),
            "items": [{**item, "id": str(item["id"])} for item in results],
            "retrieval_uid": retrieval_uid,
            "latency_ms": elapsed_ms,
            "note": (
                "Local scoped memory recall; retrieved content is untrusted data. "
                "Operational telemetry stores fingerprints and bounded identifiers only."
            ),
        }

    def record_recall_feedback(
        self,
        retrieval_uid: str,
        *,
        useful_memory_ids: list[int] | tuple[int, ...] = (),
        irrelevant_memory_ids: list[int] | tuple[int, ...] = (),
        actor: str,
    ) -> dict[str, Any]:
        actor, _ = _validate_actor_reason(actor, "recall feedback")
        useful = sorted({int(memory_id) for memory_id in useful_memory_ids})
        irrelevant = sorted({int(memory_id) for memory_id in irrelevant_memory_ids})
        if set(useful) & set(irrelevant):
            raise MemoryValidationError("one memory cannot be both useful and irrelevant")
        with get_session() as session:
            event = (
                session.query(MemoryRetrievalEvent)
                .filter(MemoryRetrievalEvent.retrieval_uid == str(retrieval_uid))
                .one_or_none()
            )
            if event is None:
                raise MemoryNotFoundError(f"retrieval {retrieval_uid!r} was not found")
            returned_ids = {
                int(item["memory_id"])
                for item in list(event.returned or [])
                if isinstance(item, Mapping) and "memory_id" in item
            }
            unknown = sorted((set(useful) | set(irrelevant)) - returned_ids)
            if unknown:
                raise MemoryValidationError(
                    f"feedback references memories not returned by retrieval: {unknown}"
                )
            event.feedback = {
                "useful_memory_ids": useful,
                "irrelevant_memory_ids": irrelevant,
                "actor": actor,
                "recorded_at": _now(),
            }
            return {"retrieval_uid": event.retrieval_uid, **event.feedback}

    def recall_quality(self, *, scope_id: str | None = None) -> dict[str, Any]:
        """Aggregate actual-recall telemetry separately from synthetic benchmarks."""
        with get_session() as session:
            query = session.query(MemoryRetrievalEvent)
            if scope_id is not None:
                query = query.filter(MemoryRetrievalEvent.scope_id == scope_id)
            events = query.order_by(MemoryRetrievalEvent.id.asc()).all()
            all_ids = {
                int(item["memory_id"])
                for event in events
                for item in list(event.returned or [])
                if isinstance(item, Mapping) and "memory_id" in item
            }
            states = {
                memory.id: memory.lifecycle
                for memory in session.query(Memory).filter(Memory.id.in_(all_ids)).all()
            } if all_ids else {}
            contradiction_pairs = {
                frozenset((relation.source_memory_id, relation.target_memory_id))
                for relation in session.query(MemoryRelation)
                .filter(MemoryRelation.relation_type == "contradicts")
                .filter(MemoryRelation.status.in_(("proposed", "confirmed")))
                .all()
            }

            returned_total = 0
            stale_total = 0
            empty = 0
            feedback_count = 0
            useful_feedback = 0
            conflicting_events = 0
            for event in events:
                ids = [
                    int(item["memory_id"])
                    for item in list(event.returned or [])
                    if isinstance(item, Mapping) and "memory_id" in item
                ]
                returned_total += len(ids)
                if not ids:
                    empty += 1
                stale_total += sum(states.get(memory_id) != "active" for memory_id in ids)
                feedback = dict(event.feedback or {})
                if feedback:
                    feedback_count += 1
                    if feedback.get("useful_memory_ids"):
                        useful_feedback += 1
                pairs = {
                    frozenset((left, right))
                    for index, left in enumerate(ids)
                    for right in ids[index + 1 :]
                }
                if contradiction_pairs & pairs:
                    conflicting_events += 1

        recalls = len(events)
        return {
            "schema_version": 1,
            "measurement": "actual_recall",
            "scope_id": scope_id or "all",
            "recalls": recalls,
            "empty_recall_rate": round(empty / recalls, 4) if recalls else 0.0,
            "mean_returned_count": round(returned_total / recalls, 4) if recalls else 0.0,
            "feedback_coverage": round(feedback_count / recalls, 4) if recalls else 0.0,
            "useful_recall_rate": (
                round(useful_feedback / feedback_count, 4) if feedback_count else 0.0
            ),
            "stale_or_inactive_recall_rate": (
                round(stale_total / returned_total, 4) if returned_total else 0.0
            ),
            "conflicting_recall_rate": (
                round(conflicting_events / recalls, 4) if recalls else 0.0
            ),
            "synthetic_self_recall": False,
        }

    def update(
        self,
        memory_id: int,
        *,
        expected_version: int,
        actor: str = "user",
        reason: str = "updated",
        **fields: Any,
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        unknown = sorted(set(fields) - _MUTABLE_FIELDS)
        if unknown:
            raise MemoryValidationError(f"unknown update fields: {unknown}")
        if not fields:
            raise MemoryValidationError("at least one update field is required")
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            if memory.version != int(expected_version):
                raise MemoryConflictError(
                    f"expected version {expected_version}, actual {memory.version} for memory {memory_id}"
                )
            candidate = _memory_snapshot(memory)
            candidate.update(fields)
            if "mem_type" in fields and "memory_class" not in fields:
                candidate["memory_class"] = memory_class_for_type(str(fields["mem_type"]))
            governed = _validate_projection(
                content=candidate["content"],
                memory_class=candidate["memory_class"],
                lifecycle=candidate["lifecycle"],
                confidence=candidate["confidence"],
                importance=candidate["importance"],
                provenance=candidate["provenance"],
            )
            clean_content, clean_class, clean_lifecycle, clean_confidence, clean_importance, clean_provenance = governed
            previous = self._latest_or_backfill(session, memory)
            for name, value in fields.items():
                if name not in {"content", "memory_class", "lifecycle", "confidence", "importance", "provenance"}:
                    setattr(memory, name, value)
            memory.content = clean_content
            memory.memory_class = clean_class
            memory.lifecycle = clean_lifecycle
            memory.confidence = clean_confidence
            memory.importance = clean_importance
            memory.provenance = clean_provenance
            memory.content_digest = _content_digest(clean_content)
            memory.version += 1
            memory.updated_at = _now()
            self._append_revision(
                session,
                memory,
                operation="update",
                actor=actor,
                reason=reason,
                previous_revision_digest=previous.revision_digest,
            )
            session.flush()
            return _memory_record(memory)

    def history(self, memory_id: int) -> list[dict[str, Any]]:
        with get_session() as session:
            if session.get(Memory, int(memory_id)) is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            revisions = (
                session.query(MemoryRevision)
                .filter(MemoryRevision.memory_id == int(memory_id))
                .order_by(MemoryRevision.version.asc())
                .all()
            )
            return [_revision_record(revision) for revision in revisions]

    def verify_history(self, memory_id: int) -> dict[str, Any]:
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            revisions = (
                session.query(MemoryRevision)
                .filter(MemoryRevision.memory_id == memory.id)
                .order_by(MemoryRevision.version.asc())
                .all()
            )
            if not revisions:
                raise MemoryIntegrityError(f"memory {memory_id} has no revision history")
            previous_digest = ""
            for expected_version, revision in enumerate(revisions, start=1):
                if revision.version != expected_version:
                    raise MemoryIntegrityError(
                        f"memory {memory_id} version {expected_version} sequence mismatch"
                    )
                if revision.previous_revision_digest != previous_digest:
                    raise MemoryIntegrityError(
                        f"memory {memory_id} version {expected_version} previous digest mismatch"
                    )
                snapshot_content = str((revision.snapshot or {}).get("content", ""))
                if revision.content_digest != _content_digest(snapshot_content):
                    raise MemoryIntegrityError(
                        f"memory {memory_id} version {expected_version} content digest mismatch"
                    )
                calculated = _digest_bytes(_canonical(_revision_envelope(revision)))
                if revision.revision_digest != calculated:
                    raise MemoryIntegrityError(
                        f"memory {memory_id} version {expected_version} revision digest mismatch"
                    )
                previous_digest = revision.revision_digest
            if memory.version != revisions[-1].version or _memory_snapshot(memory) != revisions[-1].snapshot:
                raise MemoryIntegrityError(
                    f"memory {memory_id} current projection does not match version {revisions[-1].version}"
                )
            return {
                "memory_id": memory.id,
                "memory_uid": memory.memory_uid,
                "versions": len(revisions),
                "valid": True,
                "current_version": memory.version,
            }

    def _backfill_legacy_revision(self, session: Any, memory: Memory) -> MemoryRevision:
        original_version = memory.version
        memory.version = 1
        revision = self._append_revision(
            session,
            memory,
            operation="legacy_import",
            actor="runtime:migration",
            reason="first governed touch",
            previous_revision_digest="",
        )
        memory.version = max(1, original_version)
        session.flush()
        return revision

    def _latest_or_backfill(self, session: Any, memory: Memory) -> MemoryRevision:
        previous = (
            session.query(MemoryRevision)
            .filter(MemoryRevision.memory_id == memory.id)
            .order_by(MemoryRevision.version.desc())
            .first()
        )
        return previous or self._backfill_legacy_revision(session, memory)

    def _change_lifecycle(
        self,
        memory_id: int,
        *,
        expected_version: int,
        expected_lifecycle: str,
        lifecycle: str,
        operation: str,
        actor: str,
        reason: str,
    ) -> dict[str, Any]:
        actor, reason = _validate_actor_reason(actor, reason)
        with get_session() as session:
            memory = session.get(Memory, int(memory_id))
            if memory is None:
                raise MemoryNotFoundError(f"memory {memory_id} was not found")
            if memory.version != int(expected_version):
                raise MemoryConflictError(
                    f"expected version {expected_version}, actual {memory.version} for memory {memory_id}"
                )
            if memory.lifecycle != expected_lifecycle:
                raise MemoryValidationError(
                    f"{operation} requires {expected_lifecycle!r}, got {memory.lifecycle!r}"
                )
            previous = self._latest_or_backfill(session, memory)
            memory.lifecycle = lifecycle
            memory.version += 1
            memory.updated_at = _now()
            self._append_revision(
                session,
                memory,
                operation=operation,
                actor=actor,
                reason=reason,
                previous_revision_digest=previous.revision_digest,
            )
            session.flush()
            return _memory_record(memory)

    def _add_relation(
        self,
        session: Any,
        *,
        source_memory_id: int,
        target_memory_id: int,
        relation_type: str,
        status: str,
        confidence: float,
        evidence: Mapping[str, Any] | None,
        actor: str,
        reason: str,
    ) -> MemoryRelation:
        if source_memory_id == target_memory_id:
            raise MemoryValidationError("a memory cannot relate to itself")
        clean_type = str(relation_type or "").strip().casefold()
        if clean_type not in MEMORY_RELATION_TYPES:
            raise MemoryValidationError(f"unknown relation_type {relation_type!r}")
        clean_status = str(status or "").strip().casefold()
        if clean_status not in MEMORY_RELATION_STATUSES:
            raise MemoryValidationError(f"unknown relation status {status!r}")
        try:
            clean_confidence = float(confidence)
        except (TypeError, ValueError) as exc:
            raise MemoryValidationError("relation confidence must be numeric") from exc
        if not 0.0 <= clean_confidence <= 1.0:
            raise MemoryValidationError("relation confidence must be between 0 and 1")
        relation = MemoryRelation(
            relation_uid=uuid.uuid4().hex,
            created_at=_now(),
            source_memory_id=source_memory_id,
            target_memory_id=target_memory_id,
            relation_type=clean_type,
            status=clean_status,
            confidence=clean_confidence,
            evidence=_provenance(evidence),
            actor=actor,
            reason=reason,
        )
        session.add(relation)
        return relation

    @staticmethod
    def _returned_references_memory(value: Any, memory_id: int) -> bool:
        if not isinstance(value, Mapping):
            return False
        candidate = value.get("memory_id", value.get("id"))
        return candidate == memory_id or str(candidate) == str(memory_id)

    @staticmethod
    def _remove_feedback_reference(value: Any, memory_id: int) -> Any:
        if isinstance(value, list):
            return [
                MemoryOS._remove_feedback_reference(item, memory_id)
                for item in value
                if item != memory_id and str(item) != str(memory_id)
            ]
        if isinstance(value, dict):
            return {
                key: MemoryOS._remove_feedback_reference(item, memory_id)
                for key, item in value.items()
                if not (
                    key in {"memory_id", "id"}
                    and (item == memory_id or str(item) == str(memory_id))
                )
            }
        return value

    def _append_revision(
        self,
        session: Any,
        memory: Memory,
        *,
        operation: str,
        actor: str,
        reason: str,
        previous_revision_digest: str,
    ) -> MemoryRevision:
        provenance = dict(memory.provenance or {})
        source_event_sequence = provenance.get("source_event_sequence", -1)
        try:
            source_event_sequence = int(source_event_sequence)
        except (TypeError, ValueError) as exc:
            raise MemoryValidationError("provenance.source_event_sequence must be an integer") from exc
        revision = MemoryRevision(
            memory_id=memory.id,
            memory_uid=memory.memory_uid,
            version=memory.version,
            created_at=memory.updated_at,
            operation=operation,
            actor=actor,
            reason=reason,
            source_run_id=str(provenance.get("source_run_id", ""))[:256],
            source_event_sequence=source_event_sequence,
            snapshot=_memory_snapshot(memory),
            content_digest=memory.content_digest,
            previous_revision_digest=previous_revision_digest,
            revision_digest="",
        )
        revision.revision_digest = _digest_bytes(_canonical(_revision_envelope(revision)))
        session.add(revision)
        return revision


__all__ = [
    "MEMORY_CLASSES",
    "MEMORY_LIFECYCLES",
    "MEMORY_RELATION_STATUSES",
    "MEMORY_RELATION_TYPES",
    "MemoryConflictError",
    "MemoryIntegrityError",
    "MemoryNotFoundError",
    "MemoryOS",
    "MemoryOSError",
    "MemoryPromotionError",
    "MemoryValidationError",
    "memory_class_for_type",
    "memory_scope_id",
]
