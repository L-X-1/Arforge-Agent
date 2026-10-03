from __future__ import annotations

import os
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_brand_audit_has_no_unapproved_regressions() -> None:
    """Use the product-aware audit and enforce the checked-in baseline."""
    bun = PROJECT_ROOT / ".tools" / "bun-1.3.14" / ("bun.exe" if os.name == "nt" else "bun")
    result = subprocess.run(
        [str(bun), "run", "brand:check"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Brand audit failed:" not in result.stdout + result.stderr
