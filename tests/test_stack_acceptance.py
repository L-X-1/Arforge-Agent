from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from arforge.core.stack_acceptance import (
    build_stack_acceptance_report,
    load_stack_manifest,
    record_stack_evidence,
    run_stack_acceptance,
)


EXPECTED = {
    "language": {
        "Python",
        "Java",
        "JavaScript",
        "TypeScript",
        "C",
        "C++",
        "C#",
        "Go",
        "Rust",
        "PHP",
        "Ruby",
        "Kotlin",
        "Swift",
        "SQL",
        "Shell",
    },
    "framework": {
        "Spring",
        "Django",
        "Flask",
        "FastAPI",
        "Node.js",
        "Express",
        "Vue",
        "React",
        "Angular",
        "Electron",
        "Tauri",
        "Flutter",
    },
    "database": {
        "MySQL",
        "PostgreSQL",
        "SQLite",
        "Redis",
        "MongoDB",
        "Oracle",
        "Vector DB",
    },
    "build_test": {
        "Maven",
        "Gradle",
        "npm",
        "pnpm",
        "pip",
        "Poetry",
        "Cargo",
        "Go modules",
        "CMake",
        "pytest",
        "JUnit",
        "Jest",
        "Playwright",
        "Cypress",
        "Selenium",
    },
    "devops": {
        "Docker",
        "Kubernetes",
        "CI/CD",
        "GitHub Actions",
        "Nginx",
    },
}


def test_manifest_covers_every_v1_stack_item_exactly_once():
    manifest = load_stack_manifest()
    by_category = {
        category: {
            item["name"]
            for item in manifest["capabilities"]
            if item["category"] == category
        }
        for category in EXPECTED
    }

    assert by_category == EXPECTED
    assert len(manifest["capabilities"]) == 54


def test_report_fails_closed_without_acceptance_evidence(monkeypatch):
    monkeypatch.setattr(
        "arforge.core.stack_acceptance.shutil.which",
        lambda command: f"/bin/{command}",
    )

    report = build_stack_acceptance_report()

    assert report["status"] == "incomplete"
    assert report["total"] == 54
    assert report["verified"] == 0
    assert report["unverified"] == 54


def test_integrity_protected_evidence_can_verify_one_capability(monkeypatch):
    monkeypatch.setattr(
        "arforge.core.stack_acceptance.shutil.which",
        lambda command: f"/bin/{command}",
    )
    path = record_stack_evidence(
        "lang-python",
        passed=True,
        checks={"build": True, "tests": True, "semantic": True},
        command_results=[{"command": "python -m pytest", "exit_code": 0}],
        fixture_sha256="a" * 64,
        source_revision="revision-1",
        duration_seconds=12.5,
        environment={"python": "3.12"},
    )

    report = build_stack_acceptance_report()
    python = next(item for item in report["capabilities"] if item["id"] == "lang-python")

    assert python["status"] == "verified"
    assert python["evidence"]["evidence_path"] == str(path)

    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["checks"]["semantic"] = False
    path.write_text(json.dumps(payload), encoding="utf-8")
    report = build_stack_acceptance_report()
    python = next(item for item in report["capabilities"] if item["id"] == "lang-python")
    assert python["status"] == "unverified"


def test_passed_evidence_rejects_failed_commands():
    with pytest.raises(ValueError, match="successful"):
        record_stack_evidence(
            "lang-python",
            passed=True,
            checks={"tests": True},
            command_results=[{"command": "pytest", "exit_code": 1}],
            fixture_sha256="a" * 64,
            source_revision="revision-1",
            duration_seconds=1,
        )


def test_native_python_acceptance_executes_and_records_real_evidence():
    result = run_stack_acceptance(["lang-python"])

    assert result["requested"] == 1
    assert result["passed"] == 1
    assert result["failed"] == 0
    assert result["not_implemented"] == 0
    report = build_stack_acceptance_report()
    python = next(item for item in report["capabilities"] if item["id"] == "lang-python")
    assert python["verified"] is True
    assert python["evidence"]["command_results"][0]["exit_code"] == 0


def test_every_promised_capability_has_a_native_fixture():
    from arforge.acceptance.stack_fixtures import FIXTURES

    manifest_ids = {
        item["id"] for item in load_stack_manifest()["capabilities"]
    }

    assert set(FIXTURES) == manifest_ids


@pytest.mark.skipif(sys.platform != "win32", reason="Windows executable precedence")
def test_shell_fixture_prefers_git_bash_over_wsl_launcher(tmp_path, monkeypatch):
    from arforge.core.stack_acceptance import _resolve_fixture_command

    git_root = tmp_path / "Git"
    git_cmd = git_root / "cmd" / "git.exe"
    git_bash = git_root / "bin" / "bash.exe"
    git_cmd.parent.mkdir(parents=True)
    git_bash.parent.mkdir(parents=True)
    git_cmd.write_bytes(b"")
    git_bash.write_bytes(b"")

    def which(command):
        return str(git_cmd) if command == "git" else r"C:\Windows\System32\bash.exe"

    monkeypatch.setattr("arforge.core.stack_acceptance.shutil.which", which)
    resolved = _resolve_fixture_command(("bash", "acceptance.sh"), Path(tmp_path))

    assert Path(resolved[0]) == git_bash


def test_docker_fixture_command_gets_unique_cleanup_label(tmp_path, monkeypatch):
    from arforge.core.stack_acceptance import _resolve_fixture_command

    monkeypatch.setattr(
        "arforge.core.stack_acceptance.shutil.which",
        lambda command: r"C:\Docker\docker.exe",
    )
    resolved = _resolve_fixture_command(
        ("docker", "run", "--rm", "alpine:3.22", "true"),
        Path(tmp_path),
    )

    assert resolved[1:4] == [
        "run",
        "--label",
        f"arforge.acceptance.workspace={tmp_path.name}",
    ]
