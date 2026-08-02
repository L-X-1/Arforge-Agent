from __future__ import annotations

import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_runtime_sources_do_not_contain_reference_brand_markers() -> None:
    """Use the product-aware audit so legitimate provider integrations remain valid."""
    bun = PROJECT_ROOT / ".tools" / "bun-1.3.14" / "bun.exe"
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
    assert "0 hits in 0 finding files" in result.stdout
