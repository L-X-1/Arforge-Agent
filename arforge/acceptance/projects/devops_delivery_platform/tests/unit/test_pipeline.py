from pathlib import Path

from pipeline import validate_workflow


def test_delivery_workflow_is_pinned_and_least_privilege():
    assert validate_workflow(Path(".github/workflows/delivery.yml")) == []
