import pytest

from web_platform.domain import normalize_title


def test_normalize_title():
    assert normalize_title("  project depth  ") == "project depth"
    with pytest.raises(ValueError, match="required"):
        normalize_title("   ")
