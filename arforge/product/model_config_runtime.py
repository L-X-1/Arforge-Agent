# -*- coding: utf-8 -*-
"""Model configuration runtime — secure storage for provider API keys and preferences.

Separate from SettingsRuntime (non-sensitive) because API keys must be:
1. Encrypted at rest (Fernet symmetric encryption)
2. Never logged or exposed through non-sensitive settings channels
3. Validated before use (connectivity check)

Supports: DeepSeek, OpenAI, and other providers (extensible).
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import socket
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    _CRYPTO_AVAILABLE = True
except ImportError:
    _CRYPTO_AVAILABLE = False

UTC = timezone.utc

SUPPORTED_PROVIDERS = {
    "deepseek": {
        "label": "DeepSeek",
        "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
        "default_model": "deepseek-v4-flash",
        "base_url": "https://api.deepseek.com",
    },
    "openai": {
        "label": "OpenAI",
        "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini", "o1"],
        "default_model": "gpt-4o",
        "base_url": "https://api.openai.com/v1",
        "allow_custom_model": True,
    },
    "anthropic": {
        "label": "External Provider",
        "models": ["external-compatible-model"],
        "default_model": "external-compatible-model",
        "base_url": "https://api.anthropic.com",
        "allow_custom_model": True,
    },
}

MODEL_CONFIG_VERSION = 1

_MAX_API_KEY_LENGTH = 16 * 1024
_MAX_PROVIDER_LABEL_LENGTH = 80
_MAX_MODEL_NAME_LENGTH = 256
_MAX_BASE_URL_LENGTH = 2048
_MIN_CONTEXT_WINDOW = 4_096
_MAX_CONTEXT_WINDOW = 10_000_000
_TRUE_VALUES = {"1", "true", "yes", "on"}

_PROVIDER_API_KEY_ENV = {
    "deepseek": "DEEPSEEK_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}

_PROVIDER_MODEL_ENV = {
    "deepseek": "DEEPSEEK_MODEL",
    "openai": "OPENAI_MODEL",
    "anthropic": "ANTHROPIC_MODEL",
}

_PROVIDER_BASE_URL_ENV = {
    "deepseek": "DEEPSEEK_BASE_URL",
    "openai": "OPENAI_BASE_URL",
    "anthropic": "ANTHROPIC_BASE_URL",
}


def _loaded_environment_names() -> frozenset[str]:
    """Return variable names explicitly declared by the loaded Arforge env file.

    Process environment values can be inherited from an IDE or shell and are
    therefore not an authoritative provider selection.  A variable written in
    the env file selected by ``config.py`` is operator intent and must not be
    silently overridden by an old desktop preference.  Values are never
    returned or logged here.
    """
    try:
        import config

        path = getattr(config, "_loaded_config_file", None)
        if not path:
            return frozenset()
        names: set[str] = set()
        for raw_line in Path(path).read_text(encoding="utf-8-sig").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            name = name.strip()
            if name and value.strip().strip("\"'"):
                names.add(name)
        return frozenset(names)
    except (OSError, UnicodeError):
        return frozenset()


def _provider_declared_by_loaded_environment() -> str | None:
    names = _loaded_environment_names()
    explicit = os.getenv("ARFORGE_PROVIDER", "").strip().casefold()
    if "ARFORGE_PROVIDER" in names and explicit in SUPPORTED_PROVIDERS:
        return explicit
    for provider_id in SUPPORTED_PROVIDERS:
        if (
            _PROVIDER_API_KEY_ENV[provider_id] in names
            or _PROVIDER_MODEL_ENV[provider_id] in names
        ):
            return provider_id
    return None


def _first_configured_environment_provider() -> str:
    """Choose a usable first-run provider without overriding saved intent."""
    for provider_id, environment_name in _PROVIDER_API_KEY_ENV.items():
        if os.getenv(environment_name, "").strip():
            return provider_id
    return "deepseek"


class ModelConfigError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_provider_id(provider_id: object) -> str:
    if not isinstance(provider_id, str):
        raise ModelConfigError("UNKNOWN_PROVIDER", "unsupported provider")
    normalized = provider_id.strip().casefold()
    if normalized not in SUPPORTED_PROVIDERS:
        raise ModelConfigError("UNKNOWN_PROVIDER", f"unsupported provider: {provider_id}")
    return normalized


def _normalize_model_name(model: object) -> str:
    if not isinstance(model, str):
        raise ModelConfigError("INVALID_MODEL", "model must be a string")
    normalized = model.strip()
    if not normalized:
        raise ModelConfigError("INVALID_MODEL", "model cannot be empty")
    if len(normalized) > _MAX_MODEL_NAME_LENGTH:
        raise ModelConfigError("INVALID_MODEL", f"model must be at most {_MAX_MODEL_NAME_LENGTH} characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ModelConfigError("INVALID_MODEL", "model must not contain control characters")
    return normalized


def _normalize_context_window(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ModelConfigError("INVALID_CONTEXT_WINDOW", "context window must be an integer")
    if not _MIN_CONTEXT_WINDOW <= value <= _MAX_CONTEXT_WINDOW:
        raise ModelConfigError(
            "INVALID_CONTEXT_WINDOW",
            f"context window must be between {_MIN_CONTEXT_WINDOW} and {_MAX_CONTEXT_WINDOW} tokens",
        )
    return value


def _private_endpoints_allowed() -> bool:
    return os.getenv("ARFORGE_ALLOW_PRIVATE_MODEL_ENDPOINTS", "").strip().casefold() in _TRUE_VALUES


def _endpoint_allowlist() -> frozenset[str]:
    raw = os.getenv("ARFORGE_MODEL_ENDPOINT_ALLOWLIST", "")
    hosts: set[str] = set()
    for item in raw.replace(";", ",").split(","):
        candidate = item.strip()
        if not candidate:
            continue
        parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
        host = (parsed.hostname or "").rstrip(".").casefold()
        if host:
            hosts.add(host)
    return frozenset(hosts)


def _host_is_allowlisted(host: str, allowlist: frozenset[str]) -> bool:
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in allowlist)


def _default_endpoint_hosts() -> frozenset[str]:
    return frozenset(
        host
        for definition in SUPPORTED_PROVIDERS.values()
        if (host := (urlparse(str(definition["base_url"])).hostname or "").casefold())
    )


def _ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # ``inet_aton`` catches legacy numeric forms such as ``127.1`` and
        # ``2130706433`` that URL parsers otherwise treat as host names.
        try:
            address = ipaddress.ip_address(socket.inet_aton(host))
        except (OSError, ValueError):
            return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def validate_model_endpoint(value: object, *, allow_empty: bool = True) -> str:
    """Validate a model endpoint before it reaches a provider SDK.

    Custom endpoints are an intentional operator feature, so named HTTPS
    gateways remain supported.  The validation fails closed for malformed URLs,
    credential-bearing URLs, and direct non-public IP targets.  Local loopback
    HTTP remains available for a local model server; private network targets
    require the explicit ``ARFORGE_ALLOW_PRIVATE_MODEL_ENDPOINTS=1`` opt-in.
    A deployment can further restrict named gateways with
    ``ARFORGE_MODEL_ENDPOINT_ALLOWLIST`` (comma-separated hosts).
    """
    if not isinstance(value, str):
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint must be a string")
    normalized = value.strip()
    if not normalized:
        if allow_empty:
            return ""
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint cannot be empty")
    if len(normalized) > _MAX_BASE_URL_LENGTH:
        raise ModelConfigError("INVALID_BASE_URL", f"model endpoint must be at most {_MAX_BASE_URL_LENGTH} characters")
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint must not contain whitespace or control characters")

    try:
        parsed = urlparse(normalized)
        _ = parsed.port
    except ValueError:
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint has an invalid port") from None
    host = (parsed.hostname or "").rstrip(".").casefold()
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not host:
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint must be an HTTP or HTTPS URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint must not contain credentials, query parameters, or fragments")

    address = _ip_literal(host)
    is_loopback = host == "localhost" or (address is not None and address.is_loopback)
    if parsed.scheme == "http" and not is_loopback:
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint must use HTTPS unless it targets local loopback")
    if address is not None and not address.is_global and not is_loopback and not _private_endpoints_allowed():
        raise ModelConfigError(
            "INVALID_BASE_URL",
            "private model endpoint requires ARFORGE_ALLOW_PRIVATE_MODEL_ENDPOINTS=1",
        )

    allowlist = _endpoint_allowlist()
    if allowlist and host not in _default_endpoint_hosts() and not _host_is_allowlisted(host, allowlist):
        raise ModelConfigError("INVALID_BASE_URL", "model endpoint host is not in ARFORGE_MODEL_ENDPOINT_ALLOWLIST")
    return normalized


def _derive_key(machine_id: str) -> bytes:
    """Derive a Fernet key from machine-specific material.

    Uses PBKDF2 with a machine-derived salt so keys are bound to this machine.
    Credential persistence fails closed when the encryption dependency is not
    available; base64 is not an acceptable replacement for encryption.
    """
    if not _CRYPTO_AVAILABLE:
        raise ModelConfigError(
            "CRYPTOGRAPHY_UNAVAILABLE",
            "encrypted credential storage requires the cryptography package",
        )

    import hashlib
    salt = hashlib.sha256(machine_id.encode()).digest()[:16]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480000,
    )
    return base64.urlsafe_b64encode(kdf.derive(machine_id.encode()))


def _machine_id() -> str:
    """Generate a stable machine identifier."""
    import platform
    import hashlib
    parts = [
        platform.node() or "unknown",
        platform.machine() or "unknown",
        str(Path.home()),
    ]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


def _encrypt(plaintext: str, key: bytes) -> str:
    if not _CRYPTO_AVAILABLE:
        raise ModelConfigError(
            "CRYPTOGRAPHY_UNAVAILABLE",
            "encrypted credential storage requires the cryptography package",
        )
    f = Fernet(key)
    return f.encrypt(plaintext.encode()).decode()


def _decrypt(ciphertext: str, key: bytes) -> str:
    if not _CRYPTO_AVAILABLE:
        return ""
    try:
        return Fernet(key).decrypt(ciphertext.encode()).decode()
    except Exception:  # corrupted or legacy insecure credential material
        return ""


class ModelConfigRuntime:
    """Secure model/provider configuration service."""

    def __init__(self, data_dir: Path | None = None):
        from arforge.paths import data_path
        self._dir = Path(data_dir) if data_dir else Path(data_path("config"))
        self._path = self._dir / "model_config.json"
        self._lock = threading.RLock()
        self._key: bytes | None = None
        # Temporary/embedded runtimes deliberately ignore the host project's
        # env-file ownership rules.  The singleton product runtime (no custom
        # data_dir) is the surface that merges the active workspace env.
        self._respect_loaded_environment = data_dir is None

    def _get_key(self) -> bytes:
        if self._key is None:
            self._key = _derive_key(_machine_id())
        return self._key

    def _load_raw(self) -> dict:
        if not self._path.exists():
            return self._default_document()
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
            return document if isinstance(document, dict) else self._default_document()
        except (json.JSONDecodeError, OSError, UnicodeError):
            return self._default_document()

    @staticmethod
    def _provider_entries(document: dict, *, create: bool = False) -> dict:
        providers = document.get("providers")
        if isinstance(providers, dict):
            return providers
        if create:
            providers = {}
            document["providers"] = providers
            return providers
        return {}

    def _save_raw(self, doc: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._path)

    def _default_document(self) -> dict:
        return {
            "version": MODEL_CONFIG_VERSION,
            "updated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            # A pristine profile should work with the credentials already present
            # in its process environment. Once saved, an explicit user selection
            # continues to win even if that provider is temporarily unconfigured.
            "active_provider": _first_configured_environment_provider(),
            "providers": {},
        }

    @contextmanager
    def _update_lock(self):
        lock_path = self._path.with_suffix(self._path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        import time as _time
        deadline = _time.monotonic() + 2.0
        descriptor = None
        while descriptor is None:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                if _time.monotonic() >= deadline:
                    raise ModelConfigError("CONFIG_BUSY", "another process is updating model config")
                _time.sleep(0.02)
        try:
            yield
        finally:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)

    # -- Public API --

    def list_providers(self) -> list[dict]:
        """List supported providers with their models and configuration status."""
        with self._lock:
            doc = self._load_raw()
            providers = self._provider_entries(doc)
        active_provider = self.get_active_provider()
        locked_provider = self._locked_active_provider()
        result = []
        for pid, info in SUPPORTED_PROVIDERS.items():
            stored = providers.get(pid, {})
            stored = stored if isinstance(stored, dict) else {}
            resolved = self.get_resolved_config(pid)
            from arforge.core.context import resolve_context_window

            context_window = resolve_context_window(
                str(resolved.get("model", info["default_model"])),
                resolved.get("context_window_tokens"),
            )
            custom_base_url = stored.get("base_url", "")
            try:
                custom_base_url = validate_model_endpoint(custom_base_url) if custom_base_url else ""
            except ModelConfigError:
                custom_base_url = ""
            result.append({
                "id": pid,
                "label": stored.get("display_label", info["label"]),
                "models": info["models"],
                "default_model": info["default_model"],
                "base_url": info["base_url"],
                "allow_custom_model": bool(info.get("allow_custom_model", False)),
                "configured": bool(resolved.get("resolved")),
                "key_source": resolved.get("key_source", "none"),
                "custom_base_url": custom_base_url,
                "resolved_base_url": resolved.get("base_url", "") or info["base_url"],
                "selected_model": resolved.get("model", info["default_model"]),
                "model_source": resolved.get("model_source", "default"),
                "model_locked": bool(resolved.get("model_locked", False)),
                "provider_locked": locked_provider is not None,
                "base_url_source": resolved.get("base_url_source", "default"),
                "base_url_locked": bool(resolved.get("base_url_locked", False)),
                "key_locked": bool(resolved.get("key_locked", False)),
                "context_window_tokens": context_window.tokens,
                "context_window_source": context_window.source,
                "is_active": active_provider == pid,
                "configuration_error": resolved.get("error", ""),
            })
        return result

    def _locked_active_provider(self) -> str | None:
        if self._respect_loaded_environment:
            declared_provider = _provider_declared_by_loaded_environment()
            if declared_provider is not None:
                return declared_provider
        environment_provider = os.getenv("ARFORGE_PROVIDER", "").strip().casefold()
        return environment_provider if environment_provider in SUPPORTED_PROVIDERS else None

    def get_active_provider(self) -> str:
        locked_provider = self._locked_active_provider()
        if locked_provider is not None:
            return locked_provider
        with self._lock:
            active_provider = self._load_raw().get("active_provider", "deepseek")
        try:
            return _normalize_provider_id(active_provider)
        except ModelConfigError:
            return _first_configured_environment_provider()

    def set_active_provider(self, provider_id: str) -> dict:
        provider_id = _normalize_provider_id(provider_id)
        locked_provider = self._locked_active_provider()
        if locked_provider is not None:
            if provider_id != locked_provider:
                raise ModelConfigError(
                    "CONFIG_LOCKED",
                    f"active provider is managed by environment configuration: {locked_provider}",
                )
            return {"active_provider": locked_provider, "locked": True}
        with self._lock, self._update_lock():
            doc = self._load_raw()
            doc["active_provider"] = provider_id
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"active_provider": provider_id}

    def set_api_key(self, provider_id: str, api_key: str) -> dict:
        """Store an encrypted API key for a provider."""
        provider_id = _normalize_provider_id(provider_id)
        if not isinstance(api_key, str) or not api_key.strip():
            raise ModelConfigError("INVALID_KEY", "API key cannot be empty")
        api_key = api_key.strip()
        if len(api_key) > _MAX_API_KEY_LENGTH:
            raise ModelConfigError("INVALID_KEY", f"API key must be at most {_MAX_API_KEY_LENGTH} characters")
        if any(ord(character) < 32 or ord(character) == 127 for character in api_key):
            raise ModelConfigError("INVALID_KEY", "API key must not contain control characters")
        if not _CRYPTO_AVAILABLE:
            raise ModelConfigError(
                "CRYPTOGRAPHY_UNAVAILABLE",
                "encrypted credential storage requires the cryptography package",
            )
        key = self._get_key()
        encrypted = _encrypt(api_key, key)
        with self._lock, self._update_lock():
            doc = self._load_raw()
            providers = self._provider_entries(doc, create=True)
            stored = providers.setdefault(provider_id, {})
            if not isinstance(stored, dict):
                stored = {}
                providers[provider_id] = stored
            stored["api_key_encrypted"] = encrypted
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "configured": True}

    def get_api_key(self, provider_id: str) -> str:
        """Retrieve decrypted API key. Never logged."""
        try:
            provider_id = _normalize_provider_id(provider_id)
        except ModelConfigError:
            return ""
        if not _CRYPTO_AVAILABLE:
            return ""
        key = self._get_key()
        with self._lock:
            doc = self._load_raw()
            providers = self._provider_entries(doc)
        stored = providers.get(provider_id, {})
        stored = stored if isinstance(stored, dict) else {}
        encrypted = stored.get("api_key_encrypted", "")
        if not isinstance(encrypted, str) or not encrypted:
            return ""
        return _decrypt(encrypted, key)

    def delete_api_key(self, provider_id: str) -> dict:
        """Remove stored API key for a provider."""
        provider_id = _normalize_provider_id(provider_id)
        with self._lock, self._update_lock():
            doc = self._load_raw()
            stored = self._provider_entries(doc, create=True).get(provider_id)
            if isinstance(stored, dict):
                stored.pop("api_key_encrypted", None)
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "configured": False}

    def reset_provider(self, provider_id: str) -> dict:
        """Remove every locally stored override for an explicit logout."""
        provider_id = _normalize_provider_id(provider_id)
        with self._lock, self._update_lock():
            doc = self._load_raw()
            self._provider_entries(doc, create=True).pop(provider_id, None)
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "configured": False, "reset": True}

    def set_display_label(self, provider_id: str, label: str) -> dict:
        """Persist a user-facing label for a compatible provider endpoint."""
        provider_id = _normalize_provider_id(provider_id)
        if not isinstance(label, str):
            raise ModelConfigError("INVALID_PROVIDER_LABEL", "provider label must be a string")
        label = label.strip()
        if not label or len(label) > _MAX_PROVIDER_LABEL_LENGTH:
            raise ModelConfigError(
                "INVALID_PROVIDER_LABEL",
                f"provider label must contain 1 to {_MAX_PROVIDER_LABEL_LENGTH} characters",
            )
        if any(ord(character) < 32 or ord(character) == 127 for character in label):
            raise ModelConfigError("INVALID_PROVIDER_LABEL", "provider label must not contain control characters")
        with self._lock, self._update_lock():
            doc = self._load_raw()
            providers = self._provider_entries(doc, create=True)
            stored = providers.setdefault(provider_id, {})
            if not isinstance(stored, dict):
                stored = {}
                providers[provider_id] = stored
            stored["display_label"] = label
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "label": label}

    def set_model(self, provider_id: str, model: str) -> dict:
        """Set preferred model for a provider."""
        provider_id = _normalize_provider_id(provider_id)
        model = _normalize_model_name(model)
        model_environment_name = _PROVIDER_MODEL_ENV[provider_id]
        if (
            self._respect_loaded_environment
            and model_environment_name in _loaded_environment_names()
            and os.getenv(model_environment_name, "").strip()
        ):
            raise ModelConfigError(
                "CONFIG_LOCKED",
                f"model is managed by environment configuration: {model_environment_name}",
            )
        valid_models = SUPPORTED_PROVIDERS[provider_id]["models"]
        if model not in valid_models and not SUPPORTED_PROVIDERS[provider_id].get("allow_custom_model", False):
            raise ModelConfigError("UNKNOWN_MODEL", f"unknown model '{model}' for {provider_id}. Available: {', '.join(valid_models)}")
        with self._lock, self._update_lock():
            doc = self._load_raw()
            providers = self._provider_entries(doc, create=True)
            stored = providers.setdefault(provider_id, {})
            if not isinstance(stored, dict):
                stored = {}
                providers[provider_id] = stored
            stored["model"] = model
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "model": model}

    def set_context_window(self, provider_id: str, context_window_tokens: int) -> dict:
        """Persist an explicit capacity for custom/compatible model endpoints."""
        provider_id = _normalize_provider_id(provider_id)
        context_window_tokens = _normalize_context_window(context_window_tokens)
        with self._lock, self._update_lock():
            doc = self._load_raw()
            providers = self._provider_entries(doc, create=True)
            stored = providers.setdefault(provider_id, {})
            if not isinstance(stored, dict):
                stored = {}
                providers[provider_id] = stored
            model = str(
                stored.get("model")
                or os.getenv({"deepseek": "DEEPSEEK_MODEL", "openai": "OPENAI_MODEL", "anthropic": "ANTHROPIC_MODEL"}[provider_id], "")
                or SUPPORTED_PROVIDERS[provider_id]["default_model"]
            )
            from arforge.core.context import resolve_context_window

            if resolve_context_window(model).source == "catalog":
                raise ModelConfigError(
                    "CONTEXT_WINDOW_MANAGED",
                    f"context window for '{model}' is managed by the model catalog",
                )
            windows = stored.get("context_windows")
            if not isinstance(windows, dict):
                windows = {}
                stored["context_windows"] = windows
            windows[model] = context_window_tokens
            stored.pop("context_window_tokens", None)
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "model": model, "context_window_tokens": context_window_tokens}

    def set_base_url(self, provider_id: str, base_url: str) -> dict:
        """Set custom base URL for a provider (e.g., proxy)."""
        provider_id = _normalize_provider_id(provider_id)
        base_url = validate_model_endpoint(base_url)
        base_url_environment_name = _PROVIDER_BASE_URL_ENV[provider_id]
        if (
            self._respect_loaded_environment
            and base_url_environment_name in _loaded_environment_names()
            and os.getenv(base_url_environment_name, "").strip()
        ):
            raise ModelConfigError(
                "CONFIG_LOCKED",
                f"model endpoint is managed by environment configuration: {base_url_environment_name}",
            )
        with self._lock, self._update_lock():
            doc = self._load_raw()
            providers = self._provider_entries(doc, create=True)
            stored = providers.setdefault(provider_id, {})
            if not isinstance(stored, dict):
                stored = {}
                providers[provider_id] = stored
            stored["base_url"] = base_url
            doc["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            self._save_raw(doc)
        return {"provider": provider_id, "base_url": base_url}

    def get_resolved_config(self, provider_id: str | None = None) -> dict:
        """Resolve full config for a provider, merging env vars with stored config."""
        requested_provider = provider_id if provider_id is not None else self.get_active_provider()
        try:
            pid = _normalize_provider_id(requested_provider)
        except ModelConfigError:
            return {"provider": "", "resolved": False, "error": "unsupported provider"}
        info = SUPPORTED_PROVIDERS[pid]

        # Env vars take precedence over stored config
        env_key = ""
        env_base_url = ""
        env_model = ""
        if pid == "deepseek":
            env_key = os.getenv("DEEPSEEK_API_KEY", "")
            env_base_url = os.getenv("DEEPSEEK_BASE_URL", "")
            env_model = os.getenv("DEEPSEEK_MODEL", "")
        elif pid == "openai":
            env_key = os.getenv("OPENAI_API_KEY", "")
            env_base_url = os.getenv("OPENAI_BASE_URL", "")
            env_model = os.getenv("OPENAI_MODEL", "")
        elif pid == "anthropic":
            env_key = os.getenv("ANTHROPIC_API_KEY", "")
            env_base_url = os.getenv("ANTHROPIC_BASE_URL", "")
            env_model = os.getenv("ANTHROPIC_MODEL", "")

        with self._lock:
            doc = self._load_raw()
            stored = self._provider_entries(doc).get(pid, {})
            stored = stored if isinstance(stored, dict) else {}
            stored_encrypted = stored.get("api_key_encrypted", "")
            stored_key = (
                _decrypt(stored_encrypted, self._get_key())
                if _CRYPTO_AVAILABLE and isinstance(stored_encrypted, str) and stored_encrypted
                else ""
            )

        api_key = env_key or stored_key
        base_url_environment_name = _PROVIDER_BASE_URL_ENV[pid]
        stored_model = stored.get("model", "")
        stored_windows = stored.get("context_windows")
        declared_names = (
            _loaded_environment_names()
            if self._respect_loaded_environment
            else frozenset()
        )
        model_env_name = _PROVIDER_MODEL_ENV[pid]
        model_locked = bool(env_model and model_env_name in declared_names)
        base_url_locked = bool(env_base_url and base_url_environment_name in declared_names)
        # An explicitly loaded Arforge env file is operator configuration and
        # wins over an old desktop preference. Inherited shell variables remain
        # first-run defaults so normal model switching still works elsewhere.
        raw_model = (
            env_model
            if model_locked
            else (stored_model or env_model or info["default_model"])
        )
        raw_base_url = (
            env_base_url
            if base_url_locked
            else (stored.get("base_url", "") or env_base_url or info["base_url"])
        )
        stored_context_window = (
            stored_windows.get(raw_model)
            if isinstance(stored_windows, dict)
            else stored.get("context_window_tokens")
        )
        key_source = "env" if env_key else ("stored" if stored_key else "none")
        base_url_source = (
            "env"
            if base_url_locked or (env_base_url and not stored.get("base_url", ""))
            else ("stored" if stored.get("base_url", "") else "default")
        )

        try:
            base_url = validate_model_endpoint(raw_base_url, allow_empty=False)
            model = _normalize_model_name(raw_model)
        except ModelConfigError as exc:
            return {
                "provider": pid,
                "resolved": False,
                "model": info["default_model"],
                "base_url": "",
                "key_source": key_source,
                "error": exc.message,
            }

        return {
            "provider": pid,
            "resolved": bool(api_key),
            "model": model,
            "base_url": base_url,
            "key_source": key_source,
            "key_locked": bool(env_key),
            "base_url_source": base_url_source,
            "base_url_locked": base_url_locked,
            "model_source": "env" if model_locked else ("stored" if stored_model else "default"),
            "model_locked": model_locked,
            "context_window_tokens": (
                stored_context_window
                if isinstance(stored_context_window, int) and not isinstance(stored_context_window, bool)
                else None
            ),
        }

    def adapter_identity(self) -> tuple[str, str, str, str, int]:
        """Return a secret-safe identity for the active adapter configuration.

        Desktop sessions keep their agent alive across turns.  This identity lets
        the agent notice settings changes without exposing the credential itself
        or requiring the desktop process to restart.
        """
        resolved = self.get_resolved_config()
        provider = str(resolved.get("provider", ""))
        environment_key = {
            "deepseek": "DEEPSEEK_API_KEY",
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }.get(provider, "")
        api_key = (os.getenv(environment_key, "") if environment_key else "") or self.get_api_key(provider)
        credential_fingerprint = hashlib.sha256(api_key.encode("utf-8")).hexdigest() if api_key else ""
        return (
            provider,
            str(resolved.get("model", "")),
            str(resolved.get("base_url", "")),
            credential_fingerprint,
            int(resolved.get("context_window_tokens") or 0),
        )

    def create_adapter(self, provider_id: str | None = None):
        """Build an adapter from a secure provider configuration.

        Credentials are resolved only inside this process and are never returned
        from Bridge methods.  Supplying ``provider_id`` supports explicit API
        selection without bypassing encrypted local credentials.
        """
        from arforge.models.model_factory import create_model_adapter

        if provider_id is not None:
            provider_id = _normalize_provider_id(provider_id)
        resolved = self.get_resolved_config(provider_id)
        provider = resolved.get("provider")
        if provider not in SUPPORTED_PROVIDERS:
            raise ModelConfigError("INVALID_PROVIDER_CONFIG", "provider configuration is invalid")
        if resolved.get("error"):
            raise ModelConfigError("INVALID_PROVIDER_CONFIG", str(resolved["error"]))
        environment_key = {
            "deepseek": "DEEPSEEK_API_KEY",
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }[provider]
        adapter = create_model_adapter(
            provider,
            api_key=os.getenv(environment_key) or self.get_api_key(provider) or None,
            base_url=resolved.get("base_url") or None,
            model=resolved.get("model") or None,
        )
        from arforge.core.context import resolve_context_window

        try:
            adapter.context_window_tokens = resolve_context_window(
                str(resolved.get("model", "")),
                resolved.get("context_window_tokens"),
            ).tokens
        except AttributeError:
            # Minimal third-party adapters may use slots or opaque proxy objects.
            # Context resolution still remains available through runtime config.
            pass
        return adapter

    def create_active_adapter(self):
        """Build an adapter for the currently active secure provider configuration."""
        return self.create_adapter()


# Singleton
_runtime: ModelConfigRuntime | None = None
_lock = threading.Lock()


def get_model_config() -> ModelConfigRuntime:
    global _runtime
    if _runtime is None:
        with _lock:
            if _runtime is None:
                _runtime = ModelConfigRuntime()
    return _runtime
