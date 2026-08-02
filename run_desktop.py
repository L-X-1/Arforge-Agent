"""PyCharm-friendly launcher for the Arforge Windows Desktop application."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence


PROJECT_ROOT = Path(__file__).resolve().parent
DESKTOP_SCRIPT = PROJECT_ROOT / "scripts" / "run_desktop.ps1"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Arforge Agent Desktop")
    parser.add_argument("--mode", choices=("Dev",), default="Dev", help="Unified Electron development runtime")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Resolve the launcher without starting the application",
    )
    return parser


def run(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    powershell = shutil.which("powershell") or shutil.which("powershell.exe")
    if powershell is None:
        print("Windows PowerShell was not found in PATH.", file=sys.stderr)
        return 1
    if not DESKTOP_SCRIPT.is_file():
        print(f"Desktop launcher was not found: {DESKTOP_SCRIPT}", file=sys.stderr)
        return 1

    command = [
        powershell,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(DESKTOP_SCRIPT),
        "-Mode",
        args.mode,
        "-Workspace",
        str(PROJECT_ROOT),
    ]
    if args.validate_only:
        command.append("-ValidateOnly")
    process = subprocess.Popen(command, cwd=PROJECT_ROOT)
    try:
        return process.wait()
    except KeyboardInterrupt:
        try:
            process.terminate()
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        except OSError:
            pass
        print("\nDesktop launcher stopped by user.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(run())
