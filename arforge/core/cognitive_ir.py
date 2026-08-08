"""Agent IR V2: deterministic semantic state for governed Arforge runs.

The model may propose records, but this module owns their validation and stable
serialization.  It intentionally uses only the standard library so persisted
documents do not inherit a third-party validation library's upgrade semantics.
"""

from __future__ import annotations

import enum
import hashlib
import json
import math
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, ClassVar, Mapping, TypeVar


IR_SCHEMA_VERSION = "2.0"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_JSON_SCALARS = (str, int, float, bool, type(None))


def utc_now() -> str:
    """Return an RFC 3339 UTC timestamp with a stable ``Z`` suffix."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class IRValidationError(ValueError):
    """A deterministic, path-addressed Agent IR validation failure."""

    def __init__(self, path: str, detail: str) -> None:
        self.path = path
        self.detail = detail
        super().__init__(f"{path}: {detail}")


class LifecycleState(str, enum.Enum):
    CREATED = "created"
    UNDERSTANDING = "understanding"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPACTING = "compacting"
    BLOCKED = "blocked"
    WAITING_APPROVAL = "waiting_approval"
    LEARNING = "learning"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"


class RiskLevel(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


def canonical_json_bytes(value: Any) -> bytes:
    """Return UTF-8 canonical JSON suitable for hashing and replay equality."""
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise IRValidationError("document", f"is not canonical-JSON serializable: {exc}") from exc
    return encoded.encode("utf-8")


def _validate_identifier(value: str, path: str) -> None:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise IRValidationError(
            path,
            "must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        )


def _validate_text(value: str, path: str, *, max_length: int = 20_000) -> None:
    if not isinstance(value, str) or not value.strip():
        raise IRValidationError(path, "must be a non-empty string")
    if len(value) > max_length:
        raise IRValidationError(path, f"must not exceed {max_length} characters")


def _validate_unit(value: float, path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise IRValidationError(path, "must be a number in the inclusive range 0..1")
    if not math.isfinite(float(value)) or not 0.0 <= float(value) <= 1.0:
        raise IRValidationError(path, "must be in the inclusive range 0..1")


def _validate_reward(value: float, path: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise IRValidationError(path, "must be a number in the inclusive range -1..1")
    if not math.isfinite(float(value)) or not -1.0 <= float(value) <= 1.0:
        raise IRValidationError(path, "must be in the inclusive range -1..1")


def _validate_extensions(value: Mapping[str, Any], path: str) -> None:
    if not isinstance(value, Mapping):
        raise IRValidationError(path, "must be a mapping")
    for key in value:
        if not isinstance(key, str) or not key.strip():
            raise IRValidationError(path, "extension keys must be non-empty strings")
    canonical_json_bytes(dict(value))


def _as_tuple(value: Any, path: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise IRValidationError(path, "must be an array")
    return tuple(str(item) for item in value)


def _extensions(data: Mapping[str, Any], known: set[str]) -> dict[str, Any]:
    explicit = data.get("extensions", {})
    if not isinstance(explicit, Mapping):
        raise IRValidationError("extensions", "must be a mapping")
    result = dict(explicit)
    unknown = {key: value for key, value in data.items() if key not in known}
    if unknown:
        existing = result.get("_unknown", {})
        if not isinstance(existing, Mapping):
            raise IRValidationError("extensions._unknown", "must be a mapping")
        result["_unknown"] = {**dict(existing), **unknown}
    return result


@dataclass(frozen=True, kw_only=True)
class CognitiveRecord:
    """Base for typed Agent IR records."""

    kind: ClassVar[str] = "record"
    record_id: str
    status: str = "active"
    created_at: str = field(default_factory=utc_now)
    extensions: dict[str, Any] = field(default_factory=dict)

    def validate(self, path: str) -> None:
        _validate_identifier(self.record_id, f"{path}.record_id")
        _validate_text(self.status, f"{path}.status", max_length=64)
        _validate_text(self.created_at, f"{path}.created_at", max_length=64)
        _validate_extensions(self.extensions, f"{path}.extensions")

    def _base_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "record_id": self.record_id,
            "status": self.status,
            "created_at": self.created_at,
            "extensions": self.extensions,
        }

    def to_dict(self) -> dict[str, Any]:
        return self._base_dict()


@dataclass(frozen=True, kw_only=True)
class Goal(CognitiveRecord):
    kind: ClassVar[str] = "goal"
    description: str
    success_criteria: tuple[str, ...] = ()
    priority: int = 3
    status: str = "pending"

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.description, f"{path}.description")
        if isinstance(self.priority, bool) or not isinstance(self.priority, int) or not 1 <= self.priority <= 5:
            raise IRValidationError(f"{path}.priority", "must be an integer in the range 1..5")
        for index, criterion in enumerate(self.success_criteria):
            _validate_text(criterion, f"{path}.success_criteria[{index}]")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "description": self.description,
            "success_criteria": list(self.success_criteria),
            "priority": self.priority,
        }


@dataclass(frozen=True, kw_only=True)
class Evidence(CognitiveRecord):
    kind: ClassVar[str] = "evidence"
    summary: str
    source: str
    evidence_type: str = "observation"
    authority: float = 0.5
    sensitivity: str = "internal"
    digest: str = ""

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.summary, f"{path}.summary")
        _validate_text(self.source, f"{path}.source", max_length=2_000)
        _validate_text(self.evidence_type, f"{path}.evidence_type", max_length=64)
        _validate_unit(self.authority, f"{path}.authority")
        if self.sensitivity not in {"public", "internal", "confidential", "restricted"}:
            raise IRValidationError(f"{path}.sensitivity", "has an unknown governed value")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "summary": self.summary,
            "source": self.source,
            "evidence_type": self.evidence_type,
            "authority": self.authority,
            "sensitivity": self.sensitivity,
            "digest": self.digest,
        }


@dataclass(frozen=True, kw_only=True)
class Belief(CognitiveRecord):
    kind: ClassVar[str] = "belief"
    statement: str
    confidence: float
    evidence_ids: tuple[str, ...] = ()

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.statement, f"{path}.statement")
        _validate_unit(self.confidence, f"{path}.confidence")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "statement": self.statement,
            "confidence": self.confidence,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, kw_only=True)
class Hypothesis(CognitiveRecord):
    kind: ClassVar[str] = "hypothesis"
    statement: str
    confidence: float
    evidence_ids: tuple[str, ...] = ()
    status: str = "proposed"

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.statement, f"{path}.statement")
        _validate_unit(self.confidence, f"{path}.confidence")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "statement": self.statement,
            "confidence": self.confidence,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, kw_only=True)
class Action(CognitiveRecord):
    kind: ClassVar[str] = "action"
    action_type: str
    target: str
    expected_information: str = ""
    risk_level: str = RiskLevel.LOW.value
    estimated_cost: float = 0.0
    arguments: dict[str, Any] = field(default_factory=dict)
    status: str = "proposed"

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.action_type, f"{path}.action_type", max_length=128)
        _validate_text(self.target, f"{path}.target", max_length=4_000)
        if self.expected_information:
            _validate_text(self.expected_information, f"{path}.expected_information")
        try:
            RiskLevel(self.risk_level)
        except ValueError as exc:
            raise IRValidationError(f"{path}.risk_level", "has an unknown governed value") from exc
        if (
            isinstance(self.estimated_cost, bool)
            or not isinstance(self.estimated_cost, (int, float))
            or not math.isfinite(float(self.estimated_cost))
            or float(self.estimated_cost) < 0.0
        ):
            raise IRValidationError(f"{path}.estimated_cost", "must be a finite non-negative number")
        canonical_json_bytes(self.arguments)

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "action_type": self.action_type,
            "target": self.target,
            "expected_information": self.expected_information,
            "risk_level": self.risk_level,
            "estimated_cost": self.estimated_cost,
            "arguments": self.arguments,
        }


@dataclass(frozen=True, kw_only=True)
class Observation(CognitiveRecord):
    kind: ClassVar[str] = "observation"
    action_id: str
    summary: str
    success: bool
    evidence_ids: tuple[str, ...] = ()

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_identifier(self.action_id, f"{path}.action_id")
        _validate_text(self.summary, f"{path}.summary")
        if not isinstance(self.success, bool):
            raise IRValidationError(f"{path}.success", "must be a boolean")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "action_id": self.action_id,
            "summary": self.summary,
            "success": self.success,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, kw_only=True)
class Decision(CognitiveRecord):
    kind: ClassVar[str] = "decision"
    statement: str
    rationale: str
    evidence_ids: tuple[str, ...] = ()
    reversible: bool = True

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.statement, f"{path}.statement")
        _validate_text(self.rationale, f"{path}.rationale")
        if not isinstance(self.reversible, bool):
            raise IRValidationError(f"{path}.reversible", "must be a boolean")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "statement": self.statement,
            "rationale": self.rationale,
            "evidence_ids": list(self.evidence_ids),
            "reversible": self.reversible,
        }


@dataclass(frozen=True, kw_only=True)
class Verification(CognitiveRecord):
    kind: ClassVar[str] = "verification"
    criterion: str
    verifier: str
    evidence_ids: tuple[str, ...] = ()
    status: str = "pending"

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.criterion, f"{path}.criterion")
        _validate_text(self.verifier, f"{path}.verifier", max_length=256)
        if self.status not in {"pending", "passed", "failed", "waived"}:
            raise IRValidationError(f"{path}.status", "has an unknown governed value")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "criterion": self.criterion,
            "verifier": self.verifier,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, kw_only=True)
class LearningSignal(CognitiveRecord):
    kind: ClassVar[str] = "learning_signal"
    signal_type: str
    outcome: str
    reward: float
    evidence_ids: tuple[str, ...] = ()

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.signal_type, f"{path}.signal_type", max_length=128)
        _validate_text(self.outcome, f"{path}.outcome")
        _validate_reward(self.reward, f"{path}.reward")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "signal_type": self.signal_type,
            "outcome": self.outcome,
            "reward": self.reward,
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, kw_only=True)
class EvolutionProposal(CognitiveRecord):
    kind: ClassVar[str] = "evolution_proposal"
    target_component: str
    change_summary: str
    hypothesis: str
    eval_case_ids: tuple[str, ...] = ()
    risk_level: str = RiskLevel.MEDIUM.value
    status: str = "candidate"

    def validate(self, path: str) -> None:
        super().validate(path)
        _validate_text(self.target_component, f"{path}.target_component", max_length=256)
        _validate_text(self.change_summary, f"{path}.change_summary")
        _validate_text(self.hypothesis, f"{path}.hypothesis")
        try:
            RiskLevel(self.risk_level)
        except ValueError as exc:
            raise IRValidationError(f"{path}.risk_level", "has an unknown governed value") from exc
        for index, case_id in enumerate(self.eval_case_ids):
            _validate_identifier(case_id, f"{path}.eval_case_ids[{index}]")

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._base_dict(),
            "target_component": self.target_component,
            "change_summary": self.change_summary,
            "hypothesis": self.hypothesis,
            "eval_case_ids": list(self.eval_case_ids),
            "risk_level": self.risk_level,
        }


RecordT = TypeVar("RecordT", bound=CognitiveRecord)
_RECORD_TYPES: dict[str, type[CognitiveRecord]] = {
    cls.kind: cls
    for cls in (
        Goal,
        Evidence,
        Belief,
        Hypothesis,
        Action,
        Observation,
        Decision,
        Verification,
        LearningSignal,
        EvolutionProposal,
    )
}

_RECORD_COLLECTIONS = {
    "hypothesis": "hypotheses",
    "evidence": "evidence",
}


def _record_path(record: CognitiveRecord) -> str:
    collection = _RECORD_COLLECTIONS.get(record.kind, f"{record.kind}s")
    return f"{collection}[{record.record_id}]"


def record_from_dict(data: Mapping[str, Any]) -> CognitiveRecord:
    """Load one typed record while retaining explicit forward extensions."""
    if not isinstance(data, Mapping):
        raise IRValidationError("records", "each record must be a mapping")
    kind = str(data.get("kind", ""))
    cls = _RECORD_TYPES.get(kind)
    if cls is None:
        raise IRValidationError("records.kind", f"unknown record kind {kind!r}")

    common = {"kind", "record_id", "status", "created_at", "extensions"}
    fields_by_kind = {
        "goal": {"description", "success_criteria", "priority"},
        "evidence": {"summary", "source", "evidence_type", "authority", "sensitivity", "digest"},
        "belief": {"statement", "confidence", "evidence_ids"},
        "hypothesis": {"statement", "confidence", "evidence_ids"},
        "action": {"action_type", "target", "expected_information", "risk_level", "estimated_cost", "arguments"},
        "observation": {"action_id", "summary", "success", "evidence_ids"},
        "decision": {"statement", "rationale", "evidence_ids", "reversible"},
        "verification": {"criterion", "verifier", "evidence_ids"},
        "learning_signal": {"signal_type", "outcome", "reward", "evidence_ids"},
        "evolution_proposal": {"target_component", "change_summary", "hypothesis", "eval_case_ids", "risk_level"},
    }
    known = common | fields_by_kind[kind]
    kwargs = {key: value for key, value in data.items() if key in known and key != "kind"}
    kwargs["extensions"] = _extensions(data, known)
    for tuple_field in ("success_criteria", "evidence_ids", "eval_case_ids"):
        if tuple_field in kwargs:
            kwargs[tuple_field] = _as_tuple(kwargs[tuple_field], f"{kind}.{tuple_field}")
    try:
        return cls(**kwargs)
    except TypeError as exc:
        record_id = data.get("record_id", "?")
        raise IRValidationError(f"{kind}s[{record_id}]", f"invalid record shape: {exc}") from exc


@dataclass(frozen=True)
class AgentTaskIR:
    """Immutable Agent IR task projection.

    Mutator-style helpers return a new validated revision, which makes event
    projection and checkpoint comparison deterministic.
    """

    task_id: str
    objective: str
    state: LifecycleState = LifecycleState.CREATED
    records: tuple[CognitiveRecord, ...] = ()
    revision: int = 0
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)
    schema_version: str = IR_SCHEMA_VERSION
    extensions: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def create(
        cls,
        objective: str,
        *,
        task_id: str,
        created_at: str | None = None,
        extensions: Mapping[str, Any] | None = None,
    ) -> "AgentTaskIR":
        timestamp = created_at or utc_now()
        task = cls(
            task_id=task_id,
            objective=objective,
            created_at=timestamp,
            updated_at=timestamp,
            extensions=dict(extensions or {}),
        )
        task.validate()
        return task

    def record(self, record_id: str) -> CognitiveRecord:
        for item in self.records:
            if item.record_id == record_id:
                return item
        raise KeyError(record_id)

    def with_record(self, record: CognitiveRecord, *, updated_at: str | None = None) -> "AgentTaskIR":
        if any(item.record_id == record.record_id for item in self.records):
            raise IRValidationError(f"records[{record.record_id}]", "duplicate record identifier")
        candidate = replace(
            self,
            records=(*self.records, record),
            revision=self.revision + 1,
            updated_at=updated_at or utc_now(),
        )
        candidate.validate()
        return candidate

    def with_state(
        self,
        state: LifecycleState | str,
        *,
        updated_at: str | None = None,
    ) -> "AgentTaskIR":
        try:
            normalized = state if isinstance(state, LifecycleState) else LifecycleState(state)
        except ValueError as exc:
            raise IRValidationError("state", f"unknown lifecycle state {state!r}") from exc
        candidate = replace(
            self,
            state=normalized,
            revision=self.revision + 1,
            updated_at=updated_at or utc_now(),
        )
        candidate.validate()
        return candidate

    def validate(self) -> None:
        if self.schema_version != IR_SCHEMA_VERSION:
            raise IRValidationError("schema_version", f"unsupported value {self.schema_version!r}")
        _validate_identifier(self.task_id, "task_id")
        _validate_text(self.objective, "objective")
        if not isinstance(self.state, LifecycleState):
            raise IRValidationError("state", "must be a LifecycleState")
        if isinstance(self.revision, bool) or not isinstance(self.revision, int) or self.revision < 0:
            raise IRValidationError("revision", "must be a non-negative integer")
        _validate_text(self.created_at, "created_at", max_length=64)
        _validate_text(self.updated_at, "updated_at", max_length=64)
        _validate_extensions(self.extensions, "extensions")

        by_id: dict[str, CognitiveRecord] = {}
        for item in self.records:
            path = _record_path(item)
            if item.record_id in by_id:
                raise IRValidationError(f"records[{item.record_id}]", "duplicate record identifier")
            item.validate(path)
            by_id[item.record_id] = item

        for item in self.records:
            path = _record_path(item)
            evidence_ids = getattr(item, "evidence_ids", ())
            for evidence_id in evidence_ids:
                target = by_id.get(evidence_id)
                if not isinstance(target, Evidence):
                    raise IRValidationError(
                        f"{path}.evidence_ids",
                        f"references missing evidence {evidence_id!r}",
                    )
            if isinstance(item, Observation):
                target = by_id.get(item.action_id)
                if not isinstance(target, Action):
                    raise IRValidationError(
                        f"{path}.action_id",
                        f"references missing action {item.action_id!r}",
                    )

    def to_dict(self) -> dict[str, Any]:
        self.validate()
        return {
            "schema_version": self.schema_version,
            "task_id": self.task_id,
            "objective": self.objective,
            "state": self.state.value,
            "revision": self.revision,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "records": [record.to_dict() for record in self.records],
            "extensions": self.extensions,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentTaskIR":
        if not isinstance(data, Mapping):
            raise IRValidationError("document", "must be a mapping")
        known = {
            "schema_version",
            "task_id",
            "objective",
            "state",
            "revision",
            "created_at",
            "updated_at",
            "records",
            "extensions",
        }
        raw_records = data.get("records", [])
        if not isinstance(raw_records, list):
            raise IRValidationError("records", "must be an array")
        try:
            state = LifecycleState(str(data.get("state", LifecycleState.CREATED.value)))
        except ValueError as exc:
            raise IRValidationError("state", f"unknown lifecycle state {data.get('state')!r}") from exc
        try:
            task = cls(
                schema_version=str(data.get("schema_version", "")),
                task_id=str(data.get("task_id", "")),
                objective=str(data.get("objective", "")),
                state=state,
                revision=data.get("revision", 0),
                created_at=str(data.get("created_at", "")),
                updated_at=str(data.get("updated_at", "")),
                records=tuple(record_from_dict(item) for item in raw_records),
                extensions=_extensions(data, known),
            )
        except TypeError as exc:
            raise IRValidationError("document", f"invalid task shape: {exc}") from exc
        task.validate()
        return task

    def canonical_bytes(self) -> bytes:
        return canonical_json_bytes(self.to_dict())

    def digest(self) -> str:
        return f"sha256:{hashlib.sha256(self.canonical_bytes()).hexdigest()}"


__all__ = [
    "IR_SCHEMA_VERSION",
    "Action",
    "AgentTaskIR",
    "Belief",
    "CognitiveRecord",
    "Decision",
    "Evidence",
    "EvolutionProposal",
    "Goal",
    "Hypothesis",
    "IRValidationError",
    "LearningSignal",
    "LifecycleState",
    "Observation",
    "RiskLevel",
    "Verification",
    "canonical_json_bytes",
    "record_from_dict",
    "utc_now",
]
