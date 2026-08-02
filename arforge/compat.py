"""Compatibility helpers for modules still awaiting deep reconstruction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class PlaceholderResult:
    success: bool = True
    message: str = "This module has been converted from bytecode loader to source skeleton."
    data: Any = None

    def to_dict(self) -> dict:
        return {"success": self.success, "message": self.message, "data": self.data}


class PlaceholderObject:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def to_dict(self) -> dict:
        return {"args": self.args, "kwargs": self.kwargs}

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return True

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}()"


def placeholder_function(name: str):
    def _fn(*args, **kwargs):
        if name.startswith("list_") or name.startswith("search_") or name.startswith("query_"):
            return []
        if name.startswith("is_") or name.startswith("has_"):
            return False
        if name.startswith("get_") or name.startswith("build_") or name.startswith("show_") or name.startswith("format_"):
            return ""
        if name.startswith("init_") or name.startswith("index_") or name.startswith("refresh_") or name.startswith("rebuild_"):
            return {"success": True, "message": f"{name} skeleton executed"}
        return PlaceholderResult(message=f"{name} skeleton executed").to_dict()

    _fn.__name__ = name
    _fn.__doc__ = f"Compatibility skeleton for {name}."
    return _fn


def placeholder_class(name: str):
    return type(name, (PlaceholderObject,), {"__module__": __name__})


def module_getattr(name: str):
    if name[:1].isupper():
        return placeholder_class(name)
    return placeholder_function(name)
