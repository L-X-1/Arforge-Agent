"""Security guard layer — prompt injection detection, log sanitisation, rate limiting.

Protects the agent pipeline from:
- Prompt injection / jailbreak attempts
- API key leakage in logs
- Excessive model calls (basic rate limiting)
- Sensitive data exposure in error messages
"""

from __future__ import annotations

import re
import time
from pathlib import Path

# ====================================================================
# Prompt injection detection
# ====================================================================

# Patterns that indicate injection/jailbreak attempts
INJECTION_PATTERNS = [
    # System prompt override
    r"(?i)(ignore|forget|disregard)\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|rules?)",
    r"(?i)you\s+are\s+now\s+(DAN|jailbroken|unrestricted|free)",
    r"(?i)pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|another)",
    r"(?i)system\s*:\s*you\s+are",
    # Token/prompt leaking
    r"(?i)(print|show|reveal|display|output|dump)\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?)",
    r"(?i)(what|tell\s+me)\s+(is\s+)?your\s+(system\s+)?(prompt|instructions?)",
    # Role manipulation
    r"(?i)<\|im_start\|>",
    r"(?i)<\|system\|>",
    r"(?i)You are ChatGPT",
    r"(?i)You are (Assistant|ChatGPT|Gemini|Copilot)",  # generic role pattern
    # Code injection via prompt
    r"(?i)```\s*system\s*\n",
    r"(?i)\[INST\].*\[/INST\]",
    # File system escape
    r"(?i)(read|write|delete|remove)\s+(all\s+)?files?\s+(in|from|on)\s+(my\s+)?(computer|system|machine)",
    r"(?i)rm\s+-rf\s+/",
    # Social engineering
    r"(?i)(your\s+developer|your\s+creator)\s+(told|said|instructed)",
]


def detect_injection(user_input: str) -> dict:
    """Scan user input for prompt injection patterns.

    Returns a dict with detection results. Does NOT block — just flags for review.
    """
    matches = []
    for i, pattern in enumerate(INJECTION_PATTERNS):
        m = re.search(pattern, user_input)
        if m:
            matches.append({"pattern_index": i, "matched": m.group(0)[:100], "position": m.start()})

    severity = "none"
    if len(matches) >= 3:
        severity = "high"
    elif len(matches) >= 1:
        severity = "medium"

    return {
        "clean": len(matches) == 0,
        "matches": matches,
        "count": len(matches),
        "severity": severity,
    }


INJECTION_WARNING = """
[Security Notice] Your input matched potential prompt injection patterns.
The request was blocked before memory, tools, or model processing.
If this was a legitimate request, please rephrase your question.
""".strip()


# ====================================================================
# Log sanitisation — prevent API key and PII leakage
# ====================================================================


def mask_api_key(text: str) -> str:
    """Mask anything that looks like an API key."""
    # sk-* pattern (OpenAI/DeepSeek style) — sk-xxxx...xxxx
    text = re.sub(r"(sk-[a-zA-Z0-9]{2})[a-zA-Z0-9][a-zA-Z0-9\-]+([a-zA-Z0-9]{3})", r"\1...\2", text)
    # Generic key=value patterns that look sensitive
    text = re.sub(r"(api[_-]?key\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"(secret\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"(token\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"(?i)\b(postgresql|postgres|mysql)://([^\s:/]+):([^@\s]+)@",
        r"\1://[REDACTED]:[REDACTED]@",
        text,
    )
    # Common source-code credential forms.  A PDO password is positional rather
    # than labelled, so generic ``password=`` matching cannot see it.
    text = re.sub(
        r"(?is)(new\s+PDO\s*\(\s*.*?,\s*['\"][^'\"]*['\"]\s*,\s*)(['\"])[^'\"]+\2",
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]{match.group(2)}",
        text,
    )
    # The same source can be nested inside JSON/tool arguments where quotes
    # carry one or more escaping backslashes.
    text = re.sub(
        r"(?is)(new\s+PDO\s*\(\s*.*?,\s*\\*['\"][^'\"]*\\*['\"]\s*,\s*\\*['\"])[^'\"]+(\\*['\"])",
        r"\1[REDACTED]\2",
        text,
    )
    text = re.sub(
        r"(?i)((?:['\"])?(?:db_)?(?:password|passwd|pwd)(?:['\"])?\s*(?:=>|:|=)\s*)(['\"])[^'\"]+\2",
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]{match.group(2)}",
        text,
    )
    text = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED_AWS_KEY]", text)
    return text


def sanitize_log_message(message: str) -> str:
    """Remove sensitive data from log messages."""
    return mask_api_key(str(message))


