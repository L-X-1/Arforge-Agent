"""Compatibility import for the retired duplicate ``code_symbols`` owner.

The canonical Python compatibility implementation lives in
:mod:`arforge.tools.code_tools`; the TypeScript product exposes the equivalent
symbol operations through its unified LSP tool.  This module remains importable
for old integrations and migration fixtures, but deliberately does not register
a second ``code_symbols`` definition.  Importing it eagerly imports the
canonical compatibility module so callers that historically imported
``arforge.tools.symbol_tools`` still find the same registered tool.
"""

from __future__ import annotations

from arforge.tools.code_tools import code_symbols

__all__ = ["code_symbols"]
