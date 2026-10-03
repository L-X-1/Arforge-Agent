"""Stable embedding facade for the unified TypeScript Arforge CLI.

Use this module when a Python host needs to launch or capture a CLI request
during the migration window.  Every symbol is a direct alias to
``arforge.cli_bridge``; this module contains no parser, handler, state store,
model call, tool executor or Python fallback of its own.  The historical
``arforge.cli`` module remains importable for explicitly frozen migration
tests, but new integrations should depend on this facade instead.
"""

from __future__ import annotations

from arforge.cli_bridge import (
    CliInvocationResult,
    UnifiedCliUnavailable,
    build_command,
    invoke,
    main,
    resolve_unified_cli,
    run,
)

__all__ = [
    "CliInvocationResult",
    "UnifiedCliUnavailable",
    "build_command",
    "invoke",
    "main",
    "resolve_unified_cli",
    "run",
]
