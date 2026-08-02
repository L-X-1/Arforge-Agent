"""Compatibility wrapper for the product doctor."""

from __future__ import annotations

from arforge.product.doctor import doctor_main, format_report, run_checks


__all__ = ["doctor_main", "format_report", "run_checks"]


if __name__ == "__main__":
    raise SystemExit(doctor_main())
