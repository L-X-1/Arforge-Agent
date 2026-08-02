"""Unified entity model schemas — single source of truth for all Arforge domain objects.

Entity coverage per the enterprise architecture plan:
  Project, Session, AgentRun, Turn, Step, ToolCall, Approval,
  DiffAction, Task, Skill, SubagentRole, Memory, LearningOutcome,
  EvalCase, ReleaseEvidence
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── Project ──────────────────────────────────────────────────────────────────


@dataclass
class ProjectEntity:
    """An Arforge-instrumented workspace directory."""

    project_id: str
    root: Path
    rules: list[str] = field(default_factory=list)
    trust_state: str = "untrusted"  # untrusted | trusted
    last_seen: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "root": str(self.root),
            "rules": self.rules,
            "trust_state": self.trust_state,
            "last_seen": self.last_seen,
        }


# ── Session ──────────────────────────────────────────────────────────────────


@dataclass
class SessionEntity:
    """A resumable human–agent conversation."""

    session_id: str
    project_id: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    status: str = "active"  # active | completed | interrupted
    context_available: bool = True
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "project_id": self.project_id,
            "message_count": len(self.messages),
            "status": self.status,
            "context_available": self.context_available,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# ── AgentRun ─────────────────────────────────────────────────────────────────


@dataclass
class AgentRunEntity:
    """One execution span triggered by a user request."""

    run_id: str
    session_id: str
    mode: str = "auto"  # auto | plan | chat
    status: str = "created"  # created | running | completed | incomplete | failed | interrupted
    started_at: str = ""
    ended_at: str = ""
    max_steps: int = 25
    permission_mode: str = "autoApprove"

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "session_id": self.session_id,
            "mode": self.mode,
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "max_steps": self.max_steps,
            "permission_mode": self.permission_mode,
        }


# ── Turn ─────────────────────────────────────────────────────────────────────


@dataclass
class TurnEntity:
    """One logical execution round: model call + optional tool execution."""

    turn_id: str
    run_id: str
    input: str = ""
    model_usage: dict[str, Any] = field(default_factory=dict)
    stop_reason: str = ""
    budget_remaining: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "run_id": self.run_id,
            "input": self.input[:200],
            "model_usage": self.model_usage,
            "stop_reason": self.stop_reason,
            "budget_remaining": self.budget_remaining,
        }


# ── Step ─────────────────────────────────────────────────────────────────────


@dataclass
class StepEntity:
    """A fine-grained observable step: plan | tool | verify | compact | report."""

    step_id: str
    run_id: str
    kind: str  # plan | tool | verify | compact | report
    state: str = "pending"  # pending | running | completed | failed
    summary: str = ""
    evidence_ref: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_id": self.step_id,
            "run_id": self.run_id,
            "kind": self.kind,
            "state": self.state,
            "summary": self.summary,
            "evidence_ref": self.evidence_ref,
        }


# ── ToolCall ─────────────────────────────────────────────────────────────────


@dataclass
class ToolCallEntity:
    """One tool preparation → approval → execution → result cycle."""

    tool_id: str
    run_id: str
    name: str
    args_hash: str = ""
    risk: str = "low"  # low | medium | high | critical
    approval_id: str = ""
    result_ref: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "run_id": self.run_id,
            "name": self.name,
            "args_hash": self.args_hash,
            "risk": self.risk,
            "approval_id": self.approval_id,
            "result_ref": self.result_ref,
        }


# ── Approval ─────────────────────────────────────────────────────────────────


@dataclass
class ApprovalEntity:
    """User decision on a pending action."""

    approval_id: str
    action_id: str
    status: str = "pending"  # pending | approved | denied | expired | invalidated
    decision: str = ""
    expires_at: str = ""
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "approval_id": self.approval_id,
            "action_id": self.action_id,
            "status": self.status,
            "decision": self.decision,
            "expires_at": self.expires_at,
            "created_at": self.created_at,
        }


# ── DiffAction ───────────────────────────────────────────────────────────────


@dataclass
class DiffActionEntity:
    """A file modification with hash guard, apply, and rollback."""

    path: Path
    before_hash: str = ""
    after_hash: str = ""
    state: str = "previewed"  # previewed | approved | applied | rolled_back
    rollback_ref: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "before_hash": self.before_hash,
            "after_hash": self.after_hash,
            "state": self.state,
            "rollback_ref": self.rollback_ref,
        }


# ── Task ─────────────────────────────────────────────────────────────────────


@dataclass
class TaskEntity:
    """A background async or deferred execution unit."""

    task_id: str
    owner_session: str
    sequence: int = 0
    status: str = "queued"  # queued | running | completed | failed | cancelled
    side_effects_possible: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "owner_session": self.owner_session,
            "sequence": self.sequence,
            "status": self.status,
            "side_effects_possible": self.side_effects_possible,
        }


# ── Skill ────────────────────────────────────────────────────────────────────


@dataclass
class SkillEntity:
    """A reusable workflow packaged with metadata and resources."""

    skill_id: str
    version: str = "1.0.0"
    source: str = ""  # filesystem path or registry URI
    enabled: bool = True
    entry: str = ""  # SKILL.md path
    resources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill_id,
            "version": self.version,
            "source": self.source,
            "enabled": self.enabled,
            "entry": self.entry,
            "resources": self.resources,
        }


# ── SubagentRole ─────────────────────────────────────────────────────────────


@dataclass
class SubagentRoleEntity:
    """Contract that defines a subagent's capabilities and boundaries."""

    role_id: str
    tools: list[str] = field(default_factory=list)
    permission_scope: str = "workspace"  # read_only | workspace | full
    prompt_contract: str = ""  # system prompt for the role
    evals: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "role_id": self.role_id,
            "tools": self.tools,
            "permission_scope": self.permission_scope,
            "prompt_contract": self.prompt_contract[:200],
            "evals": self.evals,
        }


