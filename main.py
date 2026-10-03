import os
import sys

if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Keep the repository-root launcher aligned with ``python -m arforge`` and the
# installed console script: all user-facing execution enters the canonical
# TypeScript/Bun CLI through the compatibility bridge.  ``arforge.cli`` remains
# importable only for migration-era library callers and tests.
from arforge.cli_bridge import main


if __name__ == "__main__":
    raise SystemExit(main())
