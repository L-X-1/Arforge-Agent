"""Project-depth acceptance for the technology scope promised by V1.

The native stack matrix proves that each toolchain can execute. This stricter
layer only grants project-depth evidence when a multi-file project completes
all required lifecycle phases in a fresh workspace.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from arforge.core.stack_acceptance import (
    _bounded_command_output,
    _cleanup_fixture_containers,
    _executable_stem,
    _source_revision,
    load_stack_manifest,
)
from arforge.paths import data_path


_ACCEPTANCE_DIR = Path(__file__).resolve().parents[1] / "acceptance"
_PROJECT_MATRIX = _ACCEPTANCE_DIR / "project_matrix.json"
_PROJECTS_DIR = _ACCEPTANCE_DIR / "projects"
_WORKSPACE_PARENT = Path(__file__).resolve().parents[2] / ".arforge-acceptance-workspaces"


def load_project_manifest() -> dict:
    payload = json.loads(_PROJECT_MATRIX.read_text(encoding="utf-8"))
    projects = payload.get("projects", [])
    required_phases = payload.get("required_phases", [])
    if payload.get("schema_version") != 1 or not projects or not required_phases:
        raise RuntimeError("project acceptance manifest is empty or unsupported")
    project_ids = [str(project.get("id", "")) for project in projects]
    if any(not project_id for project_id in project_ids) or len(project_ids) != len(
        set(project_ids)
    ):
        raise RuntimeError("project acceptance manifest has invalid project ids")
    capability_ids = {
        item["id"] for item in load_stack_manifest()["capabilities"]
    }
    for project in projects:
        unknown = sorted(set(project.get("capabilities", [])) - capability_ids)
        missing_phases = sorted(set(required_phases) - set(project.get("phases", {})))
        template = _PROJECTS_DIR / str(project.get("template", ""))
        if unknown:
            raise RuntimeError(
                f"project {project['id']} has unknown capabilities: {', '.join(unknown)}"
            )
        if missing_phases:
            raise RuntimeError(
                f"project {project['id']} lacks phases: {', '.join(missing_phases)}"
            )
        if not template.is_dir():
            raise RuntimeError(f"project {project['id']} template is missing")
    return payload


def _canonical_hash(payload: dict) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _contract_hash(project: dict) -> str:
    """Hash runner semantics and this project only.

    Adding an unrelated project must not invalidate already-proven evidence.
    Changes to the runner, required phases, this project definition, or its
    template still invalidate evidence fail-closed.
    """
    digest = hashlib.sha256()
    runner = Path(__file__).resolve()
    digest.update(runner.read_bytes())
    contract = {
        "required_phases": load_project_manifest()["required_phases"],
        "project": project,
    }
    digest.update(
        json.dumps(
            contract,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return digest.hexdigest()


def _evidence_root() -> Path:
    return data_path("acceptance", "projects")


def _record_project_evidence(payload: dict, project: dict) -> Path:
    row = {
        "schema_version": 1,
        **payload,
        "acceptance_contract_sha256": _contract_hash(project),
        "finished_at": datetime.now().isoformat(timespec="seconds"),
    }
    row["record_hash"] = _canonical_hash(row)
    destination_dir = _evidence_root() / str(row["project_id"])
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / (
        row["finished_at"].replace(":", "").replace("-", "")
        + "-"
        + row["record_hash"][:10]
        + ".json"
    )
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=destination_dir,
        delete=False,
        suffix=".tmp",
    ) as handle:
        json.dump(row, handle, ensure_ascii=False, indent=2, sort_keys=True)
        temporary = Path(handle.name)
    temporary.replace(destination)
    return destination


def _valid_evidence(row: dict, project: dict) -> bool:
    claimed = str(row.get("record_hash", ""))
    payload = dict(row)
    payload.pop("record_hash", None)
    template = _PROJECTS_DIR / str(project["template"])
    required_phases = load_project_manifest()["required_phases"]
    phase_results = row.get("phase_results", {})
    return bool(
        claimed
        and _canonical_hash(payload) == claimed
        and row.get("schema_version") == 1
        and row.get("project_id") == project["id"]
        and row.get("acceptance_contract_sha256") == _contract_hash(project)
        and row.get("template_sha256") == _tree_digest(template)
        and row.get("passed")
        and int(row.get("project_file_count", 0))
        >= int(project.get("minimum_files", 1))
        and all(
            phase_results.get(phase, {}).get("passed")
            and phase_results.get(phase, {}).get("commands")
            for phase in required_phases
        )
    )


def _latest_project_evidence(project: dict) -> dict | None:
    directory = _evidence_root() / str(project["id"])
    if not directory.is_dir():
        return None
    rows: list[dict] = []
    for path in directory.glob("*.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if _valid_evidence(row, project):
            row["evidence_path"] = str(path)
            rows.append(row)
    if not rows:
        return None
    return max(rows, key=lambda row: str(row.get("finished_at", "")))


def _resolve_command(raw: list[str], workspace: Path) -> list[str]:
    executable = raw[0]
    if executable == "{python}":
        resolved = sys.executable
    elif executable in {
        "{venv_python}",
        "{venv_cmake}",
        "{venv_ctest}",
        "{venv_poetry}",
    }:
        executable_name = {
            "{venv_python}": "python.exe" if sys.platform == "win32" else "python",
            "{venv_cmake}": "cmake.exe" if sys.platform == "win32" else "cmake",
            "{venv_ctest}": "ctest.exe" if sys.platform == "win32" else "ctest",
            "{venv_poetry}": "poetry.exe" if sys.platform == "win32" else "poetry",
        }[executable]
        candidate = (
            workspace / ".venv" / "Scripts" / executable_name
            if sys.platform == "win32"
            else workspace / ".venv" / "bin" / executable_name
        )
        if not candidate.is_file():
            raise FileNotFoundError(
                f"project virtual environment executable is unavailable: "
                f"{executable_name}"
            )
        resolved = str(candidate)
    else:
        resolved = shutil.which(executable)
        if not resolved:
            raise FileNotFoundError(f"required executable is unavailable: {executable}")
    venv_ninja = (
        workspace / ".venv" / "Scripts" / "ninja.exe"
        if sys.platform == "win32"
        else workspace / ".venv" / "bin" / "ninja"
    )
    command = [
        str(resolved),
        *[
            str(value)
            .replace("{workspace}", str(workspace))
            .replace("{venv_ninja}", str(venv_ninja))
            for value in raw[1:]
        ],
    ]
    if (
        _executable_stem(str(resolved)) == "docker"
        and len(command) > 1
        and command[1] in {"run", "build"}
    ):
        flag = "--label"
        command[2:2] = [
            flag,
            f"arforge.acceptance.workspace={workspace.name}",
        ]
    return command


def _cleanup_project_images(workspace: Path) -> None:
    docker = shutil.which("docker")
    if not docker:
        return
    label = f"arforge.acceptance.workspace={workspace.name}"
    listed = subprocess.run(
        [docker, "images", "-q", "--filter", f"label={label}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    image_ids = sorted(
        {line.strip() for line in listed.stdout.splitlines() if line.strip()}
    )
    if image_ids:
        subprocess.run(
            [docker, "image", "rm", "-f", *image_ids],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )


def run_project_acceptance(
    project_ids: list[str] | tuple[str, ...] | None = None,
    *,
    timeout_seconds: int = 300,
) -> dict:
    """Execute complete project lifecycles in clean, isolated workspaces."""
    manifest = load_project_manifest()
    known = {project["id"]: project for project in manifest["projects"]}
    requested = list(project_ids or known)
    unknown = sorted(set(requested) - set(known))
    if unknown:
        raise ValueError(f"unknown project acceptance ids: {', '.join(unknown)}")

    results: list[dict] = []
    _WORKSPACE_PARENT.mkdir(parents=True, exist_ok=True)
    for project_id in requested:
        project = known[project_id]
        template = _PROJECTS_DIR / str(project["template"])
        started = time.monotonic()
        phase_results: dict[str, dict] = {}
        passed = True
        error = ""
        with tempfile.TemporaryDirectory(
            prefix=f"arforge-project-{project_id}-",
            dir=_WORKSPACE_PARENT,
            ignore_cleanup_errors=True,
        ) as raw:
            workspace = Path(raw)
            shutil.copytree(template, workspace, dirs_exist_ok=True)
            file_count = sum(1 for path in workspace.rglob("*") if path.is_file())
            environment = {
                **os.environ,
                **{
                    str(key): str(value).replace("{workspace}", str(workspace))
                    for key, value in project.get("environment", {}).items()
                },
            }
            for phase in manifest["required_phases"]:
                command_results: list[dict] = []
                phase_passed = True
                for raw_command in project["phases"][phase]:
                    try:
                        command = _resolve_command(raw_command, workspace)
                        completed = subprocess.run(
                            command,
                            cwd=workspace,
                            env=environment,
                            capture_output=True,
                            text=True,
                            encoding="utf-8",
                            errors="replace",
                            timeout=timeout_seconds,
                            check=False,
                        )
                        output = (completed.stdout + "\n" + completed.stderr).strip()
                        command_results.append(
                            {
                                "command": command,
                                "exit_code": int(completed.returncode),
                                "output": _bounded_command_output(output),
                            }
                        )
                        if completed.returncode != 0:
                            phase_passed = False
                            error = output[-1000:] or f"{phase} returned non-zero"
                            break
                    except (OSError, subprocess.SubprocessError) as exc:
                        phase_passed = False
                        error = str(exc)
                        command_results.append(
                            {
                                "command": list(raw_command),
                                "exit_code": -1,
                                "output": str(exc),
                            }
                        )
                        break
                artifact_glob = str(project.get("artifact_glob", "")).strip()
                if phase == "release_artifact" and (
                    not artifact_glob or not any(workspace.glob(artifact_glob))
                ):
                    phase_passed = False
                    error = (
                        "release phase did not produce the required artifact: "
                        f"{artifact_glob or '<undefined>'}"
                    )
                phase_results[phase] = {
                    "passed": phase_passed,
                    "commands": command_results,
                }
                if not phase_passed:
                    passed = False
                    break
            _cleanup_fixture_containers(workspace)
            _cleanup_project_images(workspace)

        evidence_path = _record_project_evidence(
            {
                "project_id": project_id,
                "capabilities": list(project["capabilities"]),
                "passed": passed,
                "phase_results": phase_results,
                "project_file_count": file_count,
                "template_sha256": _tree_digest(template),
                "source_revision": _source_revision(),
                "duration_seconds": round(time.monotonic() - started, 3),
                "environment": {
                    "platform": sys.platform,
                    "python": sys.version.split()[0],
                },
                "error": error,
            },
            project,
        )
        results.append(
            {
                "id": project_id,
                "passed": passed,
                "status": "passed" if passed else "failed",
                "evidence_path": str(evidence_path),
                "error": error,
            }
        )
    return {
        "schema_version": 1,
        "requested": len(requested),
        "passed": sum(item["passed"] for item in results),
        "failed": sum(not item["passed"] for item in results),
        "results": results,
    }


def build_project_acceptance_report() -> dict:
    """Map valid project-depth evidence back to every promised capability."""
    project_manifest = load_project_manifest()
    stack_manifest = load_stack_manifest()
    project_rows: list[dict] = []
    verified_by: dict[str, list[str]] = {}
    for project in project_manifest["projects"]:
        evidence = _latest_project_evidence(project)
        verified = evidence is not None
        project_rows.append(
            {
                "id": project["id"],
                "status": "verified" if verified else "unverified",
                "verified": verified,
                "capabilities": list(project["capabilities"]),
                "evidence": evidence,
            }
        )
        if verified:
            for capability_id in project["capabilities"]:
                verified_by.setdefault(capability_id, []).append(project["id"])

    capability_rows = [
        {
            "id": capability["id"],
            "category": capability["category"],
            "name": capability["name"],
            "verified": capability["id"] in verified_by,
            "projects": sorted(verified_by.get(capability["id"], [])),
        }
        for capability in stack_manifest["capabilities"]
    ]
    category_totals = Counter(row["category"] for row in capability_rows)
    category_verified = Counter(
        row["category"] for row in capability_rows if row["verified"]
    )
    verified = sum(row["verified"] for row in capability_rows)
    return {
        "schema_version": 1,
        "status": (
            "pass"
            if capability_rows and verified == len(capability_rows)
            else "incomplete"
        ),
        "required_phases": list(project_manifest["required_phases"]),
        "total": len(capability_rows),
        "verified": verified,
        "unverified": len(capability_rows) - verified,
        "categories": {
            category: {
                "total": category_totals[category],
                "verified": category_verified[category],
            }
            for category in sorted(category_totals)
        },
        "projects": project_rows,
        "capabilities": capability_rows,
    }