# ── Memory ───────────────────────────────────────────────────────────────────


@dataclass
class MemoryEntity:
    """A cross-session learnable fact, preference, or pattern."""

    memory_id: str
    project_id: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    source: str = ""  # dogfood | user | inference
    confidence: float = 0.0  # 0.0 – 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "memory_id": self.memory_id,
            "project_id": self.project_id,
            "content": self.content[:300],
            "tags": self.tags,
            "source": self.source,
            "confidence": self.confidence,
        }


# ── LearningOutcome ──────────────────────────────────────────────────────────


@dataclass
class LearningOutcomeEntity:
    """A pattern extracted from real task outcomes for continuous improvement."""

    outcome_id: str
    success: bool = True
    failure_type: str = ""  # tool_error | loop_stuck | budget_exhausted | user_corrected
    tool_pattern: str = ""  # which tools were involved
    impact: str = ""  # what changed as a result of learning

    def to_dict(self) -> dict[str, Any]:
        return {
            "outcome_id": self.outcome_id,
            "success": self.success,
            "failure_type": self.failure_type,
            "tool_pattern": self.tool_pattern,
            "impact": self.impact,
        }


# ── EvalCase ─────────────────────────────────────────────────────────────────


@dataclass
class EvalCaseEntity:
    """A fixed evaluation task with reproducible assertions."""

    case_id: str
    fixture: str = ""  # path to fixture directory
    prompt: str = ""
    assertions: list[str] = field(default_factory=list)
    score: float = 0.0  # 0.0 – 1.0


    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "fixture": self.fixture,
            "prompt": self.prompt[:200],
            "score": self.score,
        }


# ── ReleaseEvidence ──────────────────────────────────────────────────────────


@dataclass
class ReleaseEvidenceEntity:
    """Immutable proof artifact for a release gate decision."""

    gate_id: str
    artifact_id: str = ""
    sha256: str = ""
    reviewer: str = ""
    captured_at: str = ""
    status: str = "pending"  # pending | passed | failed

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_id": self.gate_id,
            "artifact_id": self.artifact_id,
            "sha256": self.sha256,
            "reviewer": self.reviewer,
            "captured_at": self.captured_at,
            "status": self.status,
        }


# ── Entity registry ──────────────────────────────────────────────────────────

# Map of entity name → dataclass, for schema introspection from Bridge / CLI
ENTITY_REGISTRY: dict[str, type] = {
    "project": ProjectEntity,
    "session": SessionEntity,
    "agent_run": AgentRunEntity,
    "turn": TurnEntity,
    "step": StepEntity,
    "tool_call": ToolCallEntity,
    "approval": ApprovalEntity,
    "diff_action": DiffActionEntity,
    "task": TaskEntity,
    "skill": SkillEntity,
    "subagent_role": SubagentRoleEntity,
    "memory": MemoryEntity,
    "learning_outcome": LearningOutcomeEntity,
    "eval_case": EvalCaseEntity,
    "release_evidence": ReleaseEvidenceEntity,
}


def describe_entity(name: str) -> dict[str, Any] | None:
    """Return schema metadata for a named entity."""
    cls = ENTITY_REGISTRY.get(name)
    if cls is None:
        return None
    fields = []
    for f_name, f_def in cls.__dataclass_fields__.items():
        fields.append({
            "name": f_name,
            "type": str(f_def.type),
            "default": repr(f_def.default) if f_def.default is not f_def.default_factory else "...",
        })
    return {"entity": name, "fields": fields, "doc": (cls.__doc__ or "").strip()}
