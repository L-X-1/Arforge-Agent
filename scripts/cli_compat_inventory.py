"""Compatibility launcher for the TypeScript-owned CLI inventory.

The migration inventory has one implementation in ``script/``. This Python
entry point is retained only for existing automation and delegates without
importing product modules, parsing Python, or writing repository state.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _root_from_argument(argv: list[str]) -> Path:
    try:
        index = argv.index("--root")
    except ValueError:
        return Path(__file__).resolve().parents[1]
    if index + 1 >= len(argv):
        raise ValueError("--root requires a repository path")
    return Path(argv[index + 1]).expanduser().resolve()


def _bun_command(root: Path) -> str:
    configured = os.environ.get("ARFORGE_BUN")
    candidates = [
        configured,
        str(root / ".tools" / "bun-1.3.14" / "bun.exe"),
        str(root / ".tools" / "bun-1.3.14" / "bun"),
        shutil.which("bun"),
    ]
    for candidate in candidates:
        if candidate and (Path(candidate).is_file() or shutil.which(candidate)):
            return candidate
    raise FileNotFoundError("bun executable not found; set ARFORGE_BUN or install bun on PATH")


def main(argv: list[str] | None = None) -> int:
    forwarded = list(sys.argv[1:] if argv is None else argv)
    try:
        root = _root_from_argument(forwarded)
        if "--root" in forwarded:
            root_index = forwarded.index("--root")
            forwarded[root_index + 1] = str(root)
        command = [
            _bun_command(root),
            "run",
            str(root / "script" / "arforge-cli-compat-inventory.ts"),
            *forwarded,
        ]
        completed = subprocess.run(command, cwd=root, check=False)
    except (FileNotFoundError, OSError, ValueError) as exc:
        print(f"cli compatibility inventory failed: {exc}", file=sys.stderr)
        return 2
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
