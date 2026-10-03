"""Environment diagnostics for Arforge Agent."""

from __future__ import annotations

import importlib.util
import json
import os
import platform
import shutil
import socket
import sys
import time
from importlib.metadata import PackageNotFoundError, version as package_version
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import config  # noqa: F401 - importing loads .env configuration.
from arforge.locale import brand_title

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised on Python 3.10 CI
    import tomli as tomllib


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str
    warning: bool = False

    @property
    def icon(self) -> str:
        if self.ok and not self.warning:
            return "OK"
        if self.ok and self.warning:
            return "WARN"
        return "FAIL"


CORE_MODULES = [
    # The product launcher is the TypeScript CLI; Python is checked only at
    # the compatibility bridge boundary.  The legacy parser remains importable
    # for migration fixtures but is not a product health dependency.
    "arforge.cli_bridge",
    "arforge.logger",
    "arforge.cli_ui",
    "arforge.product.doctor",
]

REQUIRED_MODULES = [
    ("dotenv", "python-dotenv"),
    ("openai", "openai"),
    ("sqlalchemy", "SQLAlchemy"),
]

OPTIONAL_MODULES = [
    ("PIL", "Pillow"),
    ("pandas", "pandas"),
    ("matplotlib", "matplotlib"),
]


def _module_exists(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _check_python() -> CheckResult:
    version = platform.python_version()
    ok = sys.version_info >= (3, 10)
    return CheckResult("Python", ok, f"{version} (requires >= 3.10)")


def _check_api_key() -> CheckResult:
    key = os.getenv("DEEPSEEK_API_KEY", "")
    if not key:
        return CheckResult("DeepSeek API Key", True, "not configured", warning=True)
    # Show only the public prefix (e.g. "sk-") + last 4 chars for the user to
    # confirm WHICH key is loaded, without leaking enough to reconstruct it.
    # Previously this printed key[:6]...key[-4:] (10 chars), which is far too much
    # of a secret to print to a terminal or capture in a support log.
    masked = _mask_secret(key)
    return CheckResult("DeepSeek API Key", True, f"configured ({masked})")


def _mask_secret(secret: str) -> str:
    """Mask a secret for display: keep up to a 3-char public prefix and the last 4 chars,
    never exposing more than 4 characters of the secret payload.

    For short/unusual values, fall back to "***" so we never print most of a weak key.
    """
    if not secret:
        return "***"
    if len(secret) <= 8:
        return "***"
    prefix = secret[:3] if secret[:3].isascii() and secret[:3].isalpha() else ""
    return f"{prefix}****{secret[-4:]}" if prefix else f"****{secret[-4:]}"


def _check_model_name() -> CheckResult:
    """Warn if DEEPSEEK_MODEL is not a publicly documented DeepSeek model."""
    from config import DEEPSEEK_MODEL, KNOWN_DEEPSEEK_MODELS

    if DEEPSEEK_MODEL in KNOWN_DEEPSEEK_MODELS:
        return CheckResult("DeepSeek model", True, f"{DEEPSEEK_MODEL} (recognised)")
    return CheckResult(
        "DeepSeek model",
        True,
        f"'{DEEPSEEK_MODEL}' is not a recognised public DeepSeek model — set DEEPSEEK_MODEL to one of: {', '.join(sorted(KNOWN_DEEPSEEK_MODELS))}",
        warning=True,
    )


def _check_dns() -> CheckResult:
    host = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replace("https://", "").replace("http://", "").split("/")[0]
    try:
        socket.gethostbyname(host)
    except Exception as exc:
        return CheckResult("API DNS", True, f"{host}: {exc}", warning=True)
    return CheckResult("API DNS", True, f"{host} resolved")


def _check_active_provider() -> list[CheckResult]:
    """Diagnose the provider that runtime sessions will actually use.

    This deliberately resolves the encrypted user configuration instead of
    inspecting only one provider's environment variable. It keeps ``doctor``
    accurate when launched from an arbitrary user project directory.
    """
    try:
        from arforge.product.model_config_runtime import (
            SUPPORTED_PROVIDERS,
            get_model_config,
        )

        runtime = get_model_config()
        resolved = runtime.get_resolved_config()
        provider = str(resolved.get("provider", "") or "unknown")
        definition = SUPPORTED_PROVIDERS.get(provider, {})
        label = str(definition.get("label", provider))
        model = str(resolved.get("model", "") or "not configured")
        source = str(resolved.get("key_source", "none") or "none")
        configured = bool(resolved.get("resolved"))
        credential = CheckResult(
            "Active provider credentials",
            True,
            (
                f"{label}: configured ({source})"
                if configured
                else f"{label}: not configured; run `arforge auth login {provider}`"
            ),
            warning=not configured,
        )

        known_models = set(definition.get("models", []))
        allow_custom = bool(definition.get("allow_custom_model", False))
        model_known = allow_custom or model in known_models
        model_check = CheckResult(
            "Active provider model",
            True,
            f"{provider}/{model}" + ("" if model_known else " (unrecognised)"),
            warning=not model_known,
        )

        base_url = str(resolved.get("base_url", "") or "")
        host = urlparse(base_url).hostname or ""
        if not host:
            dns = CheckResult("API DNS", True, "provider endpoint is invalid", warning=True)
        else:
            try:
                socket.gethostbyname(host)
                dns = CheckResult("API DNS", True, f"{host} resolved")
            except Exception as exc:
                dns = CheckResult("API DNS", True, f"{host}: {exc}", warning=True)
        return [credential, model_check, dns]
    except Exception as exc:
        return [
            CheckResult(
                "Active provider configuration",
                True,
                f"unable to resolve: {exc}",
                warning=True,
            )
        ]


def _check_modules() -> list[CheckResult]:
    results: list[CheckResult] = []
    for module in CORE_MODULES:
        results.append(CheckResult(f"Core module {module}", _module_exists(module), "import spec found" if _module_exists(module) else "missing"))
    for module, package in REQUIRED_MODULES:
        exists = _module_exists(module)
        results.append(CheckResult(f"Required {package}", exists, "available" if exists else "missing — reinstall arforge-agent"))
    for module, package in OPTIONAL_MODULES:
        exists = _module_exists(module)
        results.append(CheckResult(f"Optional {package}", True, "available" if exists else "not installed", warning=not exists))
    return results


def _check_package_versions() -> CheckResult:
    """Ensure runtime/display and Python distribution versions do not drift.

    The desktop/npm build uses SemVer prerelease ``1.0.0-test.1`` while the
    Python distribution uses the PEP 440 equivalent ``1.0.0.dev1``. They are
    intentionally different spellings of the same private test release.
    """
    try:
        root = Path(__file__).resolve().parents[2]
        from arforge import __version__
        from arforge.locale import VERSION

        runtime_versions = {__version__, VERSION}
        installed_version: str | None = None
        try:
            installed_version = package_version("arforge-agent")
        except PackageNotFoundError:
            pass
        pyproject_path = root / "pyproject.toml"
        package_json_path = root / "package.json"
        source_version: str | None = None
        if pyproject_path.exists():
            pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
            source_version = str(pyproject["project"]["version"])
        if package_json_path.exists():
            npm = json.loads(package_json_path.read_text(encoding="utf-8"))
            runtime_versions.add(npm["version"])
        if len(runtime_versions) != 1:
            return CheckResult(
                "Package versions",
                False,
                "runtime manifests disagree: " + ", ".join(sorted(runtime_versions)),
            )
        runtime_version = next(iter(runtime_versions))
        expected_distribution = (
            "1.0.0.dev1"
            if runtime_version == "1.0.0-test.1"
            else runtime_version
        )
        if source_version is not None and source_version != expected_distribution:
            return CheckResult(
                "Package versions",
                False,
                f"source={source_version}, runtime={runtime_version}; source manifests disagree",
            )
        if installed_version is not None and installed_version != expected_distribution:
            return CheckResult(
                "Package versions",
                False,
                (
                    f"installed={installed_version}, source={expected_distribution}, "
                    f"runtime={runtime_version}; refresh this checkout's console entry with "
                    "`python -m pip install -e .`"
                ),
            )
        return CheckResult(
            "Package versions",
            True,
            (
                f"runtime={runtime_version} "
                f"(source={expected_distribution}, installed={installed_version or 'not installed'})"
            ),
        )
    except Exception as exc:
        return CheckResult("Package versions", False, str(exc))


def _check_disk_space() -> CheckResult:
    try:
        free = shutil.disk_usage(Path.home()).free
        detail = f"{free / (1024 ** 3):.1f} GiB free"
        if free < 100 * 1024 * 1024:
            return CheckResult("Disk space", False, detail)
        return CheckResult("Disk space", True, detail, warning=free < 1024 ** 3)
    except Exception as exc:
        return CheckResult("Disk space", True, str(exc), warning=True)


def _check_database_config() -> CheckResult:
    url = os.getenv("ARFORGE_DB_URL", "").strip()
    if not url:
        return CheckResult("Database configuration", True, "ARFORGE_DB_URL not configured", warning=True)
    from arforge.database.config import get_database_url, get_multiagent_database_url

    try:
        import psycopg2

        targets = (
            ("main", get_database_url()),
            ("multiagent", get_multiagent_database_url()),
        )
        descriptions: list[str] = []
        for label, target_url in targets:
            if not target_url.startswith(("postgresql://", "postgresql+psycopg2://")):
                return CheckResult(
                    "Database configuration",
                    False,
                    f"{label} database must use PostgreSQL",
                )
            parsed = urlparse(target_url)
            endpoint = parsed.hostname or "configured host"
            if parsed.port:
                endpoint = f"{endpoint}:{parsed.port}"
            database = parsed.path.lstrip("/") or "configured database"
            connect_url = target_url.replace(
                "postgresql+psycopg2://", "postgresql://", 1
            )
            try:
                connection = psycopg2.connect(connect_url, connect_timeout=3)
                connection.close()
            except Exception as exc:  # noqa: BLE001 - doctor reports runtime failures
                return CheckResult(
                    "Database configuration",
                    False,
                    f"PostgreSQL connectivity failed for {label} at "
                    f"{endpoint}/{database} ({type(exc).__name__}); verify "
                    f"ARFORGE_DB_URL, ARFORGE_MULTIAGENT_DB_URL and server availability",
                )
            descriptions.append(f"{label}={endpoint}/{database}")
    except Exception as exc:  # noqa: BLE001 - doctor reports dependency/runtime failures
        return CheckResult(
            "Database configuration",
            False,
            f"PostgreSQL configuration failed ({type(exc).__name__}): {exc}",
        )
    return CheckResult(
        "Database configuration",
        True,
        "PostgreSQL reachable: " + ", ".join(descriptions),
    )


def _check_paths() -> list[CheckResult]:
    from arforge.privacy_cli import get_arforge_home

    home = get_arforge_home()
    project_state = Path.cwd() / ".arforge"
    results: list[CheckResult] = []
    for label, path in [("User data", home), ("Project state", project_state)]:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".write_test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            results.append(CheckResult(label, True, f"{path} writable"))
        except Exception as exc:
            results.append(CheckResult(label, False, f"{path}: {exc}"))
    return results


def run_checks() -> list[CheckResult]:
    checks = [
        _check_python(),
    ]
    checks.extend(_check_active_provider())
    checks.extend([
        _check_package_versions(),
        _check_disk_space(),
        _check_database_config(),
    ])
    checks.extend(_check_modules())
    checks.extend(_check_paths())
    return checks


def format_report(results: list[CheckResult], elapsed_ms: int) -> str:
    ok_count = sum(1 for item in results if item.ok and not item.warning)
    warn_count = sum(1 for item in results if item.ok and item.warning)
    fail_count = sum(1 for item in results if not item.ok)
    lines = [
        "=" * 60,
        f"  {brand_title()} Doctor - Environment Diagnostics",
        f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"  Duration: {elapsed_ms}ms",
        "=" * 60,
    ]
    for item in results:
        lines.append(f"  [{item.icon}] {item.name}: {item.detail}")
    lines.extend(
        [
            "",
            f"  Result: {ok_count} OK | {warn_count} WARN | {fail_count} FAIL",
            "  Ready." if fail_count == 0 else "  Action required.",
            "=" * 60,
        ]
    )
    return "\n".join(lines)


def doctor_main() -> int:
    started = time.perf_counter()
    results = run_checks()
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    print(format_report(results, elapsed_ms))
    return 0 if all(item.ok for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(doctor_main())
