from __future__ import annotations

import json

from arforge.cli import main
from arforge.core.accessibility_audit import build_desktop_accessibility_audit
from arforge.core.evidence_templates import available_evidence_templates, build_evidence_template, write_evidence_template


def test_all_stage5_evidence_templates_are_available():
    assert available_evidence_templates() == (
        "accessibility",
        "governance",
        "installer",
        "ship",
        "signing",
        "staging",
        "upgrade",
    )


def test_accessibility_template_contains_retained_manual_proof_fields(tmp_path):
    target = tmp_path / "desktop" / "release-evidence" / "accessibility.template.json"

    written = write_evidence_template("accessibility", target)
    data = json.loads(written.read_text(encoding="utf-8"))

    assert data["status"] == "draft"
    assert data["template_only"] is True
    manual = data["manual_validation"]
    assert manual["keyboard_navigation"]["evidence_path"] == "desktop/release-evidence/a11y-keyboard.txt"
    assert manual["keyboard_navigation"]["evidence_sha256"] == "<64-char-sha256-of-retained-file>"
    assert manual["screen_reader"]["tool"] == "NVDA <version>"
    assert manual["scaling_200"]["scale_percent"] == 200


def test_evidence_template_is_not_accepted_as_release_evidence(tmp_path):
    source = tmp_path / "desktop" / "src"
    source.mkdir(parents=True)
    (source / "App.tsx").write_text(
        """
export function App() {
  return <div>
    <a className="skip-link" href="#main">Skip</a>
    <main id="main" tabIndex={-1}><button>Open</button></main>
  </div>;
}
""",
        encoding="utf-8",
    )
    (source / "styles.css").write_text(
        """
button:focus-visible { outline: 3px solid #fff; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; } }
""",
        encoding="utf-8",
    )
    write_evidence_template("accessibility", tmp_path / "desktop" / "release-evidence" / "accessibility.template.json")

    report = build_desktop_accessibility_audit(tmp_path)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["release_gate_ready"] is False
    assert checks["manual_evidence_metadata"]["status"] == "blocked"
    assert checks["keyboard_navigation"]["status"] == "blocked"
    assert "status=pass" in checks["keyboard_navigation"]["summary"]


def test_cli_writes_evidence_template(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["evidence-template", "staging"]) == 0
    output = capsys.readouterr().out
    written = tmp_path / "desktop" / "release-evidence" / "provider-staging-smoke.template.json"
    data = json.loads(written.read_text(encoding="utf-8"))

    assert "draft/template_only" in output
    assert data["template_only"] is True
    assert data["manual_validation"]["test_credentials_review"]["evidence_path"].endswith(
        "staging-test-credentials-review.txt"
    )


def test_cli_rejects_unknown_evidence_template(capsys):
    assert main(["evidence-template", "not-a-gate"]) == 2
    assert "Available:" in capsys.readouterr().out


def test_evidence_template_metadata_is_copied():
    first = build_evidence_template("ship")
    first["data"]["status"] = "mutated"

    assert build_evidence_template("ship")["data"]["status"] == "draft"
