"""Database initializer registry."""

from __future__ import annotations


_REGISTRY: dict[str, callable] = {}


def register_db_init(name: str, fn):
    _REGISTRY[name] = fn
    return fn


def run_db_inits() -> dict:
    results = {}
    for name, fn in _REGISTRY.items():
        try:
            fn()
            results[name] = "ok"
        except Exception as exc:
            results[name] = str(exc)
    return results


def list_db_inits() -> list[str]:
    return sorted(_REGISTRY)
