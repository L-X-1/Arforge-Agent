"""Run transport-level provider fault injection and retain redacted evidence."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from arforge.core.staging_validation import run_provider_smoke
from arforge.product.model_config_runtime import get_model_config


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    runtime = get_model_config()
    resolved = runtime.get_resolved_config()
    if not resolved.get("resolved"):
        print(
            f"ERROR: {resolved.get('error') or 'model configuration unresolved'}",
            file=sys.stderr,
        )
        return 2
    try:
        probe = run_provider_smoke(runtime.create_active_adapter)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"ERROR: provider fault probe failed: {exc}", file=sys.stderr)
        return 2
    payload = {
        "schema_version": 1,
        "provider": str(resolved.get("provider") or ""),
        "model": str(resolved.get("model") or ""),
        **probe,
    }
    target = Path(args.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "failure_recovery": payload["failure_recovery"],
                "output": str(target),
            },
            ensure_ascii=False,
        )
    )
    return 0 if payload["failure_recovery"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
