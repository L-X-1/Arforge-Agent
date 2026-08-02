"""Validated, file-backed multi-step workflow execution.

Workflow definitions are deliberately data-only JSON files.  They cannot
contain shell commands, imports, or executable expressions; each step is sent
to the existing agentic runner only after an explicit execution request.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from arforge.paths import data_path
from arforge.security_guard import sanitize_for_storage

_MAX_WORKFLOW_BYTES = 256 * 1024
_MAX_STEPS = 20
_MAX_PROMPT_LENGTH = 8_000
_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_STEP_KINDS = {"agent", "approval", "checkpoint"}
_CONDITION_STATUSES = {"completed", "failed", "skipped", "approved", "rejected"}
_ACCESS_MODES = {"read", "write", "none"}


class WorkflowValidationError(ValueError):
    """Raised when an untrusted workflow definition violates the DSL contract."""


@dataclass(frozen=True)
class WorkflowStepDefinition:
    """One agent task and its dependency identifiers."""

    id: str
    prompt: str
    title: str
    depends_on: tuple[str, ...] = ()
    continue_on_error: bool = False
    kind: str = "agent"
    max_attempts: int = 1
    when_step: str = ""
    when_statuses: tuple[str, ...] = ()
    access: str = "write"


@dataclass(frozen=True)
class WorkflowDefinition:
    """Versioned file-backed workflow definition."""

    name: str
    steps: tuple[WorkflowStepDefinition, ...]
    description: str = ""
    schema_version: int = 1
    source_path: str = ""


@dataclass
class WorkflowStepResult:
    id: str
    title: str
    status: str
    output: str = ""
    error: str = ""


@dataclass
class WorkflowRunReport:
    name: str
    source_path: str
    success: bool
    dry_run: bool
    steps: list[WorkflowStepResult] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return sanitize_for_storage(asdict(self))


def _require_string(value: Any, field_name: str, *, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowValidationError(f"{field_name} must be a non-empty string")
    result = value.strip()
    if len(result) > maximum:
        raise WorkflowValidationError(f"{field_name} must be at most {maximum} characters")
    return result


def _require_identifier(value: Any, field_name: str) -> str:
    result = _require_string(value, field_name, maximum=64)
    if not _IDENTIFIER.fullmatch(result):
        raise WorkflowValidationError(
            f"{field_name} must use lowercase letters, digits, hyphens, or underscores"
        )
    return result


def parse_workflow(data: Any, *, source_path: Path | None = None) -> WorkflowDefinition:
    """Parse a JSON-compatible mapping into a validated workflow definition."""
    if not isinstance(data, dict):
        raise WorkflowValidationError("workflow root must be an object")
    allowed_root = {"schema_version", "name", "description", "steps"}
    unexpected = set(data) - allowed_root
    if unexpected:
        raise WorkflowValidationError(f"unsupported workflow fields: {', '.join(sorted(unexpected))}")
    schema_version = data.get("schema_version", 1)
    if schema_version not in {1, 2}:
        raise WorkflowValidationError("only workflow schema_version 1 or 2 is supported")

    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise WorkflowValidationError("steps must be a non-empty list")
    if len(raw_steps) > _MAX_STEPS:
        raise WorkflowValidationError(f"workflow may contain at most {_MAX_STEPS} steps")

    steps: list[WorkflowStepDefinition] = []
    identifiers: set[str] = set()
    for index, raw_step in enumerate(raw_steps, start=1):
        if not isinstance(raw_step, dict):
            raise WorkflowValidationError(f"steps[{index}] must be an object")
        allowed_step = {
            "id",
            "title",
            "prompt",
            "depends_on",
            "continue_on_error",
            "kind",
            "max_attempts",
            "when",
            "access",
        }
        unexpected_step = set(raw_step) - allowed_step
        if unexpected_step:
            raise WorkflowValidationError(
                f"steps[{index}] has unsupported fields: {', '.join(sorted(unexpected_step))}"
            )
        identifier = _require_identifier(raw_step.get("id"), f"steps[{index}].id")
        if identifier in identifiers:
            raise WorkflowValidationError(f"steps[{index}].id duplicates {identifier}")
        identifiers.add(identifier)
        title = _require_string(raw_step.get("title", identifier), f"steps[{index}].title")
        kind = raw_step.get("kind", "agent")
        if kind not in _STEP_KINDS:
            raise WorkflowValidationError(
                f"steps[{index}].kind must be agent, approval, or checkpoint"
            )
        raw_prompt = raw_step.get("prompt", "")
        if kind == "agent":
            prompt = _require_string(
                raw_prompt,
                f"steps[{index}].prompt",
                maximum=_MAX_PROMPT_LENGTH,
            )
        else:
            if not isinstance(raw_prompt, str) or len(raw_prompt) > _MAX_PROMPT_LENGTH:
                raise WorkflowValidationError(
                    f"steps[{index}].prompt must be a string of at most {_MAX_PROMPT_LENGTH} characters"
                )
            prompt = raw_prompt.strip()
        raw_dependencies = raw_step.get("depends_on", [])
        if not isinstance(raw_dependencies, list) or not all(isinstance(item, str) for item in raw_dependencies):
            raise WorkflowValidationError(f"steps[{index}].depends_on must be a list of identifiers")
        dependencies = tuple(_require_identifier(item, f"steps[{index}].depends_on") for item in raw_dependencies)
        if len(set(dependencies)) != len(dependencies):
            raise WorkflowValidationError(f"steps[{index}].depends_on contains duplicates")
        if identifier in dependencies:
            raise WorkflowValidationError(f"steps[{index}] cannot depend on itself")
        continue_on_error = raw_step.get("continue_on_error", False)
        if not isinstance(continue_on_error, bool):
            raise WorkflowValidationError(f"steps[{index}].continue_on_error must be boolean")
        max_attempts = raw_step.get("max_attempts", 1)
        if (
            isinstance(max_attempts, bool)
            or not isinstance(max_attempts, int)
            or not 1 <= max_attempts <= 5
        ):
            raise WorkflowValidationError(
                f"steps[{index}].max_attempts must be an integer between 1 and 5"
            )
        if kind != "agent" and max_attempts != 1:
            raise WorkflowValidationError(
                f"steps[{index}].max_attempts is only supported for agent steps"
            )
        access = raw_step.get("access", "write" if kind == "agent" else "none")
        if access not in _ACCESS_MODES:
            raise WorkflowValidationError(
                f"steps[{index}].access must be read, write, or none"
            )
        if kind == "agent" and access == "none":
            raise WorkflowValidationError(
                f"steps[{index}].access cannot be none for an agent step"
            )
        if kind != "agent" and access != "none":
            raise WorkflowValidationError(
                f"steps[{index}].access must be none for non-agent steps"
            )
        when_step = ""
        when_statuses: tuple[str, ...] = ()
        raw_when = raw_step.get("when")
        if raw_when is not None:
            if not isinstance(raw_when, dict) or set(raw_when) != {"step", "status"}:
                raise WorkflowValidationError(
                    f"steps[{index}].when must contain exactly step and status"
                )
            when_step = _require_identifier(
                raw_when.get("step"),
                f"steps[{index}].when.step",
            )
            raw_status = raw_when.get("status")
            statuses = [raw_status] if isinstance(raw_status, str) else raw_status
            if (
                not isinstance(statuses, list)
                or not statuses
                or not all(isinstance(item, str) and item in _CONDITION_STATUSES for item in statuses)
            ):
                raise WorkflowValidationError(
                    f"steps[{index}].when.status must use supported terminal statuses"
                )
            when_statuses = tuple(dict.fromkeys(statuses))
        steps.append(
            WorkflowStepDefinition(
                id=identifier,
                title=title,
                prompt=prompt,
                depends_on=dependencies,
                continue_on_error=continue_on_error,
                kind=kind,
                max_attempts=max_attempts,
                when_step=when_step,
                when_statuses=when_statuses,
                access=access,
            )
        )

    step_ids = {step.id for step in steps}
    for step in steps:
        missing = set(step.depends_on) - step_ids
        if missing:
            raise WorkflowValidationError(f"step {step.id} depends on unknown step(s): {', '.join(sorted(missing))}")
        if step.when_step and step.when_step not in step.depends_on:
            raise WorkflowValidationError(
                f"step {step.id} condition must reference one of its dependencies"
            )
    _topological_steps(steps)

    description = data.get("description", "")
    if not isinstance(description, str) or len(description) > 2_000:
        raise WorkflowValidationError("description must be a string of at most 2000 characters")
    return WorkflowDefinition(
        name=_require_identifier(data.get("name"), "name"),
        description=description.strip(),
        steps=tuple(steps),
        schema_version=schema_version,
        source_path=str(source_path) if source_path else "",
    )


def _topological_steps(steps: list[WorkflowStepDefinition] | tuple[WorkflowStepDefinition, ...]) -> list[WorkflowStepDefinition]:
    pending = {step.id: step for step in steps}
    ordered: list[WorkflowStepDefinition] = []
    resolved: set[str] = set()
    while pending:
        ready = [step for step in pending.values() if set(step.depends_on) <= resolved]
        if not ready:
            raise WorkflowValidationError("workflow dependencies contain a cycle")
        for step in ready:
            ordered.append(step)
            resolved.add(step.id)
            del pending[step.id]
    return ordered


def load_workflow(path: str | Path, *, workspace: Path | None = None) -> WorkflowDefinition:
    """Load a bounded workflow JSON file from the selected workspace."""
    target = Path(path).expanduser().resolve()
    if target.suffix.casefold() != ".json":
        raise WorkflowValidationError("workflow files must use the .json extension")
    if workspace is not None:
        root = workspace.expanduser().resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise WorkflowValidationError("workflow file must be inside the workspace") from exc
    try:
        size = target.stat().st_size
    except OSError as exc:
        raise WorkflowValidationError(f"workflow file is unavailable: {target}") from exc
    if size > _MAX_WORKFLOW_BYTES:
        raise WorkflowValidationError(f"workflow file exceeds {_MAX_WORKFLOW_BYTES} bytes")
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkflowValidationError(f"workflow must contain valid UTF-8 JSON: {exc}") from exc
    return parse_workflow(data, source_path=target)


def discover_workflows(workspace: Path | None = None) -> list[Path]:
    """List project workflow files without executing or parsing them."""
    root = (workspace or Path.cwd()).expanduser().resolve() / ".arforge" / "workflows"
    if not root.is_dir():
        return []
    return sorted(path.resolve() for path in root.glob("*.json") if path.is_file())


def preview_workflow(definition: WorkflowDefinition) -> WorkflowRunReport:
    """Produce a deterministic execution plan without calling a model."""
    return WorkflowRunReport(
        name=definition.name,
        source_path=definition.source_path,
        success=True,
        dry_run=True,
        steps=[
            WorkflowStepResult(
                id=step.id,
                title=step.title,
                status="planned",
                output=f"depends_on: {', '.join(step.depends_on) or 'none'}",
            )
            for step in _topological_steps(definition.steps)
        ],
    )


def execute_workflow(
    definition: WorkflowDefinition,
    runner: Callable[[WorkflowStepDefinition], Any],
) -> WorkflowRunReport:
    """Execute validated steps in dependency order through an injected agent runner."""
    results: dict[str, WorkflowStepResult] = {}
    step_by_id = {step.id: step for step in definition.steps}
    for step in _topological_steps(definition.steps):
        failed_dependencies = [
            dependency
            for dependency in step.depends_on
            if results[dependency].status == "blocked"
            or (
                results[dependency].status == "failed"
                and not step_by_id[dependency].continue_on_error
            )
        ]
        if failed_dependencies:
            results[step.id] = WorkflowStepResult(
                id=step.id,
                title=step.title,
                status="blocked",
                error=f"blocked by failed dependency: {', '.join(failed_dependencies)}",
            )
            continue
        try:
            output = runner(step)
            results[step.id] = WorkflowStepResult(
                id=step.id,
                title=step.title,
                status="completed",
                output=sanitize_for_storage(str(output))[:20_000],
            )
        except Exception as exc:  # Individual step failures are reported, not raised.
            results[step.id] = WorkflowStepResult(
                id=step.id,
                title=step.title,
                status="failed",
                error=sanitize_for_storage(str(exc))[:2_000],
            )
            if step.continue_on_error:
                continue
            break

    ordered_results = [results[step.id] for step in _topological_steps(definition.steps) if step.id in results]
    success = all(result.status == "completed" for result in ordered_results)
    return WorkflowRunReport(
        name=definition.name,
        source_path=definition.source_path,
        success=success,
        dry_run=False,
        steps=ordered_results,
    )


def write_workflow_report(report: WorkflowRunReport, path: str | Path | None = None) -> Path:
    """Persist a structured report under the local profile unless a path is supplied."""
    target = Path(path) if path else Path(data_path("workflows", "runs", f"{report.name}.json"))
    target = target.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report.public(), ensure_ascii=False, indent=2), encoding="utf-8")
    return target
