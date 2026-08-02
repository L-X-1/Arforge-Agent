"""Fail-closed acceptance matrix for the technology scope promised by V1."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
import hashlib
import json
from importlib.resources import files
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import time

from arforge.paths import data_path
from arforge.acceptance.stack_fixtures import get_stack_fixture


def load_stack_manifest() -> dict:
    resource = files("arforge.acceptance").joinpath("stack_matrix.json")
    payload = json.loads(resource.read_text(encoding="utf-8"))
    capabilities = payload.get("capabilities", [])
    ids = [str(item.get("id", "")) for item in capabilities]
    if payload.get("schema_version") != 1 or not capabilities:
        raise RuntimeError("stack acceptance manifest is empty or unsupported")
    if any(not capability_id for capability_id in ids) or len(ids) != len(set(ids)):
        raise RuntimeError("stack acceptance manifest contains invalid or duplicate ids")
    return payload


def _evidence_root() -> Path:
    return data_path("acceptance", "stack")


def _canonical_hash(payload: dict) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _acceptance_contract_hash() -> str:
    """Fingerprint the manifest, runner and native fixture implementation."""
    digest = hashlib.sha256()
    paths = (
        Path(__file__).resolve(),
        Path(__file__).resolve().parents[1] / "acceptance" / "stack_fixtures.py",
        Path(__file__).resolve().parents[1] / "acceptance" / "stack_matrix.json",
    )
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def record_stack_evidence(
    capability_id: str,
    *,
    passed: bool,
    checks: dict[str, bool],
    command_results: list[dict],
    fixture_sha256: str,
    source_revision: str,
    duration_seconds: float,
    environment: dict | None = None,
    error: str = "",
) -> Path:
    """Persist one immutable, integrity-protected acceptance result."""
    manifest_ids = {
        item["id"] for item in load_stack_manifest()["capabilities"]
    }
    if capability_id not in manifest_ids:
        raise ValueError(f"unknown stack capability: {capability_id}")
    if not checks:
        raise ValueError("acceptance evidence requires explicit checks")
    if passed and (
        not all(bool(value) for value in checks.values())
        or not command_results
        or any(int(item.get("exit_code", 1)) != 0 for item in command_results)
    ):
        raise ValueError("passed evidence must have successful checks and commands")
    now = datetime.now().isoformat(timespec="seconds")
    payload = {
        "schema_version": 1,
        "capability_id": capability_id,
        "passed": bool(passed),
        "checks": {str(key): bool(value) for key, value in checks.items()},
        "command_results": command_results,
        "fixture_sha256": str(fixture_sha256),
        "source_revision": str(source_revision),
        "acceptance_contract_sha256": _acceptance_contract_hash(),
        "duration_seconds": round(float(duration_seconds), 3),
        "environment": dict(environment or {}),
        "error": str(error),
        "finished_at": now,
    }
    payload["record_hash"] = _canonical_hash(payload)
    destination_dir = _evidence_root() / capability_id
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / (
        now.replace(":", "").replace("-", "") + "-" + payload["record_hash"][:10] + ".json"
    )
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=destination_dir,
        delete=False,
        suffix=".tmp",
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        temporary = Path(handle.name)
    temporary.replace(destination)
    return destination


def _valid_evidence(row: dict, capability_id: str) -> bool:
    if row.get("schema_version") != 1 or row.get("capability_id") != capability_id:
        return False
    claimed = str(row.get("record_hash", ""))
    payload = dict(row)
    payload.pop("record_hash", None)
    return (
        bool(claimed)
        and _canonical_hash(payload) == claimed
        and row.get("acceptance_contract_sha256") == _acceptance_contract_hash()
    )


def _latest_evidence(capability_id: str) -> dict | None:
    directory = _evidence_root() / capability_id
    if not directory.is_dir():
        return None
    valid: list[dict] = []
    for path in directory.glob("*.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if _valid_evidence(row, capability_id):
            row["evidence_path"] = str(path)
            valid.append(row)
    if not valid:
        return None
    return max(valid, key=lambda row: str(row.get("finished_at", "")))


def _command_availability(command_groups: list[list[str]]) -> tuple[bool, list[dict]]:
    groups = []
    for alternatives in command_groups:
        found = [
            {"command": command, "path": shutil.which(command)}
            for command in alternatives
            if shutil.which(command)
        ]
        groups.append(
            {
                "alternatives": list(alternatives),
                "available": bool(found),
                "found": found,
            }
        )
    return all(group["available"] for group in groups), groups


def build_stack_acceptance_report() -> dict:
    """Report real evidence and local executability for every promised stack."""
    manifest = load_stack_manifest()
    rows = []
    for capability in manifest["capabilities"]:
        capability_id = capability["id"]
        available, command_groups = _command_availability(
            capability.get("command_groups", [])
        )
        evidence = _latest_evidence(capability_id)
        verified = bool(
            evidence
            and evidence.get("passed")
            and evidence.get("checks")
            and all(bool(value) for value in evidence["checks"].values())
            and evidence.get("command_results")
            and all(
                int(item.get("exit_code", 1)) == 0
                for item in evidence["command_results"]
            )
        )
        rows.append(
            {
                "id": capability_id,
                "category": capability["category"],
                "name": capability["name"],
                "status": (
                    "verified"
                    if verified
                    else "unverified"
                    if available
                    else "toolchain_unavailable"
                ),
                "verified": verified,
                "locally_executable": available,
                "command_groups": command_groups,
                "evidence": evidence,
            }
        )
    status_counts = Counter(row["status"] for row in rows)
    category_totals = Counter(row["category"] for row in rows)
    category_verified = Counter(
        row["category"] for row in rows if row["verified"]
    )
    return {
        "schema_version": 1,
        "status": "pass" if rows and all(row["verified"] for row in rows) else "incomplete",
        "total": len(rows),
        "verified": status_counts["verified"],
        "unverified": status_counts["unverified"],
        "toolchain_unavailable": status_counts["toolchain_unavailable"],
        "categories": {
            category: {
                "total": category_totals[category],
                "verified": category_verified[category],
            }
            for category in sorted(category_totals)
        },
        "capabilities": rows,
    }


def _fixture_digest(files_to_write: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for relative, content in sorted(files_to_write.items()):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def _bounded_command_output(output: str, limit: int = 8000) -> str:
    text = str(output or "").strip()
    if len(text) <= limit:
        return text
    marker = "\n...[command output truncated; head and tail preserved]...\n"
    available = limit - len(marker)
    head = available // 2
    return text[:head] + marker + text[-(available - head):]


def _source_revision() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            return completed.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unversioned"


def _executable_stem(value: str | Path) -> str:
    """Return an executable stem for native or Windows-style paths on any host."""
    text = str(value)
    path = PureWindowsPath(text) if PureWindowsPath(text).drive else Path(text)
    return path.stem.casefold()


def _resolve_fixture_command(command: tuple[str, ...], workspace: Path) -> list[str]:
    executable = command[0]
    if executable == "{python}":
        resolved = sys.executable
    elif executable in {"{venv_python}", "{venv_cmake}"}:
        executable_name = "python.exe" if executable == "{venv_python}" else "cmake.exe"
        candidate = (
            workspace / ".venv" / "Scripts" / executable_name
            if sys.platform == "win32"
            else workspace / ".venv" / "bin" / executable_name.removesuffix(".exe")
        )
        if not candidate.is_file():
            raise FileNotFoundError(
                f"fixture virtual environment executable was not created: {executable_name}"
            )
        resolved = str(candidate)
    elif executable.casefold().endswith(".exe"):
        resolved = str(workspace / executable)
    elif executable == "bash" and sys.platform == "win32":
        # ``System32\bash.exe`` is a WSL launcher and can leave the temporary
        # working directory locked after it exits. Prefer the native Git Bash
        # shipped beside the detected Git executable.
        git = shutil.which("git")
        git_bash = (
            Path(git).resolve().parent.parent / "bin" / "bash.exe"
            if git
            else Path()
        )
        resolved = str(git_bash) if git_bash.is_file() else str(shutil.which("bash") or "")
        if not resolved:
            raise FileNotFoundError("required executable is unavailable: bash")
    else:
        found = shutil.which(executable)
        if not found:
            raise FileNotFoundError(f"required executable is unavailable: {executable}")
        resolved = found
    venv_ninja = (
        workspace / ".venv" / "Scripts" / "ninja.exe"
        if sys.platform == "win32"
        else workspace / ".venv" / "bin" / "ninja"
    )
    resolved_command = [
        resolved,
        *[
            str(item)
            .replace("{workspace}", str(workspace))
            .replace("{venv_ninja}", str(venv_ninja))
            for item in command[1:]
        ],
    ]
    if (
        _executable_stem(resolved) == "docker"
        and len(resolved_command) > 1
        and resolved_command[1] == "run"
    ):
        resolved_command[2:2] = [
            "--label",
            f"arforge.acceptance.workspace={workspace.name}",
        ]
    return resolved_command


def _cleanup_fixture_containers(workspace: Path) -> None:
    """Remove only containers carrying this fixture's unique runtime label."""
    docker = shutil.which("docker")
    if not docker:
        return
    label = f"arforge.acceptance.workspace={workspace.name}"
    listed = subprocess.run(
        [docker, "ps", "-aq", "--filter", f"label={label}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    container_ids = [
        line.strip() for line in listed.stdout.splitlines() if line.strip()
    ]
    if container_ids:
        subprocess.run(
            [docker, "rm", "-f", *container_ids],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )


def _materialize_fixture_files(files_to_write: dict[str, str]) -> dict[str, str]:
    """Resolve environment-specific compile targets without weakening checks."""
    if not any("{dotnet_target}" in content for content in files_to_write.values()):
        return dict(files_to_write)
    dotnet = shutil.which("dotnet")
    if not dotnet:
        return dict(files_to_write)
    completed = subprocess.run(
        [dotnet, "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=False,
    )
    major = completed.stdout.strip().split(".", 1)[0]
    target = f"net{major}.0" if major.isdigit() else "net8.0"
    return {
        relative: content.replace("{dotnet_target}", target)
        for relative, content in files_to_write.items()
    }


def run_stack_acceptance(
    capability_ids: list[str] | tuple[str, ...] | None = None,
    *,
    timeout_seconds: int = 180,
) -> dict:
    """Execute native, deterministic fixtures and persist honest evidence.

    Only capabilities with a concrete fixture are runnable. Missing native
    fixtures or toolchains are reported and remain unverified.
    """
    manifest = load_stack_manifest()
    known = {item["id"]: item for item in manifest["capabilities"]}
    requested = list(capability_ids or known)
    unknown = sorted(set(requested) - set(known))
    if unknown:
        raise ValueError(f"unknown stack capabilities: {', '.join(unknown)}")

    results: list[dict] = []
    for capability_id in requested:
        fixture = get_stack_fixture(capability_id)
        if fixture is None:
            results.append(
                {
                    "id": capability_id,
                    "status": "not_implemented",
                    "passed": False,
                    "error": "no native acceptance fixture is implemented",
                }
            )
            continue

        started = time.monotonic()
        command_results: list[dict] = []
        error = ""
        passed = True
        materialized_files = _materialize_fixture_files(fixture.files)
        command_timeout = int(fixture.timeout_seconds or timeout_seconds)
        with tempfile.TemporaryDirectory(
            prefix=f"arforge-stack-{capability_id}-",
            ignore_cleanup_errors=True,
        ) as raw:
            workspace = Path(raw)
            for relative, content in materialized_files.items():
                destination = (workspace / relative).resolve()
                destination.relative_to(workspace.resolve())
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(content, encoding="utf-8")
            try:
                for raw_command in fixture.commands:
                    try:
                        command = _resolve_fixture_command(raw_command, workspace)
                        completed = subprocess.run(
                            command,
                            cwd=workspace,
                            env={
                                **os.environ,
                                **{
                                    str(key): str(value)
                                    for key, value in (fixture.environment or {}).items()
                                },
                            },
                            capture_output=True,
                            text=True,
                            encoding="utf-8",
                            errors="replace",
                            timeout=command_timeout,
                            check=False,
                        )
                        output = (completed.stdout + "\n" + completed.stderr).strip()
                        command_results.append(
                            {
                                "command": [str(item) for item in command],
                                "exit_code": int(completed.returncode),
                                "output": _bounded_command_output(output),
                            }
                        )
                        if completed.returncode != 0:
                            passed = False
                            error = output[-1000:] or "command returned non-zero"
                            break
                    except subprocess.TimeoutExpired as exc:
                        passed = False
                        stdout = (
                            exc.stdout.decode("utf-8", errors="replace")
                            if isinstance(exc.stdout, bytes)
                            else str(exc.stdout or "")
                        )
                        stderr = (
                            exc.stderr.decode("utf-8", errors="replace")
                            if isinstance(exc.stderr, bytes)
                            else str(exc.stderr or "")
                        )
                        partial = (stdout + "\n" + stderr).strip()
                        error = f"command timed out after {command_timeout}s"
                        command_results.append(
                            {
                                "command": list(raw_command),
                                "exit_code": -1,
                                "output": _bounded_command_output(partial or error),
                            }
                        )
                        break
                    except (OSError, subprocess.SubprocessError) as exc:
                        passed = False
                        error = str(exc)
                        command_results.append(
                            {
                                "command": list(raw_command),
                                "exit_code": -1,
                                "output": str(exc),
                            }
                        )
                        break
            finally:
                _cleanup_fixture_containers(workspace)

        duration = time.monotonic() - started
        checks = {
            "native_fixture": fixture is not None,
            "commands_executed": bool(command_results),
            "all_commands_passed": passed and bool(command_results),
        }
        evidence_path = record_stack_evidence(
            capability_id,
            passed=passed,
            checks=checks,
            command_results=command_results,
            fixture_sha256=_fixture_digest(materialized_files),
            source_revision=_source_revision(),
            duration_seconds=duration,
            environment={
                "platform": sys.platform,
                "python": sys.version.split()[0],
            },
            error=error,
        )
        results.append(
            {
                "id": capability_id,
                "status": "passed" if passed else "failed",
                "passed": passed,
                "duration_seconds": round(duration, 3),
                "evidence_path": str(evidence_path),
                "error": error,
            }
        )
    return {
        "schema_version": 1,
        "requested": len(requested),
        "passed": sum(1 for item in results if item["passed"]),
        "failed": sum(1 for item in results if item["status"] == "failed"),
        "not_implemented": sum(
            1 for item in results if item["status"] == "not_implemented"
        ),
        "results": results,
    }
