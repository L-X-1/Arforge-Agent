from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "private-https"


def test_caddy_configs_keep_the_application_on_loopback() -> None:
    internal = (DEPLOY / "Caddyfile.internal").read_text(encoding="utf-8")
    public = (DEPLOY / "Caddyfile.public").read_text(encoding="utf-8")

    for config in (internal, public):
        assert "reverse_proxy 127.0.0.1:4096" in config
        assert "request>headers>Cookie delete" in config
        assert "request>headers>Authorization delete" in config
        assert 'Strict-Transport-Security "max-age=31536000"' in config
        assert "tls_insecure_skip_verify" not in config

    assert "tls internal" in internal
    assert "tls internal" not in public


def test_caddy_validator_checks_domain_and_uses_validate_only() -> None:
    validator = (DEPLOY / "validate-private-https.ps1").read_text(encoding="utf-8")

    assert 'ValidateSet("Public", "Internal")' in validator
    assert "Public mode requires a real DNS hostname" in validator
    assert "& $caddy validate --config $config --adapter caddyfile" in validator
    assert "caddy run" not in validator


def test_private_https_documentation_uses_the_unified_launcher() -> None:
    readme = (DEPLOY / "README.md").read_text(encoding="utf-8")
    primary = (ROOT / "docs" / "PRIVATE_HTTPS_DEPLOYMENT.md").read_text(encoding="utf-8")

    assert r".\scripts\run_cli.ps1 serve --hostname 127.0.0.1 --port 4096" in readme
    assert "deploy/private-https" in primary
    assert "run_cli.py" not in readme