def sanitize_sensitive_data(value):
    """Recursively redact secrets in structured log context."""
    sensitive_names = {"password", "passwd", "secret", "token", "api_key", "apikey", "authorization"}
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            cleaned[key] = "[REDACTED]" if normalized in sensitive_names else sanitize_sensitive_data(item)
        return cleaned
    if isinstance(value, list):
        return [sanitize_sensitive_data(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_sensitive_data(item) for item in value)
    if isinstance(value, str):
        return sanitize_log_message(value)
    return value


def sanitize_for_storage(value):
    """Recursively remove complete credential values before durable storage."""
    sensitive_names = {"password", "passwd", "secret", "token", "api_key", "apikey", "authorization"}
    if isinstance(value, dict):
        return {
            key: "[REDACTED_SECRET]"
            if str(key).lower().replace("-", "_") in sensitive_names
            else sanitize_for_storage(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_for_storage(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_for_storage(item) for item in value)
    if not isinstance(value, str):
        return value
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}", "[REDACTED_SECRET]", value)
    text = re.sub(r"\bghp_[A-Za-z0-9]{36}\b", "[REDACTED_SECRET]", text)
    text = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED_SECRET]", text)
    text = re.sub(
        r"(?i)\b(postgresql|postgres|mysql)://([^\s:/]+):([^@\s]+)@",
        r"\1://[REDACTED]:[REDACTED]@",
        text,
    )
    text = re.sub(
        r"(?i)\b(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED_SECRET]",
        text,
    )
    # ``mask_api_key`` also covers positional/source-code credentials, but its
    # log-safe marker is intentionally generic. Durable storage keeps the
    # stronger, machine-detectable marker required by privacy export/audit.
    return mask_api_key(text).replace("[REDACTED]", "[REDACTED_SECRET]")


# ====================================================================
# Rate limiting — basic protection against abuse
# ====================================================================


class RateLimiter:
    """Simple token-bucket rate limiter for model calls."""

    def __init__(self, max_calls: int = 60, per_seconds: int = 60):
        self.max_calls = max_calls
        self.per_seconds = per_seconds
        self._calls: list[float] = []

    def acquire(self) -> bool:
        """Try to acquire a call slot. Returns True if allowed."""
        now = time.time()
        cutoff = now - self.per_seconds
        self._calls = [t for t in self._calls if t > cutoff]
        if len(self._calls) >= self.max_calls:
            return False
        self._calls.append(now)
        return True

    @property
    def remaining(self) -> int:
        cutoff = time.time() - self.per_seconds
        self._calls = [t for t in self._calls if t > cutoff]
        return max(0, self.max_calls - len(self._calls))


_RATE_LIMITER: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    global _RATE_LIMITER
    if _RATE_LIMITER is None:
        _RATE_LIMITER = RateLimiter()
    return _RATE_LIMITER


# ====================================================================
# Structured error logging
# ====================================================================


def log_structured_error(error_type: str, message: str, recoverable: bool = True, context: dict | None = None) -> None:
    """Log a structured error with classification and recovery hint."""
    from arforge.logger import log_error

    entry = {
        "type": error_type,
        "message": sanitize_log_message(message),
        "recoverable": recoverable,
        "context": sanitize_sensitive_data(context or {}),
    }
    import json

    log_error(json.dumps(entry, ensure_ascii=False))


def classify_exception(exc: Exception) -> dict:
    """Classify an exception into a structured error record."""
    exc_type = type(exc).__name__
    msg = str(exc)[:500]

    # Known error categories — auth before input_validation
    if isinstance(exc, (ConnectionError, TimeoutError)) or "connect" in msg.lower():
        category = "network"
        recoverable = True
    elif isinstance(exc, PermissionError) or "permission" in msg.lower():
        category = "permission"
        recoverable = False
    elif "api" in msg.lower() or "auth" in msg.lower() or "unauthorized" in msg.lower():
        category = "auth"
        recoverable = True
    elif "key" in msg.lower() and ("invalid" in msg.lower() or "missing" in msg.lower() or "wrong" in msg.lower()):
        category = "auth"
        recoverable = True
    elif isinstance(exc, ValueError) or "invalid" in msg.lower():
        category = "input_validation"
        recoverable = True
    elif isinstance(exc, (KeyError, AttributeError, NameError, TypeError)):
        category = "code_error"
        recoverable = False
    elif "rate" in msg.lower() or "limit" in msg.lower():
        category = "rate_limit"
        recoverable = True
    else:
        category = "unknown"
        recoverable = True

    return {"type": exc_type, "category": category, "message": sanitize_log_message(msg), "recoverable": recoverable}


# ====================================================================
# Privacy consent tracking
# ====================================================================


def _privacy_home() -> Path:
    from arforge.paths import get_arforge_home

    return get_arforge_home()


def record_privacy_consent() -> dict:
    """Record that the user has been informed about model API calls."""
    consent_file = _privacy_home() / "privacy_consent.json"
    import json

    consent = {
        "consented_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "understands_api_calls": True,
        "understands_local_storage": True,
        "data_retention": "local only, ~/.arforge/",
    }
    consent_file.parent.mkdir(parents=True, exist_ok=True)
    consent_file.write_text(json.dumps(consent, ensure_ascii=False, indent=2), encoding="utf-8")
    return consent


def has_privacy_consent() -> bool:
    """Check if the user has seen the privacy notice."""
    return (_privacy_home() / "privacy_consent.json").exists()
